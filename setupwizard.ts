// First run: the owner says which folder The Orchestrator may work in, ticks
// the git repos in it to add as projects, and sees whether GitHub and Claude
// are signed in. The pure policy lives here (when the wizard shows, which
// folder is allowed, which repos can be ticked, what the config file becomes,
// what a sign-in check means); host.ts lists the folder and writes the file,
// server.ts registers the projects. No node imports: the app uses it for its
// inline checks. setupwizard.test.ts pins the rules.
import { LOCAL_CONFIG_DISPLAY, parseLocalConfig } from "./localconfig";
import { PROJECTS_DIR } from "./newproject";
import { OWNER_NAME_MAX } from "./owner";

/** What the wizard suggests, and where Add project goes when the config names no folder. */
export const DEFAULT_PROJECTS_DIR = `~/${PROJECTS_DIR.join("/")}`;
/** The config's own cap on `projectsDir` (localconfig.ts). */
export const PROJECTS_DIR_MAX = 500;
/** At most this many folders of the chosen one are listed. */
export const REPO_LIST_CAP = 200;
/** How much of a repo's .git/config the host reads for its origin. */
export const GIT_CONFIG_MAX_CHARS = 20_000;
export const GH_SIGN_IN_COMMAND = "gh auth login";

/**
 * The wizard opens by itself only on an install that has neither a folder in
 * its config nor a project (the Personal one is not counted), and only once
 * the config file has been read without a problem: an install that already
 * has projects never sees it uninvited, and neither does one whose file the
 * wizard could not save to.
 */
export function needsSetup({
  projectsDir,
  projectCount,
  configReady = true,
}: {
  projectsDir: string | null;
  projectCount: number;
  /** The file was read and has no problem. */
  configReady?: boolean;
}): boolean {
  return configReady && projectsDir === null && projectCount === 0;
}

export type DirCheck = { ok: true; path: string } | { ok: false; reason: string };

const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const trimSlashes = (value: string) => value.replace(/\/+$/, "");

/**
 * The folder as a normalised absolute path, or why not. A leading "~" is the
 * home directory. It must be inside the home directory and not the home
 * directory itself: The Orchestrator is never given the whole account.
 */
export function validateProjectsDir(path: string, home: string): DirCheck {
  const no = (reason: string): DirCheck => ({ ok: false, reason });
  const base = trimSlashes(home);
  if (!base.startsWith("/") || CONTROL.test(base) || base.split("/").includes("..")) {
    return no("The home folder is not known yet, so no folder can be checked. Try again in a moment.");
  }
  const typed = path.trim();
  if (typed === "") return no("Say which folder The Orchestrator may work in.");
  if (CONTROL.test(path)) return no("The folder's path has a character that cannot be in a path.");
  if (typed.length > PROJECTS_DIR_MAX) return no(`Keep the path to ${PROJECTS_DIR_MAX} characters or fewer.`);
  const expanded = typed === "~" ? base : typed.startsWith("~/") ? `${base}/${typed.slice(2)}` : typed;
  if (!expanded.startsWith("/")) return no("Use the folder's full path, starting with / or ~/.");
  const parts = expanded.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) return no('The path may not have "..".');
  const normal = `/${parts.join("/")}`;
  if (normal === "/") return no("Pick a folder inside your home folder, not the whole disk.");
  if (normal.length > PROJECTS_DIR_MAX) return no(`Keep the path to ${PROJECTS_DIR_MAX} characters or fewer.`);
  if (normal === base) return no("Pick a folder inside your home folder, not the home folder itself.");
  if (!normal.startsWith(`${base}/`)) return no(`Pick a folder inside your home folder (${base}).`);
  return { ok: true, path: normal };
}

/**
 * Where Add project puts a new folder: the config's folder when it has one
 * (checked again against the real home directory), else the default. A
 * config folder that fails the check is refused, never quietly replaced.
 */
export function projectsDirInForce(configDir: string | null, home: string): DirCheck {
  if (configDir === null) return validateProjectsDir(DEFAULT_PROJECTS_DIR, home);
  const check = validateProjectsDir(configDir, home);
  return check.ok ? check : { ok: false, reason: `projectsDir in ${LOCAL_CONFIG_DISPLAY} is not usable. ${check.reason}` };
}

/** One immediate subfolder, as the host found it. */
export interface RepoEntry {
  name: string;
  /** It has a .git folder of its own. */
  git: boolean;
  /** Its origin remote, without any credentials; null when it has none. */
  remote: string | null;
}

export interface RepoChoice {
  name: string;
  path: string;
  remote: string | null;
  /** Already a project: shown ticked off as added. */
  added: boolean;
  selectable: boolean;
  /** Why it cannot be ticked; null when it can. */
  reason: string | null;
}

export interface RepoChoices {
  choices: RepoChoice[];
  /** Said under the list: nothing found, or the list was cut. */
  note: string | null;
}

export const NO_REPOS_NOTE = "No git repos in this folder yet. You can add projects later.";

/**
 * What the wizard lists for a folder: every subfolder the host found, in name
 * order, with which can be ticked. `dir` is the validated folder.
 */
export function repoChoices(
  dir: string,
  listing: { entries: readonly RepoEntry[]; truncated: boolean },
  registeredPaths: readonly string[],
): RepoChoices {
  const base = trimSlashes(dir);
  const taken = new Set(registeredPaths.map(trimSlashes));
  const choices = [...listing.entries]
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, REPO_LIST_CAP)
    .map((entry): RepoChoice => {
      const path = `${base}/${entry.name}`;
      const added = taken.has(path);
      const safeName = entry.name !== "" && !entry.name.startsWith(".") && !/[/\\]/.test(entry.name) && !CONTROL.test(entry.name);
      const reason = !safeName
        ? "Its name cannot be used."
        : added
          ? "Already a project."
          : !entry.git
            ? "Not a git repo."
            : null;
      return { name: entry.name, path, remote: entry.remote, added, selectable: reason === null, reason };
    });
  const cut = listing.truncated || listing.entries.length > REPO_LIST_CAP;
  const notes: string[] = [];
  if (!choices.some((choice) => choice.selectable || choice.added)) notes.push(NO_REPOS_NOTE);
  if (cut) notes.push(`Only the first ${REPO_LIST_CAP} folders are listed. Add the others later with Add existing folder….`);
  return { choices, note: notes.length === 0 ? null : notes.join(" ") };
}

export type Pick = { name: string; ok: true; path: string } | { name: string; ok: false; reason: string };

/** The ticked names against the list as it is now: each one's path, or why it is not added. */
export function pickRepos(names: readonly string[], choices: readonly RepoChoice[]): Pick[] {
  return [...new Set(names)].map((name): Pick => {
    const choice = choices.find((candidate) => candidate.name === name);
    if (choice === undefined) return { name, ok: false, reason: "It is not in the folder any more." };
    if (!choice.selectable) return { name, ok: false, reason: choice.reason ?? "It cannot be added." };
    return { name, ok: true, path: choice.path };
  });
}

/** The origin's URL from a repo's .git/config text, or null. */
export function originUrlOf(gitConfig: string): string | null {
  let inOrigin = false;
  for (const raw of gitConfig.slice(0, GIT_CONFIG_MAX_CHARS).split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inOrigin = /^\[remote\s+"origin"\]/.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const match = /^url\s*=\s*(.+)$/.exec(line);
    if (match !== null) return safeRemote(match[1]!);
  }
  return null;
}

/** A remote URL fit to show: no user or token, one line, capped. */
export function safeRemote(url: string): string | null {
  const clean = url.trim().replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, "$1");
  if (clean === "" || CONTROL.test(clean)) return null;
  return clean.slice(0, 300);
}

/**
 * What the wizard writes for the name: undefined leaves the file's name as it
 * is (the person did not change it), null takes it out (they put back the name
 * git gives), a string is the name they typed.
 */
export function ownerNameToSave(typed: string, inForce: string, fromGit: string): string | null | undefined {
  const name = typed.trim();
  if (name === "" || name === inForce) return undefined;
  return name === fromGit ? null : name;
}

export type MergeResult = { ok: true; text: string } | { ok: false; reason: string };

/**
 * The config file's new text: the file as it is with `projectsDir` set (and
 * the name set or taken out), every other key kept in place. A file that has
 * a problem is refused, never overwritten; no file gives a minimal one. The
 * result is checked the way the file is read.
 */
export function mergeSetupIntoConfig(
  existingText: string | null,
  setup: { projectsDir: string; ownerName?: string | null },
): MergeResult {
  const no = (reason: string): MergeResult => ({ ok: false, reason });
  if (existingText !== null) {
    const current = parseLocalConfig(existingText);
    if (current.problem !== null) return no(`${current.problem} Fix it first: setup does not overwrite a file it cannot read.`);
  }
  if (!setup.projectsDir.startsWith("/") || CONTROL.test(setup.projectsDir) || setup.projectsDir.length > PROJECTS_DIR_MAX) {
    return no("The folder must be a full path.");
  }
  const next: Record<string, unknown> = existingText === null ? {} : { ...(JSON.parse(existingText) as Record<string, unknown>) };
  if (typeof setup.ownerName === "string") {
    const name = setup.ownerName.trim();
    if (name === "" || name.length > OWNER_NAME_MAX || CONTROL.test(name)) {
      return no(`Keep the name to one line of ${OWNER_NAME_MAX} characters or fewer.`);
    }
    next.ownerName = name;
  } else if (setup.ownerName === null) {
    delete next.ownerName;
  }
  next.projectsDir = setup.projectsDir;
  const text = `${JSON.stringify(next, null, 2)}\n`;
  const problem = parseLocalConfig(text).problem;
  if (problem !== null) return no(problem);
  return { ok: true, text };
}

export type SignInState = "in" | "out" | "missing" | "unknown";

export interface SignIn {
  state: SignInState;
  /** Who is signed in, when the tool says so. */
  account: string | null;
}

/** How a command ended: its stdout, and its exit code (null: it never ran; "ENOENT": no such command). */
export interface CommandEnd {
  stdout: string;
  stderr: string;
  code: number | "ENOENT" | null;
}

/** `gh api user --jq .login` (newproject.ts GH_LOGIN_ARGS), read for the wizard. */
export function ghSignIn(end: CommandEnd, parseLogin: (stdout: string) => string | null): SignIn {
  if (end.code === "ENOENT") return { state: "missing", account: null };
  if (end.code === 0) {
    const login = parseLogin(end.stdout);
    return login === null ? { state: "unknown", account: null } : { state: "in", account: login };
  }
  // gh says so itself when nobody is signed in; anything else (no network) is not an answer.
  if (end.code !== null && /gh auth login|not logged in|authentication/i.test(end.stderr)) return { state: "out", account: null };
  return { state: "unknown", account: null };
}

const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/** `claude auth status`: JSON with `loggedIn`. Only that and the account's email are read. */
export function claudeSignIn(end: CommandEnd): SignIn {
  if (end.code === "ENOENT") return { state: "missing", account: null };
  let raw: unknown;
  try {
    raw = JSON.parse(end.stdout);
  } catch {
    return { state: "unknown", account: null };
  }
  if (typeof raw !== "object" || raw === null) return { state: "unknown", account: null };
  const { loggedIn, email } = raw as { loggedIn?: unknown; email?: unknown };
  if (loggedIn === false) return { state: "out", account: null };
  if (loggedIn !== true) return { state: "unknown", account: null };
  return { state: "in", account: typeof email === "string" && email.length <= 200 && EMAIL.test(email) ? email : null };
}

/**
 * The wizard's line for one sign-in: what it says, and the command to run
 * when there is one. `tool` is "GitHub" or "Claude".
 */
export function signInLine(tool: string, signIn: SignIn, command: string): { text: string; command: string | null; ok: boolean } {
  if (signIn.state === "in") {
    return { text: signIn.account === null ? `${tool}: signed in.` : `${tool}: signed in as ${signIn.account}.`, command: null, ok: true };
  }
  if (signIn.state === "out") return { text: `${tool}: not signed in. Run in Terminal:`, command, ok: false };
  if (signIn.state === "missing") return { text: `${tool}: not installed. Install it, then run in Terminal:`, command, ok: false };
  return { text: `${tool}: could not tell. If it is not signed in, run in Terminal:`, command, ok: false };
}
