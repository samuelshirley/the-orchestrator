// Where TypeSafe's hosted Jev is, and the key for it. Jev steers one thing:
// the model of task, research and build agents (modelroute.ts).
//
// The key is JEV_API_KEY in ~/.config/the-orchestrator/jev.env (next to the
// local config, outside every repo) when that file is there, else in The
// Orchestrator repo's own .env: the main checkout of its land: "main"
// project, never a worktree's (jevKey). Only host.ts reads either file; one
// that group or others can read is refused, and so is a repo .env git
// tracks. The key never leaves the host except in the Authorization header
// to TYPESAFE_BASE_URL: it is never logged, never in an error, never sent to
// the board or the dossier (the board gets the file's path, never its text).
//
// Pure: host.ts reads the file and its mode, this reads the text.

/** A constant, not configurable: the key is only ever sent here. */
export const TYPESAFE_BASE_URL = "https://api.typesafe.ai";
/** An alias; the answer's `model` names the version that answered, and that is what is stored. */
export const TYPESAFE_MODEL = "jev-latest";
export const JEV_KEY_NAME = "JEV_API_KEY";
/** Under the home folder, beside the local config (localconfig.ts LOCAL_CONFIG_PATH). */
export const JEV_KEY_PATH = [".config", "the-orchestrator", "jev.env"] as const;
export const JEV_KEY_DISPLAY = `~/${JEV_KEY_PATH.join("/")}`;
/** The host re-reads the file at most this often, so a new key is picked up without a reload. */
export const KEY_REREAD_MS = 60_000;
/** Longer than any .env line we want; a bigger file is not read past this. */
export const KEY_FILE_MAX_CHARS = 64_000;

export interface TypesafeConfig {
  baseUrl: string;
  key: string;
  model: string;
}

/**
 * TypeSafe's config from the text of jev.env: a line `JEV_API_KEY=...`, with
 * optional `export` and matching quotes; the last such line wins, as in a
 * shell. Null (no call) when the file or the line is missing, or the key is
 * empty, has whitespace or anything but printable ASCII (it goes into a header).
 */
export function typesafeConfig(envText: string | null): TypesafeConfig | null {
  if (envText === null) return null;
  let key: string | null = null;
  for (const line of envText.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?JEV_API_KEY\s*=(.*)$/.exec(line);
    if (match === null) continue;
    let value = match[1].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) value = value.slice(1, -1);
    key = value;
  }
  if (key === null || !/^[\x21-\x7e]{1,512}$/.test(key)) return null;
  return { baseUrl: TYPESAFE_BASE_URL, key, model: TYPESAFE_MODEL };
}

/** Why there is no key: no file or no valid line, a file others can read, or a repo .env git tracks. */
export type KeyProblem = "missing" | "open" | "tracked";
export type KeyState = { ok: true; config: TypesafeConfig } | { ok: false; problem: KeyProblem };
/** A key state with the file it came from (or is about), for the board: a path, never the text. */
export type KeyReading = { ok: true; config: TypesafeConfig; file: string } | { ok: false; problem: KeyProblem; file: string | null };

/**
 * The key from the file as the host found it: null when it is not there.
 * A file whose mode lets group or others in (mode & 0o077) is refused, key or not.
 */
export function keyFromFile(file: { text: string; mode: number } | null): KeyState {
  if (file === null) return { ok: false, problem: "missing" };
  if ((file.mode & 0o077) !== 0) return { ok: false, problem: "open" };
  const config = typesafeConfig(file.text);
  return config === null ? { ok: false, problem: "missing" } : { ok: true, config };
}

/**
 * The repo .env the key may come from: `<checkout>/.env` of The
 * Orchestrator's main checkout. Null for anything that is not an absolute
 * path to a main checkout (a worktree under .claude/worktrees never counts).
 */
export function repoEnvPath(checkout: string | null): string | null {
  if (checkout === null || !checkout.startsWith("/")) return null;
  const clean = checkout.replace(/\/+$/, "");
  if (clean === "" || /\/\.claude\/worktrees(\/|$)/.test(clean) || clean.split("/").includes("..")) return null;
  return `${clean}/.env`;
}

export type KeySource = { text: string; mode: number } | null;

/**
 * The key, by precedence: jev.env when the file is there (it alone decides,
 * key or not), else the repo .env, refused when git tracks it (or that could
 * not be checked: `tracked` null) or others can read it. Missing both: no key.
 */
export function jevKey(args: {
  home: KeySource;
  repo: (KeySource & { tracked: boolean | null }) | null;
  repoPath: string | null;
}): KeyReading {
  if (args.home !== null) return { ...keyFromFile(args.home), file: JEV_KEY_DISPLAY };
  if (args.repo !== null && args.repoPath !== null) {
    if (args.repo.tracked !== false) return { ok: false, problem: "tracked", file: args.repoPath };
    return { ...keyFromFile(args.repo), file: args.repoPath };
  }
  return { ok: false, problem: "missing", file: null };
}

function shellPath(path: string): string {
  if (path.startsWith("~/") && /^[A-Za-z0-9_./~-]+$/.test(path)) return path;
  return /^[A-Za-z0-9_./-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
}

/** The board's words for a key problem, naming the file (null: neither file is there). */
export function keyProblemText(problem: KeyProblem, file: string | null = null): string {
  if (problem === "open") {
    const at = file ?? JEV_KEY_DISPLAY;
    return `${at} is readable by others, so its key is not used: chmod 600 ${shellPath(at)}`;
  }
  if (problem === "tracked") {
    return `git tracks ${file ?? "the repo .env"}, so its key is not used: untrack it (it must stay out of the repo) or put ${JEV_KEY_NAME} in ${JEV_KEY_DISPLAY}.`;
  }
  return file === null
    ? `No ${JEV_KEY_NAME} in ${JEV_KEY_DISPLAY} or The Orchestrator's .env.`
    : `No ${JEV_KEY_NAME} in ${file}.`;
}

/** Whether the host's cached reading is due a re-read. */
export function keyStale(now: number, readAt: number | null): boolean {
  return readAt === null || now - readAt >= KEY_REREAD_MS;
}
