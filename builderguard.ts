// The builder guard: a Claude Code PreToolUse hook on Bash in every build
// worktree (host prepareWorktree writes <worktree>/.claude/settings.local.json
// with builderSettings). bb has no tool-call hook and no spawn-level sandbox,
// so Claude Code's own settings are the enforcement point.
//
// checkCommand refuses what a builder must never run: rm -r outside its
// worktree, any git push, prod DB and infra CLIs, reading the main checkout's
// env files, and e2e runs (they hit the production DB from .env). It follows
// npm/pnpm/yarn scripts through package.json so a script can't hide a
// destructive body behind `npm run` (Claude Code #88462); code inside a .ts or
// .js file still can, which is why the OS sandbox is the real boundary and
// this is the second line. Anything it can't parse is refused (fail closed).
//
// node runs this file directly (type stripping), so it has no relative
// imports and only erasable TypeScript; the main block at the end imports
// node:* dynamically and runs only as the hook.

export interface GuardContext {
  /** Where the command runs. */
  cwd: string;
  /** The build worktree: <repo>/.claude/worktrees/<slug>. */
  worktree: string;
  /** package.json `scripts` for cwd. */
  scripts: Record<string, string>;
  /** The scripts npm would use in dir (nearest package.json), or null when unknown. */
  scriptsAt?: (dir: string) => Record<string, string> | null;
}

export type Verdict = { reason: string } | null;

const SCRIPT_DEPTH = 5;
const E2E_REASON = "e2e runs against the production DB from .env; CI runs e2e on the PR preview, not you.";
const PUSH_REASON =
  "git push is refused (force-push included): builders never push; commit, and The Orchestrator pushes at hand-off.";

// ------------------------------------------------------------------ parsing

interface Word {
  text: string;
  /** Holds $VAR, ${...}, $(...) or `...`: the value isn't known until run time. */
  dynamic: boolean;
  /** Holds an unquoted glob character. */
  glob: boolean;
  /** Starts with an unquoted ~. */
  tilde: boolean;
  /** Some part was quoted (a quoted heredoc delimiter doesn't expand). */
  quoted?: boolean;
}

interface Command {
  words: Word[];
  redirects: Word[];
}

class ParseError extends Error {}

const OPERATOR = new Set([";", "&", "|", "\n", "(", ")"]);

/** Every simple command in src, substitutions and heredoc expansions included, in order. */
export function parseCommands(src: string): Command[] {
  const out: Command[] = [];
  const end = parseList(src, 0, null, out);
  if (end !== src.length) throw new ParseError("trailing input");
  return out;
}

function parseList(src: string, start: number, terminator: ")" | "`" | null, out: Command[]): number {
  let i = start;
  let words: Word[] = [];
  let redirects: Word[] = [];
  let word: Word | null = null;
  let redirectNext = false;
  let heredocs: Array<{ delimiter: string; strip: boolean; expand: boolean }> = [];
  let pendingHeredocDelimiter: { strip: boolean } | null = null;
  let parens = 0;

  const w = (): Word => {
    if (word === null) word = { text: "", dynamic: false, glob: false, tilde: false };
    return word;
  };
  const endWord = () => {
    if (word === null) return;
    const done: Word = word;
    word = null;
    if (pendingHeredocDelimiter !== null) {
      heredocs.push({ delimiter: done.text, strip: pendingHeredocDelimiter.strip, expand: !done.quoted });
      pendingHeredocDelimiter = null;
      return;
    }
    if (redirectNext) {
      redirects.push(done);
      redirectNext = false;
    } else {
      words.push(done);
    }
  };
  const endCommand = () => {
    endWord();
    if (redirectNext || pendingHeredocDelimiter !== null) throw new ParseError("redirect without a target");
    if (words.length > 0 || redirects.length > 0) out.push({ words, redirects });
    words = [];
    redirects = [];
  };
  const readHeredocs = () => {
    for (const doc of heredocs) {
      let lineStart = i;
      for (;;) {
        if (lineStart >= src.length) throw new ParseError(`heredoc ${doc.delimiter} never ends`);
        let lineEnd = src.indexOf("\n", lineStart);
        if (lineEnd === -1) lineEnd = src.length;
        const line = src.slice(lineStart, lineEnd);
        if ((doc.strip ? line.replace(/^\t+/, "") : line) === doc.delimiter) {
          if (doc.expand) scanExpansions(src.slice(i, lineStart), out);
          i = Math.min(lineEnd + 1, src.length);
          break;
        }
        lineStart = lineEnd + 1;
      }
    }
    heredocs = [];
  };

  while (i < src.length) {
    const c = src[i];
    if (c === terminator && parens === 0) {
      endCommand();
      if (heredocs.length > 0) throw new ParseError("heredoc inside a substitution never ends");
      if (pendingHeredocDelimiter !== null) throw new ParseError("heredoc without a delimiter");
      return i + 1;
    }
    if (c === " " || c === "\t") {
      endWord();
      i += 1;
      continue;
    }
    if (c === "\\") {
      if (src[i + 1] === "\n") {
        i += 2;
        continue;
      }
      if (i + 1 >= src.length) throw new ParseError("trailing backslash");
      w().text += src[i + 1];
      i += 2;
      continue;
    }
    if (c === "#" && word === null) {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "'") {
      const close = src.indexOf("'", i + 1);
      if (close === -1) throw new ParseError("unterminated '");
      const cur = w();
      cur.text += src.slice(i + 1, close);
      cur.quoted = true;
      i = close + 1;
      continue;
    }
    if (c === '"') {
      const cur = w();
      cur.quoted = true;
      i = readDouble(src, i + 1, cur, out, true);
      continue;
    }
    if (c === "$" || c === "`") {
      i = readDollar(src, i, w(), out);
      continue;
    }
    if ((c === "<" || c === ">") && src[i + 1] === "(") {
      // Process substitution.
      endWord();
      const sub: Command[] = [];
      i = parseList(src, i + 2, ")", sub);
      out.push(...sub);
      words.push({ text: "/dev/fd/0", dynamic: true, glob: false, tilde: false });
      continue;
    }
    if (c === "<" && src.startsWith("<<<", i)) {
      endWord();
      redirectNext = true;
      i += 3;
      continue;
    }
    if (c === "<" && src[i + 1] === "<") {
      endWord();
      const strip = src[i + 2] === "-";
      pendingHeredocDelimiter = { strip };
      i += strip ? 3 : 2;
      continue;
    }
    if (c === ">" || c === "<" || (c === "&" && src[i + 1] === ">")) {
      // A leading fd number (2>) belongs to the redirect, not the command.
      const before = word as Word | null;
      if (before !== null && /^\d+$/.test(before.text) && !before.quoted) word = null;
      endWord();
      i += c === "&" ? 2 : 1;
      while (src[i] === ">" || src[i] === "|") i += 1;
      if (src[i] === "&") {
        i += 1;
        // >&2, >&-: a fd, not a file.
        const fd = /^(\d+|-)/.exec(src.slice(i));
        if (fd !== null) {
          i += fd[0].length;
          continue;
        }
      }
      redirectNext = true;
      continue;
    }
    if (OPERATOR.has(c)) {
      if (c === "(") parens += 1;
      if (c === ")") {
        if (parens === 0) throw new ParseError("unexpected )");
        parens -= 1;
      }
      endCommand();
      i += 1;
      if (c === "\n") readHeredocs();
      continue;
    }
    const cur = w();
    if (c === "~" && cur.text === "" && !cur.quoted) cur.tilde = true;
    if (c === "*" || c === "?" || c === "[") cur.glob = true;
    cur.text += c;
    i += 1;
  }
  if (terminator !== null) throw new ParseError(`unterminated ${terminator === ")" ? "$(" : "`"}`);
  endCommand();
  if (parens > 0) throw new ParseError("unterminated (");
  if (heredocs.length > 0) throw new ParseError("heredoc never ends");
  return i;
}

/** Reads "..." content from start (just after the quote); returns the index after the closing quote. */
function readDouble(src: string, start: number, word: Word, out: Command[], closing: boolean): number {
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (closing && c === '"') return i + 1;
    if (c === "\\" && i + 1 < src.length) {
      const next = src[i + 1];
      if (next === "\n") {
        i += 2;
        continue;
      }
      word.text += '"\\$`'.includes(next) ? next : c + next;
      i += 2;
      continue;
    }
    if (c === "$" || c === "`") {
      i = readDollar(src, i, word, out);
      continue;
    }
    word.text += c;
    i += 1;
  }
  if (closing) throw new ParseError('unterminated "');
  return i;
}

/** $(...), `...`, ${...}, $VAR, $'...': marks the word dynamic and parses any command inside. */
function readDollar(src: string, start: number, word: Word, out: Command[]): number {
  const c = src[start];
  if (c === "`") {
    word.dynamic = true;
    word.text += "$(...)";
    return parseList(src, start + 1, "`", out);
  }
  const next = src[start + 1];
  if (next === "(") {
    word.dynamic = true;
    word.text += "$(...)";
    return parseList(src, start + 2, ")", out);
  }
  if (next === "{") {
    const close = src.indexOf("}", start + 2);
    if (close === -1) throw new ParseError("unterminated ${");
    word.dynamic = true;
    word.text += src.slice(start, close + 1);
    return close + 1;
  }
  if (next === "'") {
    // ANSI-C quoting: escapes can spell anything, so its value counts as unknown.
    const close = src.indexOf("'", start + 2);
    if (close === -1) throw new ParseError("unterminated $'");
    word.dynamic = true;
    word.text += src.slice(start + 2, close);
    return close + 1;
  }
  const name = /^([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(src.slice(start + 1));
  if (name === null) {
    word.text += "$";
    return start + 1;
  }
  word.dynamic = true;
  word.text += "$" + name[0];
  return start + 1 + name[0].length;
}

/** An unquoted heredoc body: only its $(...) and backticks run. */
function scanExpansions(body: string, out: Command[]): void {
  readDouble(body, 0, { text: "", dynamic: false, glob: false, tilde: false }, out, false);
}

// -------------------------------------------------------------------- paths

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.join("/");
}

function resolvePath(base: string, path: string): string {
  return normalize(path.startsWith("/") ? path : `${base}/${path}`);
}

function inside(path: string, root: string): boolean {
  const r = normalize(root);
  return path === r || path.startsWith(r === "/" ? "/" : r + "/");
}

function strictlyInside(path: string, root: string): boolean {
  return inside(path, root) && path !== normalize(root);
}

function globRegex(segment: string): RegExp {
  let out = "";
  for (let i = 0; i < segment.length; i += 1) {
    const c = segment[i];
    if (c === "*") out += ".*";
    else if (c === "?") out += ".";
    else if (c === "[") {
      const close = segment.indexOf("]", i + 1);
      if (close === -1) out += "\\[";
      else {
        out += "[" + segment.slice(i + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\") + "]";
        i = close;
      }
    } else out += c.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** A glob segment that could match `.` or `..` (old bash `.*`) climbs. */
function globClimbs(text: string): boolean {
  return text
    .split("/")
    .some((segment) => /[*?[]/.test(segment) && (globRegex(segment).test("..") || globRegex(segment).test(".")));
}

function globMatchesPath(pattern: string, path: string): boolean {
  const a = pattern.split("/");
  const b = path.split("/");
  return a.length === b.length && a.every((segment, i) => globRegex(segment).test(b[i]));
}

/** The repo that owns a worktree at <repo>/.claude/worktrees/<slug>, or null. */
export function repoOf(worktree: string): string | null {
  const m = /^(.*)\/\.claude\/worktrees\/[^/]+\/?$/.exec(normalize(worktree));
  return m === null ? null : m[1] === "" ? "/" : m[1];
}

// ------------------------------------------------------------------ checking

interface State {
  ctx: GuardContext;
  /** Every directory the command may be running in (cd adds; unknown = null). */
  cwds: Array<string | null>;
  depth: number;
}

export function checkCommand(command: string, ctx: GuardContext): Verdict {
  try {
    return checkText(command, { ctx, cwds: [normalize(ctx.cwd)], depth: 0 });
  } catch (error) {
    if (error instanceof ParseError) {
      return { reason: `Couldn't parse this command (${error.message}); write it plainly without it.` };
    }
    return { reason: "The builder guard failed on this command; write it more simply." };
  }
}

function checkText(text: string, state: State): Verdict {
  for (const command of parseCommands(text)) {
    const verdict = checkSimple(command, state);
    if (verdict !== null) return verdict;
  }
  return null;
}

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const KEYWORDS = new Set(["{", "}", "!", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "esac"]);
const INFRA = new Set([
  "vercel",
  "eas",
  "neonctl",
  "neon",
  "flyctl",
  "fly",
  "heroku",
  "railway",
  "terraform",
  "pulumi",
  "kubectl",
  "aws",
  "gcloud",
  "az",
  "doctl",
  "firebase",
]);
const DB_CLIENTS = new Set(["psql", "pg_dump", "pg_restore", "pg_dumpall", "mysql"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** rm for /bin/rm; drizzle-kit for drizzle-kit@0.30; playwright for @playwright/test. */
function commandName(word: string): string {
  let name = word;
  if (name.startsWith("@")) {
    if (/^@playwright\//.test(name)) return "playwright";
    name = name.replace(/^@[^/]+\//, "");
  } else {
    name = name.slice(name.lastIndexOf("/") + 1);
  }
  const at = name.indexOf("@");
  return at > 0 ? name.slice(0, at) : name;
}

function checkSimple(command: Command, state: State): Verdict {
  const envCheck = checkEnvFiles([...command.words, ...command.redirects], state);
  if (envCheck !== null) return envCheck;
  return checkWords(command.words, state, false);
}

/** words: one simple command. unknownArgs: xargs appends arguments we can't see. */
function checkWords(input: Word[], state: State, unknownArgs: boolean): Verdict {
  let words = input;
  const env: Record<string, Word> = {};
  for (;;) {
    while (words.length > 0 && KEYWORDS.has(words[0].text) && !words[0].quoted) words = words.slice(1);
    while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0].text) && !words[0].quoted) {
      const eq = words[0].text.indexOf("=");
      env[words[0].text.slice(0, eq)] = { ...words[0], text: words[0].text.slice(eq + 1) };
      words = words.slice(1);
    }
    if (words.length === 0) return null;
    const stripped = stripWrapper(words);
    if (stripped === null) break;
    words = stripped;
  }
  const head = words[0];
  if (head.dynamic) return { reason: "The command name is a variable or substitution; spell out the command." };
  const name = commandName(head.text);
  const args = words.slice(1);
  const texts = args.map((a) => a.text);

  if (name === "cd" || name === "pushd") {
    const target = args.find((a) => !a.text.startsWith("-") || a.text === "-");
    if (target === undefined || target.dynamic || target.tilde || target.text === "-") state.cwds.push(null);
    else for (const cwd of [...state.cwds]) state.cwds.push(cwd === null ? null : resolvePath(cwd, target.text));
    return null;
  }
  if (SHELLS.has(name)) return checkShell(args, state);
  if (name === "eval") {
    if (args.some((a) => a.dynamic)) return { reason: "eval of a variable can't be checked; run the command directly." };
    return checkText(texts.join(" "), state);
  }
  if (name === "xargs") return checkXargs(args, state);
  if (name === "rm") return checkRm(args, state, unknownArgs);
  if (name === "find") return checkFind(args, state);
  if (name === "git") return checkGit(args);
  if (INFRA.has(name)) {
    return { reason: `${name} talks to production infrastructure; builders don't run it. Say in your report what needs doing.` };
  }
  if (name === "supabase") {
    const sub = texts.find((t) => !t.startsWith("-"));
    if (sub === "start" || sub === "stop" || sub === "status") return null;
    return { reason: "supabase (other than start/stop/status) reaches a real project; builders don't run it." };
  }
  if (DB_CLIENTS.has(name)) return checkDbClient(name, args, env);
  if (name === "drizzle-kit") {
    const sub = texts.find((t) => !t.startsWith("-"));
    if (sub !== undefined && ["push", "migrate", "drop", "studio", "up"].includes(sub) && !localDatabaseUrl(env)) {
      return { reason: `drizzle-kit ${sub} would hit the database in .env (production); set DATABASE_URL=postgres://localhost/... inline, or leave migrations to the owner.` };
    }
    return null;
  }
  if (name === "prisma") {
    const positional = texts.filter((t) => !t.startsWith("-"));
    if ((positional[0] === "migrate" || positional[0] === "db") && !localDatabaseUrl(env)) {
      return { reason: `prisma ${positional.slice(0, 2).join(" ")} would hit the database in .env (production); set DATABASE_URL=postgres://localhost/... inline, or leave it to the owner.` };
    }
    return null;
  }
  if (name === "curl" || name === "wget") return checkHttp(name, args);
  if (name === "playwright" || name === "maestro" || name === "ios-e2e-local.sh") return { reason: E2E_REASON };
  if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") return checkPackageManager(name, args, state);
  if ((name === "node" || name === "tsx" || name === "ts-node") && args.some((a) => /(^|\/)playwright(\/|$)|@playwright\//.test(a.text))) {
    return { reason: E2E_REASON };
  }
  return null;
}

/** Drops a wrapper (sudo, env, npx, ...) and its options; null when words[0] isn't one. */
function stripWrapper(words: Word[]): Word[] | null {
  const name = words[0].quoted ? "" : commandName(words[0].text);
  const rest = words.slice(1);
  const skipOptions = (list: Word[], withValue: readonly string[]): Word[] => {
    let i = 0;
    while (i < list.length && list[i].text.startsWith("-")) {
      if (list[i].text === "--") return list.slice(i + 1);
      i += withValue.includes(list[i].text) ? 2 : 1;
    }
    return list.slice(i);
  };
  switch (name) {
    case "sudo":
      return skipOptions(rest, ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U"]);
    case "env": {
      const split = rest.findIndex((w) => w.text === "-S" || w.text === "--split-string");
      if (split !== -1) return asShell(rest[split + 1]);
      return skipOptions(rest, ["-u", "-C", "-P"]);
    }
    case "command":
    case "builtin":
    case "exec":
      return skipOptions(rest, ["-a"]);
    case "time":
    case "nohup":
      return skipOptions(rest, []);
    case "nice":
      return skipOptions(rest, ["-n"]);
    case "timeout": {
      const list = skipOptions(rest, ["-s", "-k", "--signal", "--kill-after"]);
      return list.slice(1);
    }
    case "npx":
    case "bunx":
      return npxArgs(rest);
    case "npm":
      if (rest[0]?.text === "exec" || rest[0]?.text === "x") return npxArgs(rest.slice(1));
      return null;
    case "pnpm":
      if (rest[0]?.text === "dlx" || rest[0]?.text === "exec") return skipOptions(rest.slice(1), ["--package"]);
      return null;
    case "yarn":
      if (rest[0]?.text === "dlx" || rest[0]?.text === "exec") return skipOptions(rest.slice(1), ["-p", "--package"]);
      return null;
    case "bun":
      if (rest[0]?.text === "x") return skipOptions(rest.slice(1), []);
      return null;
    default:
      return null;
  }
}

/** npx/npm exec options; -c 'cmd' runs its string in a shell. */
function npxArgs(rest: Word[]): Word[] {
  const call = rest.findIndex((w) => w.text === "-c" || w.text === "--call");
  if (call !== -1) return asShell(rest[call + 1]);
  let i = 0;
  while (i < rest.length && rest[i].text.startsWith("-")) {
    if (rest[i].text === "--") return rest.slice(i + 1);
    i += ["-p", "--package", "-w", "--workspace"].includes(rest[i].text) ? 2 : 1;
  }
  return rest.slice(i);
}

/** A command string run by a shell: checked as sh -c. */
function asShell(body: Word | undefined): Word[] {
  const plain = (text: string): Word => ({ text, dynamic: false, glob: false, tilde: false });
  return [plain("sh"), plain("-c"), body ?? { text: "", dynamic: true, glob: false, tilde: false }];
}

function checkShell(args: Word[], state: State): Verdict {
  for (let i = 0; i < args.length; i += 1) {
    const text = args[i].text;
    if (text === "--" || !text.startsWith("-")) {
      // A script file: its body isn't inspected (the sandbox is the boundary).
      const script = text === "--" ? args[i + 1] : args[i];
      if (script === undefined) break;
      if (/(^|\/)ios-e2e-local\.sh$/.test(script.text)) return { reason: E2E_REASON };
      return null;
    }
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(text)) {
      const body = args[i + 1];
      if (body === undefined) return { reason: "sh -c with no command." };
      if (body.dynamic) return { reason: "sh -c of a variable can't be checked; run the command directly." };
      return checkText(body.text, state);
    }
    if (text === "-s") break;
  }
  return { reason: "A shell reading commands from stdin can't be checked; run the commands directly." };
}

function checkXargs(args: Word[], state: State): Verdict {
  const withValue = ["-I", "-J", "-L", "-n", "-P", "-s", "-E", "-d", "-a", "-R", "-S"];
  let i = 0;
  while (i < args.length && args[i].text.startsWith("-")) {
    i += withValue.includes(args[i].text) ? 2 : 1;
  }
  const rest = args.slice(i);
  if (rest.length === 0) return null;
  return checkWords(rest, state, true);
}

function isRecursiveFlag(text: string): boolean {
  if (text === "--recursive") return true;
  return /^-[a-zA-Z]+$/.test(text) && /[rR]/.test(text);
}

function checkRm(args: Word[], state: State, unknownArgs: boolean): Verdict {
  let recursive = false;
  const targets: Word[] = [];
  let options = true;
  for (const arg of args) {
    if (options && arg.text === "--") options = false;
    else if (options && arg.text.startsWith("-") && arg.text !== "-") recursive ||= isRecursiveFlag(arg.text);
    else targets.push(arg);
  }
  if (!recursive) return null;
  if (unknownArgs) return { reason: "rm -r on paths from xargs can't be checked; list the paths inside your worktree directly." };
  for (const target of targets) {
    const problem = outsideWorktree(target, state, false);
    if (problem !== null) return { reason: `rm -r ${target.text}: ${problem}. Only delete paths inside your worktree, never the worktree itself.` };
  }
  return null;
}

/** Why target isn't safely inside the worktree, or null. allowRoot: the worktree itself counts. */
function outsideWorktree(target: Word, state: State, allowRoot: boolean): string | null {
  if (target.tilde) return "a ~ path is outside your worktree";
  if (target.dynamic) return "a path built from a variable can't be checked";
  if (target.glob && globClimbs(target.text)) return "that glob can match .. and climb out";
  const wt = normalize(state.ctx.worktree);
  for (const cwd of state.cwds) {
    if (cwd === null && !target.text.startsWith("/")) return "the directory it runs in isn't known (cd to a variable?)";
    const resolved = resolvePath(cwd ?? "/", target.text);
    if (!(allowRoot ? inside(resolved, wt) : strictlyInside(resolved, wt))) {
      return resolved === wt ? "that is the whole worktree" : `${resolved} is outside your worktree`;
    }
  }
  return null;
}

function checkFind(args: Word[], state: State): Verdict {
  const paths: Word[] = [];
  let i = 0;
  while (i < args.length && !/^[-(!]/.test(args[i].text)) {
    paths.push(args[i]);
    i += 1;
  }
  const expression = args.slice(i);
  let deletes = false;
  for (let j = 0; j < expression.length; j += 1) {
    const t = expression[j].text;
    if (t === "-delete") deletes = true;
    if (t === "-exec" || t === "-execdir" || t === "-ok" || t === "-okdir") {
      let end = j + 1;
      while (end < expression.length && expression[end].text !== ";" && expression[end].text !== "+") end += 1;
      const sub = expression.slice(j + 1, end);
      if (sub.length > 0 && !sub[0].dynamic && commandName(sub[0].text) === "rm") deletes = true;
      else if (sub.length > 0) {
        const verdict = checkWords(sub, state, false);
        if (verdict !== null) return verdict;
      }
      j = end;
    }
  }
  if (!deletes) return null;
  const roots = paths.length > 0 ? paths : [{ text: ".", dynamic: false, glob: false, tilde: false }];
  for (const root of roots) {
    const problem = outsideWorktree(root, state, true);
    if (problem !== null) return { reason: `find ... -delete/-exec rm on ${root.text}: ${problem}. Only delete inside your worktree.` };
  }
  return null;
}

function checkGit(args: Word[]): Verdict {
  let i = 0;
  while (i < args.length && args[i].text.startsWith("-")) {
    const t = args[i].text;
    if (t === "-c" && /^alias\./i.test(args[i + 1]?.text ?? "")) return { reason: "git -c alias.* can hide a push; run the git command directly." };
    i += ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"].includes(t) ? 2 : 1;
  }
  const sub = args[i];
  if (sub === undefined) return null;
  if (sub.dynamic) return { reason: "A git subcommand from a variable can't be checked; spell it out." };
  if (sub.text === "push" || sub.text === "send-pack" || sub.text === "http-push") return { reason: PUSH_REASON };
  return null;
}

// -------------------------------------------------------------- DB and HTTP

function hostOfUrl(text: string): string | null {
  const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/.exec(text);
  return m === null ? null : m[1];
}

function isLocalHost(host: string): boolean {
  return host === "" || host.startsWith("/") || LOCAL_HOSTS.has(host.toLowerCase());
}

function localUrl(text: string): boolean {
  const host = hostOfUrl(text);
  if (host === null || !isLocalHost(host)) return false;
  // A socket URL with ?host=... could still name a remote host.
  const q = /[?&]host=([^&]*)/.exec(text);
  return q === null || isLocalHost(decodeURIComponent(q[1]));
}

function localDatabaseUrl(env: Record<string, Word>): boolean {
  const url = env.DATABASE_URL;
  return url !== undefined && !url.dynamic && localUrl(url.text);
}

function checkDbClient(name: string, args: Word[], env: Record<string, Word>): Verdict {
  const deny = { reason: `${name} against anything but localhost is refused (production data). Use a local database, or leave it to the owner.` };
  for (const key of ["PGHOST", "DATABASE_URL", "PGSERVICE", "MYSQL_HOST"]) {
    const value = env[key];
    if (value === undefined) continue;
    if (value.dynamic) return deny;
    if (key === "PGSERVICE") return deny;
    if (!(key.endsWith("URL") ? localUrl(value.text) : isLocalHost(value.text))) return deny;
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.dynamic) return deny;
    const t = arg.text;
    let host: string | null = null;
    if (t === "-h" || t === "--host") host = args[i + 1]?.dynamic ? "$" : (args[i + 1]?.text ?? "");
    else if (t.startsWith("--host=")) host = t.slice(7);
    else if (/^-h./.test(t)) host = t.slice(2);
    if (host !== null && !isLocalHost(host)) return deny;
    if (t.includes("://") && !localUrl(t.replace(/^--?[a-z-]+=/, ""))) return deny;
    for (const m of t.matchAll(/(?:^|\s)(host|hostaddr|service)\s*=\s*'?([^\s']*)/g)) {
      if (m[1] === "service" || !isLocalHost(m[2])) return deny;
    }
  }
  return null;
}

const CURL_VALUE = new Set([
  "-H", "-o", "-u", "-A", "-e", "-b", "-c", "-w", "-x", "-E", "-m", "-r", "-z", "-U", "-Y", "-y",
  "--header", "--output", "--user", "--user-agent", "--referer", "--cookie", "--cookie-jar", "--write-out",
  "--proxy", "--cert", "--key", "--cacert", "--max-time", "--connect-timeout", "--retry", "--range", "-O",
  "--output-dir", "--resolve", "--connect-to",
]);

function checkHttp(name: string, args: Word[]): Verdict {
  let write = false;
  const urls: Word[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const t = args[i].text;
    if (name === "curl") {
      if (t === "-X" || t === "--request") {
        const method = (args[i + 1]?.text ?? "").toUpperCase();
        if (method !== "GET" && method !== "HEAD") write = true;
        i += 1;
      } else if (/^-X./.test(t) || t.startsWith("--request=")) {
        const method = t.replace(/^(-X|--request=)/, "").toUpperCase();
        if (method !== "GET" && method !== "HEAD") write = true;
      } else if (/^(-d|-F|-T|--data|--form|--upload-file|--json|-K|--config)/.test(t) && !t.startsWith("--data-dir")) {
        write = true;
        if (!t.includes("=") && /^(-d|-F|-T|-K)$|^--(data|data-raw|data-binary|data-urlencode|data-ascii|form|form-string|upload-file|json|config)$/.test(t)) i += 1;
      } else if (t === "--url") {
        if (args[i + 1] !== undefined) urls.push(args[i + 1]);
        i += 1;
      } else if (CURL_VALUE.has(t)) {
        i += 1;
      } else if (!t.startsWith("-")) {
        urls.push(args[i]);
      }
    } else {
      if (/^--(method|post-data|post-file|body-data|body-file)/.test(t)) {
        const method = t.startsWith("--method=") ? t.slice(9).toUpperCase() : "POST";
        if (method !== "GET" && method !== "HEAD") write = true;
        if (!t.includes("=")) i += 1;
      } else if (!t.startsWith("-")) {
        urls.push(args[i]);
      }
    }
  }
  if (!write) return null;
  const allLocal =
    urls.length > 0 &&
    urls.every((u) => {
      if (u.dynamic) return false;
      const withScheme = /^[a-z]+:\/\//i.test(u.text) ? u.text : `http://${u.text}`;
      const host = hostOfUrl(withScheme);
      return host !== null && host !== "" && LOCAL_HOSTS.has(host.toLowerCase());
    });
  if (allLocal) return null;
  return { reason: `${name} with a write method (POST/PUT/DELETE/data) to a non-local host is refused; only GET, or target localhost.` };
}

// ------------------------------------------------------------ package managers

const NPM_BUILTINS = new Set([
  "access", "adduser", "audit", "bugs", "cache", "ci", "completion", "config", "dedupe", "deprecate", "diff",
  "dist-tag", "docs", "doctor", "edit", "explain", "explore", "find-dupes", "fund", "help", "hook", "i", "init",
  "install", "install-ci-test", "install-test", "link", "ll", "login", "logout", "ls", "list", "outdated", "owner",
  "pack", "ping", "pkg", "prefix", "profile", "prune", "publish", "query", "rebuild", "repo", "search", "set",
  "shrinkwrap", "star", "stars", "team", "token", "uninstall", "unpublish", "unstar", "update", "version", "view",
  "whoami", "add", "remove", "rm", "why", "info", "outdated", "upgrade", "up", "store", "setup", "env", "create",
  "import", "licenses", "patch", "patch-commit", "node", "workspaces", "plugin", "dlx", "exec", "x",
]);

function isE2eScriptName(script: string): boolean {
  return /^e2e/i.test(script) || /^test:e2e/i.test(script);
}

function checkPackageManager(name: string, args: Word[], state: State): Verdict {
  // Options before the subcommand; --prefix/-C/--cwd move where scripts come from.
  let i = 0;
  let prefix: Word | null = null;
  while (i < args.length && args[i].text.startsWith("-")) {
    const t = args[i].text;
    if (t === "--prefix" || t === "-C" || t === "--cwd" || t === "--dir") {
      prefix = args[i + 1] ?? null;
      i += 2;
    } else if (/^--(prefix|cwd|dir)=/.test(t)) {
      prefix = { ...args[i], text: t.slice(t.indexOf("=") + 1) };
      i += 1;
    } else {
      i += 1;
    }
  }
  const sub = args[i];
  if (sub === undefined) return null;
  if (sub.dynamic) return { reason: `${name} with a script name from a variable can't be checked; spell it out.` };
  if (sub.text === "exec" || sub.text === "x" || sub.text === "dlx") {
    return checkWords([{ text: "npx", dynamic: false, glob: false, tilde: false }, ...args.slice(i + 1)], state, false);
  }
  let script: string | null = null;
  let rest: Word[] = [];
  if (sub.text === "run" || sub.text === "run-script" || sub.text === "rum" || sub.text === "urn") {
    const target = args.slice(i + 1).find((a) => !a.text.startsWith("-"));
    if (target === undefined) return null; // lists the scripts
    if (target.dynamic) return { reason: `${name} run of a variable can't be checked; spell out the script.` };
    script = target.text;
    rest = args.slice(args.indexOf(target) + 1);
  } else if (["test", "t", "tst", "start", "stop", "restart"].includes(sub.text)) {
    script = ({ t: "test", tst: "test" } as Record<string, string>)[sub.text] ?? sub.text;
    rest = args.slice(i + 1);
  } else if ((name === "yarn" || name === "pnpm" || name === "bun") && !NPM_BUILTINS.has(sub.text)) {
    // yarn X / pnpm X runs a script X, else a binary X from node_modules/.bin.
    script = sub.text;
    rest = args.slice(i + 1);
    if (!hasScript(script, prefix, state)) return checkWords(args.slice(i), state, false);
  } else {
    return null;
  }
  if (isE2eScriptName(script)) return { reason: E2E_REASON };
  return expandScript(script, rest, prefix, state);
}

function scriptDirs(prefix: Word | null, state: State): Array<string | null> {
  if (prefix === null) return state.cwds;
  if (prefix.dynamic || prefix.tilde) return [null];
  return state.cwds.map((cwd) => (cwd === null && !prefix.text.startsWith("/") ? null : resolvePath(cwd ?? "/", prefix.text)));
}

function scriptsFor(dir: string, state: State): Record<string, string> | null {
  if (state.ctx.scriptsAt !== undefined) return state.ctx.scriptsAt(dir);
  return dir === normalize(state.ctx.cwd) ? state.ctx.scripts : null;
}

function hasScript(script: string, prefix: Word | null, state: State): boolean {
  return scriptDirs(prefix, state).some((dir) => dir !== null && typeof scriptsFor(dir, state)?.[script] === "string");
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function expandScript(script: string, rest: Word[], prefix: Word | null, state: State): Verdict {
  if (state.depth >= SCRIPT_DEPTH) {
    return { reason: `npm scripts nest deeper than ${SCRIPT_DEPTH} levels; run the underlying command directly.` };
  }
  if (rest.some((a) => a.dynamic)) return { reason: "Script arguments from a variable can't be checked; spell them out." };
  const extra = rest.filter((a, n) => !(n === 0 && a.text === "--")).map((a) => shellQuote(a.text)).join(" ");
  let found = false;
  for (const dir of scriptDirs(prefix, state)) {
    if (dir === null) return { reason: `Can't tell which package.json "${script}" comes from; run its command directly.` };
    const scripts = scriptsFor(dir, state);
    const body = scripts?.[script];
    if (typeof body !== "string") continue;
    found = true;
    for (const [part, text] of [
      [`pre${script}`, scripts?.[`pre${script}`]],
      [script, extra === "" ? body : `${body} ${extra}`],
      [`post${script}`, scripts?.[`post${script}`]],
    ] as Array<[string, string | undefined]>) {
      if (typeof text !== "string") continue;
      const verdict = checkText(text, { ctx: state.ctx, cwds: [dir], depth: state.depth + 1 });
      if (verdict === null) continue;
      // Name the script the owner's builder typed; nested ones only add noise.
      return state.depth === 0 ? { reason: `script "${part}" (${clip(text)}): ${verdict.reason}` } : verdict;
    }
  }
  if (!found) return { reason: `No package.json script "${script}" where this runs; run its command directly.` };
  return null;
}

function clip(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

// ---------------------------------------------------------------- env files

function checkEnvFiles(words: Word[], state: State): Verdict {
  const wt = normalize(state.ctx.worktree);
  const repo = repoOf(wt);
  if (repo === null) return null;
  const candidates = [".env", ".env.local", ".env.production", ".env.development"].flatMap((n) => [
    `${repo === "/" ? "" : repo}/${n}`,
    `${repo === "/" ? "" : repo}/mobile/${n}`,
  ]);
  const deny = { reason: "The main checkout's env files are off limits (production keys). Use the env your worktree was given." };
  const isRepoEnv = (path: string) =>
    !inside(path, wt) && inside(path, repo) && /^(mobile\/)?\.env[^/]*$/.test(path.slice(repo === "/" ? 1 : repo.length + 1));
  const settings = new Set([`${wt}/.claude/settings.local.json`, `${wt}/.claude/settings.json`]);
  for (const word of words) {
    for (const text of [word.text, ...(word.text.includes("=") ? [word.text.slice(word.text.indexOf("=") + 1)] : [])]) {
      if (!text.includes(".env") && !text.includes("settings")) continue;
      if (word.dynamic || word.tilde) {
        // $REPO/.env, ~/x/.env: can't be resolved, so refused.
        if (text.includes(".env")) return deny;
        continue;
      }
      for (const cwd of state.cwds) {
        if (cwd === null) {
          if (!text.startsWith("/") && text.includes("..") && text.includes(".env")) return deny;
          if (!text.startsWith("/")) continue;
        }
        const resolved = resolvePath(cwd ?? "/", text);
        if (settings.has(resolved)) {
          return { reason: "Your worktree's .claude settings hold the builder guard; leave them alone." };
        }
        if (word.glob ? candidates.some((c) => globMatchesPath(resolved, c)) : isRepoEnv(resolved)) return deny;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- settings

export interface BuilderSettingsOptions {
  /** The PreToolUse command: node '<pluginRoot>/builderguard.ts' '<worktree>' || exit 2 */
  hookCommand: string;
  /** The main checkout. */
  repoPath: string;
  /** Env-like include patterns (envPatternsOf). */
  envPatterns: readonly string[];
  /** The worktree: its .claude/ is closed to edits so the guard stays in place. */
  worktreePath?: string;
}

/** Include patterns naming env files (.env*), relative to the repo. */
export function envPatternsOf(include: readonly string[]): string[] {
  return [
    ...new Set(
      include
        .map((p) => p.trim().replace(/^\/+/, ""))
        .filter((p) => p !== "" && /^\.env/.test(p.slice(p.lastIndexOf("/") + 1)) && !p.split("/").includes("..")),
    ),
  ];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function isGuardHook(entry: unknown): boolean {
  const hooks = record(entry).hooks;
  return Array.isArray(hooks) && hooks.some((h) => typeof record(h).command === "string" && String(record(h).command).includes("builderguard.ts"));
}

/** settings.local.json for a build worktree: existing keys kept, the guard, sandbox and deny rules added. */
export function builderSettings(existing: unknown, options: BuilderSettingsOptions): Record<string, unknown> {
  const settings = record(existing);
  const hooks = record(settings.hooks);
  const pre = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse.filter((entry) => !isGuardHook(entry)) : [];
  pre.push({ matcher: "Bash", hooks: [{ type: "command", command: options.hookCommand }] });
  hooks.PreToolUse = pre;
  settings.hooks = hooks;

  settings.sandbox = {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    network: { allowedDomains: ["registry.npmjs.org"] },
  };

  const repo = normalize(options.repoPath);
  const permissions = record(settings.permissions);
  const deny = Array.isArray(permissions.deny) ? permissions.deny.filter((d): d is string => typeof d === "string") : [];
  const rules = [
    ...[".env*", "mobile/.env*", ...options.envPatterns].map((p) => `Read(/${repo}/${p.replace(/^\/+/, "")})`),
    "Bash(git push:*)",
    ...(options.worktreePath !== undefined ? [`Edit(/${normalize(options.worktreePath)}/.claude/**)`] : []),
  ];
  permissions.deny = [...new Set([...deny, ...rules])];
  settings.permissions = permissions;
  return settings;
}

/**
 * The plugin's source folder (where this file lives) from the folder a bundle
 * runs from: <root>/dist gives <root>, a source folder itself. Null for bb's
 * host artifacts copy (~/.bb/plugin-host-artifacts/…), whose hash changes on
 * every reload and which holds no source.
 */
export function pluginSourceRoot(dir: string): string | null {
  const clean = dir.replace(/\/+$/, "");
  if (clean === "" || `${clean}/`.includes("/plugin-host-artifacts/")) return null;
  return clean.endsWith("/dist") ? clean.slice(0, -"/dist".length) || "/" : clean;
}

/** The hook command for a worktree; a missing node or a crash blocks the call. */
export function guardHookCommand(pluginRoot: string, worktree: string): string {
  return `node ${shellQuote(`${pluginRoot.replace(/\/+$/, "")}/builderguard.ts`)} ${shellQuote(worktree)} || exit 2`;
}

// -------------------------------------------------------------------- hook

if ((import.meta as { main?: boolean }).main) {
  // No top-level await: bb bundles this file as cjs for the host.
  void (async (): Promise<number> => {
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const worktree = process.argv[2];
      if (worktree === undefined || !worktree.startsWith("/")) throw new Error("builderguard: no worktree argument");
      const input = JSON.parse(fs.readFileSync(0, "utf8")) as {
        tool_name?: unknown;
        tool_input?: { command?: unknown };
        cwd?: unknown;
      };
      if (input.tool_name !== "Bash") return 0;
      const command = input.tool_input?.command;
      if (typeof command !== "string") throw new Error("builderguard: no command");
      const cwd = typeof input.cwd === "string" && input.cwd.startsWith("/") ? input.cwd : worktree;
      const root = path.resolve(worktree);
      const scriptsAt = (dir: string): Record<string, string> | null => {
        let at = path.resolve(dir);
        if (at !== root && !at.startsWith(root + path.sep)) return null;
        for (;;) {
          try {
            const pkg = JSON.parse(fs.readFileSync(path.join(at, "package.json"), "utf8")) as { scripts?: unknown };
            const scripts: Record<string, string> = {};
            for (const [k, v] of Object.entries(record(pkg.scripts))) if (typeof v === "string") scripts[k] = v;
            return scripts;
          } catch {
            // No (readable) package.json here: npm looks further up.
          }
          if (at === root) return null;
          at = path.dirname(at);
        }
      };
      const verdict = checkCommand(command, { cwd, worktree, scripts: scriptsAt(cwd) ?? {}, scriptsAt });
      if (verdict === null) return 0;
      process.stderr.write(`Builder guard: ${verdict.reason}\n`);
      return 2;
    } catch (error) {
      process.stderr.write(`Builder guard failed closed: ${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
  })().then((code) => process.exit(code));
}
