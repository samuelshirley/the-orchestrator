// Repo-specific worktrees: every task's worktree lives inside its own repo at
// `<repo>/.claude/worktrees/<slug>`, created and removed by this plugin (bb
// does not clean up a worktree it adopted). Pure naming and safety rules; the
// host worker runs the git commands.

import { couldCopyEnv } from "./profiles.js";

export const WORKTREES_DIR = ".claude/worktrees";

/** A filesystem- and branch-safe slug from a task title, unique among `taken`. */
export function taskSlug(title: string, taken: ReadonlySet<string>): string {
  const base =
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "task";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function worktreePathFor(repoPath: string, slug: string): string {
  return `${repoPath.replace(/\/+$/, "")}/${WORKTREES_DIR}/${slug}`;
}

/** Is `worktreePath` exactly one slug under this repo's worktree directory? */
export function isRepoWorktreePath(repoPath: string, worktreePath: string): boolean {
  const prefix = `${repoPath.replace(/\/+$/, "")}/${WORKTREES_DIR}/`;
  if (!worktreePath.startsWith(prefix)) return false;
  const slug = worktreePath.slice(prefix.length);
  return /^[a-z0-9][a-z0-9-]*$/.test(slug);
}

/** A git branch name the agent asked for, or `task/<slug>` when it asked for none. */
export function branchFor(slug: string, requested: string | null | undefined): string {
  const wanted = requested?.trim() ?? "";
  if (
    wanted !== "" &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(wanted) &&
    !wanted.includes("..") &&
    !wanted.endsWith("/") &&
    !wanted.endsWith(".lock") &&
    !["main", "master", "HEAD"].includes(wanted)
  ) {
    return wanted;
  }
  return `task/${slug}`;
}

/** Patterns from a `.worktreeinclude` file: gitignore syntax, comments and negations dropped. */
export function parseWorktreeInclude(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("!"));
}

/**
 * The patterns a new worktree is copied from: the profile's list, then the
 * repo's own `.worktreeinclude`, each once. For a productionEnv profile every
 * pattern that could copy an env file is dropped, whichever list named it, so
 * a repo's file cannot bring back what the profile may never copy.
 */
export function mergeWorktreeInclude(
  fromProfile: readonly string[],
  fromRepo: readonly string[],
  productionEnv: boolean,
): string[] {
  return [...new Set([...fromProfile, ...fromRepo])].filter((pattern) => !productionEnv || !couldCopyEnv(pattern));
}

/**
 * A pattern split into the directory to list and a matcher for the names in
 * it. One directory level only (`.env*`, `mobile/.env*`,
 * `.claude/settings.local.json`); anything that would climb out of the repo
 * or recurse is rejected.
 */
export function includeMatcher(
  pattern: string,
): { dir: string; matches: (name: string) => boolean } | null {
  const clean = pattern.replace(/^\/+/, "");
  if (clean === "" || clean.includes("**") || clean.split("/").includes("..")) return null;
  const slash = clean.lastIndexOf("/");
  const dir = slash === -1 ? "" : clean.slice(0, slash);
  const name = slash === -1 ? clean : clean.slice(slash + 1);
  if (name === "" || /[*?[]/.test(dir)) return null;
  const regex = new RegExp(
    `^${name.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`,
  );
  return { dir, matches: (candidate) => regex.test(candidate) };
}

export interface WorktreeInspection {
  exists: boolean;
  dirty: boolean;
  /** Commits not on the branch's upstream (or, with no upstream, not on the base). */
  unpushed: number;
}

/**
 * Remove only a worktree that holds nothing that exists nowhere else. A
 * recorded folder that no longer exists is `gone` (its record is stale) only
 * while the repo itself is there: a missing repo (an unmounted disk) proves
 * nothing about the worktree.
 */
export function cleanupDecision(
  inspection: WorktreeInspection,
  repo: { exists: boolean },
): { remove: true } | { remove: false; gone: boolean; reason: string | null } {
  if (!inspection.exists) return { remove: false, gone: repo.exists, reason: null };
  if (inspection.dirty) {
    return { remove: false, gone: false, reason: "Worktree has uncommitted changes: kept." };
  }
  if (inspection.unpushed > 0) {
    return {
      remove: false,
      gone: false,
      reason: `Worktree has ${inspection.unpushed} unpushed commit${inspection.unpushed === 1 ? "" : "s"}: kept.`,
    };
  }
  return { remove: true };
}

/**
 * What a task's worktree record becomes after a cleanup attempt: cleared once
 * the worktree was removed or is already gone, else kept with the reason.
 */
export function recordAfterCleanup(
  worktreePath: string,
  result: { removed: boolean; gone: boolean; reason: string | null },
): { worktreePath: string | null; worktreeNote: string | null } {
  if (result.removed || result.gone) return { worktreePath: null, worktreeNote: null };
  return { worktreePath, worktreeNote: result.reason };
}

/**
 * Untracked entries of `git status --porcelain` that may be symlinks: `?? path`
 * without a trailing slash (git lists an untracked directory as `dir/`). The
 * host lstat's these and passes the symlinks to porcelainDirty.
 */
export function untrackedPaths(status: string): string[] {
  return status
    .split("\n")
    .filter((line) => line.startsWith("?? ") && !line.endsWith("/"))
    .map((line) => line.slice(3));
}

/**
 * Does `git status --porcelain` show anything that exists only in the
 * worktree? A deletion of a tracked file does not: its content is still in
 * HEAD. A removal aborted midway (the plugin reloading under `git worktree
 * remove`) leaves exactly that, tracked files gone and nothing else, and
 * calling it dirty kept those worktrees forever. Nor does an untracked
 * symlink (`symlinks`, from untrackedPaths): builders link node_modules to
 * the main checkout's, and the link holds nothing of the worktree's own.
 * Safe only together with the unpushed check in cleanupDecision: HEAD itself
 * must be pushed or on the base. Untracked files and directories and any
 * modification still count.
 */
export function porcelainDirty(status: string, symlinks: ReadonlySet<string> = new Set()): boolean {
  return status
    .split("\n")
    .filter((line) => line.trim() !== "")
    .some((line) => !/^( D|D |DD) /.test(line) && !(line.startsWith("?? ") && symlinks.has(line.slice(3))));
}

/**
 * What the periodic sweep hands to removeWorktree for one repo: closed tasks
 * that still record a worktree, and directories under <repo>/.claude/worktrees
 * no task records (an interrupted cleanup, a task deleted with its worktree
 * kept). Orphans only while no open task of the project is preparing or
 * running a build, which may be creating one right now. `tasks` are the
 * project's, open and closed; removal still goes through cleanupDecision
 * (tasks) or orphanDecision (orphans).
 */
export function sweepTargets(args: {
  tasks: readonly {
    id: string;
    worktreePath: string | null;
    closedAt: number | null;
    buildState: string;
  }[];
  dirSlugs: readonly string[];
  repoPath: string;
}): { tasks: string[]; orphans: string[] } {
  const { tasks, dirSlugs, repoPath } = args;
  const closed = tasks.filter((task) => task.closedAt !== null && task.worktreePath !== null).map((task) => task.id);
  const building = tasks.some(
    (task) => task.closedAt === null && (task.buildState === "preparing" || task.buildState === "running"),
  );
  if (building) return { tasks: closed, orphans: [] };
  const recorded = new Set(tasks.map((task) => task.worktreePath).filter((path): path is string => path !== null));
  const orphans = dirSlugs
    .map((slug) => worktreePathFor(repoPath, slug))
    .filter((path) => isRepoWorktreePath(repoPath, path) && !recorded.has(path));
  return { tasks: closed, orphans };
}

/**
 * The commits of HEAD that are on no main: `git cherry <ref> HEAD` output per
 * available ref (the local default branch, origin/<default>). A commit is
 * landed on a ref when cherry marks it "-" (patch-equivalent) or leaves it out
 * (already contained); unlanded means "+" in every ref's output. Null when
 * there is no ref to compare with, which must keep the worktree.
 */
export function unlandedCommits(cherryOutputs: readonly string[]): string[] | null {
  if (cherryOutputs.length === 0) return null;
  const plus = cherryOutputs.map(
    (output) =>
      new Set(
        output
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.startsWith("+ "))
          .map((line) => line.slice(2).trim()),
      ),
  );
  const [first, ...rest] = plus;
  return [...(first ?? [])].filter((sha) => rest.every((set) => set.has(sha)));
}

/** A registered orphan touched within this window may belong to work in progress. */
export const ORPHAN_ACTIVE_MS = 60 * 60_000;

/**
 * What the host found in a folder under <repo>/.claude/worktrees that no task
 * records. `lastActiveAt`: the latest mtime of its git admin index or HEAD and
 * of the folder itself.
 */
export type OrphanInspection =
  | { registered: false; empty: boolean }
  | {
      registered: true;
      dirty: boolean;
      /** Commits of HEAD on no main (unlandedCommits); null with no main to compare with. */
      unlanded: number | null;
      /** A process has its cwd inside it. */
      inUse: boolean;
      lastActiveAt: number;
      now: number;
    };

/**
 * An orphan goes only when it holds nothing: an unregistered folder with no
 * files in it, or a registered worktree that is clean, fully landed on main,
 * not in use and idle for an hour. Its branch is left alone.
 */
export function orphanDecision(
  inspection: OrphanInspection,
): { action: "remove-empty" } | { action: "remove-worktree" } | { action: "keep"; reason: string } {
  if (!inspection.registered) {
    return inspection.empty
      ? { action: "remove-empty" }
      : { action: "keep", reason: "Not a git worktree and not empty: kept." };
  }
  if (inspection.dirty) return { action: "keep", reason: "Uncommitted changes: kept." };
  if (inspection.unlanded === null) return { action: "keep", reason: "No main to compare with: kept." };
  if (inspection.unlanded > 0) {
    return {
      action: "keep",
      reason: `${inspection.unlanded} commit${inspection.unlanded === 1 ? "" : "s"} not on main: kept.`,
    };
  }
  if (inspection.inUse) return { action: "keep", reason: "In use by a running process: kept." };
  if (inspection.now - inspection.lastActiveAt < ORPHAN_ACTIVE_MS) {
    return { action: "keep", reason: "Active in the last hour: kept." };
  }
  return { action: "remove-worktree" };
}

/**
 * The environment a worktree's setup commands run in: the host's own, minus
 * the npm settings that leak in when the host was itself started by npm.
 * npm >= 11.16 refuses `npm ci` in a project when `npm_config_allow_scripts`
 * arrives from the environment (EALLOWSCRIPTS), and the host's lifecycle and
 * package variables describe the host, not the worktree's project.
 */
export function setupEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (/^npm_(config|lifecycle|package)_/i.test(key)) continue;
    if (/^(npm_command|npm_execpath|npm_node_execpath|init_cwd)$/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * What a fresh build (reuse=false) found left over from an earlier attempt,
 * gathered by the host with git. `current` is the worktree's branch, null
 * when the folder is not a git worktree of its own; `ahead` counts commits
 * past the base, null when git could not count them.
 */
export type LeftoverFacts =
  | { kind: "worktree"; current: string | null; dirty: boolean; ahead: number | null }
  | { kind: "branch"; checkedOut: boolean; ahead: number | null };

/**
 * A leftover of a failed prepare holds nothing of its own, so a fresh build
 * may take it over: a worktree on the task's branch, clean, with no commits
 * past the base is reused; such a branch checked out nowhere is reset to the
 * base (`worktree add -B`). Anything else is refused with the reason.
 */
export function leftoverDecision(
  facts: LeftoverFacts,
  names: { worktreePath: string; branch: string; baseRef: string },
): { action: "reuse-worktree" } | { action: "reset-branch" } | { action: "refuse"; reason: string } {
  const refuse = (why: string) => ({
    action: "refuse" as const,
    reason:
      facts.kind === "worktree"
        ? `${names.worktreePath} already exists: it ${why}.`
        : `Branch ${names.branch} already exists: it ${why}.`,
  });
  if (facts.kind === "worktree") {
    if (facts.current === null) return refuse("is not a git worktree");
    if (facts.current !== names.branch) return refuse(`is on ${facts.current}, not ${names.branch}`);
    if (facts.dirty) return refuse("has uncommitted changes");
  } else if (facts.checkedOut) {
    return refuse("is checked out in another worktree");
  }
  if (facts.ahead === null) return refuse(`cannot be compared with ${names.baseRef}`);
  if (facts.ahead > 0) return refuse(`has ${facts.ahead} commit${facts.ahead === 1 ? "" : "s"} of its own`);
  return facts.kind === "worktree" ? { action: "reuse-worktree" } : { action: "reset-branch" };
}

/** Is `branch` checked out in any worktree, per `git worktree list --porcelain`? */
export function branchCheckedOut(worktreeList: string, branch: string): boolean {
  return worktreeList.split("\n").some((line) => line.trim() === `branch refs/heads/${branch}`);
}

/**
 * The git commands (argv, run in the repo) that undo a prepare that failed
 * after creating things: only what this call created, the worktree first.
 * A worktree or branch that was there before is never touched.
 */
export function cleanupAfterFailedPrepare(
  created: { createdWorktree: boolean; createdBranch: boolean },
  names: { worktreePath: string; branch: string },
): string[][] {
  return [
    ...(created.createdWorktree ? [["worktree", "remove", "--force", names.worktreePath]] : []),
    ...(created.createdBranch ? [["branch", "-D", names.branch]] : []),
  ];
}
