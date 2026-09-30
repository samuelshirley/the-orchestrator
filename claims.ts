// Area claims: before a build starts it names the files it will touch, and a
// file another open task already holds refuses the build. Pure — the server
// reads held claims from SQLite and hands them in.
import type { ProjectProfile } from "./profiles";

export interface Claim {
  taskId: string;
  projectId: string;
  /** Normalised: an exact file (`src/a.ts`) or a subtree (`src/app/**`). */
  path: string;
}

export interface Conflict {
  /** The path this build asked for, after widening. */
  path: string;
  heldBy: string;
  /** The other task's claim that overlaps it. */
  heldPath: string;
}

const SUBTREE = "/**";

/** Lockfiles a package manager rewrites beside the package.json it installs. */
export const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"] as const;

/**
 * One touch, as the agent wrote it, to a claim path — or why it is refused.
 * Exact files or `dir/**` subtrees only; no other wildcards, nothing outside
 * the repo, and never the whole repo.
 */
export function normalizeTouch(
  raw: string,
): { ok: true; path: string } | { ok: false; reason: string } {
  let path = raw.trim().replace(/\\/g, "/");
  while (path.startsWith("./")) path = path.slice(2);
  if (path.endsWith("/") && !path.endsWith(SUBTREE)) {
    path = `${path.replace(/\/+$/, "")}${SUBTREE}`;
  }
  path = path.replace(/\/{2,}/g, "/");
  if (path === "") return { ok: false, reason: "empty path" };
  if (path.startsWith("/")) return { ok: false, reason: `${raw}: use a repo-relative path` };
  if (path.split("/").includes("..")) return { ok: false, reason: `${raw}: leaves the repo` };
  const body = path.endsWith(SUBTREE) ? path.slice(0, -SUBTREE.length) : path;
  if (body === "" || body === "**" || body === "*") {
    return { ok: false, reason: `${raw}: claims the whole repo` };
  }
  if (/[*?[\]{}]/.test(body)) {
    return { ok: false, reason: `${raw}: only exact files or dir/** subtrees` };
  }
  return { ok: true, path };
}

function isSubtree(path: string): boolean {
  return path.endsWith(SUBTREE);
}

function root(path: string): string {
  return isSubtree(path) ? path.slice(0, -SUBTREE.length) : path;
}

/** Does `path` fall inside claim `claim` (a file equals it, a subtree contains it)? */
export function covers(claim: string, path: string): boolean {
  if (!isSubtree(claim)) return claim === path;
  const base = root(claim);
  return path === base || path.startsWith(`${base}/`);
}

/** Two claims overlap when either could name a file the other holds. */
export function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  if (isSubtree(a) && covers(a, root(b))) return true;
  if (isSubtree(b) && covers(b, root(a))) return true;
  return false;
}

/**
 * Widen touches the profile says are held whole: a claim anywhere inside a
 * shared subtree becomes the whole subtree, and a claim on one side of a
 * mirror is a claim on both. Deduplicated, order kept.
 */
export function expandClaims(
  paths: readonly string[],
  profile: Pick<ProjectProfile, "sharedPaths" | "mirrors">,
): string[] {
  const out: string[] = [];
  const add = (path: string) => {
    const shared = profile.sharedPaths.find(
      (candidate) => isSubtree(candidate) && covers(candidate, root(path)),
    );
    const claim = shared ?? path;
    if (!out.includes(claim)) out.push(claim);
  };
  for (const path of paths) {
    add(path);
    // npm install rewrites the lockfile beside package.json, so claiming one
    // claims the other. A root lockfile shared by nested packages is not
    // implied: claim it explicitly. Generated files are never implied.
    if (!isSubtree(path) && (path === "package.json" || path.endsWith("/package.json"))) {
      const dir = path.slice(0, -"package.json".length);
      for (const lockfile of LOCKFILES) add(`${dir}${lockfile}`);
    }
  }
  for (const path of [...out]) {
    for (const [left, right] of profile.mirrors) {
      if (overlaps(left, path)) add(right);
      if (overlaps(right, path)) add(left);
    }
  }
  return out;
}

/** A changed file's path as git or GitHub reports it, spelled as claims are. */
function normalizeFile(raw: string): string {
  let path = raw.trim().replace(/\\/g, "/");
  while (path.startsWith("./")) path = path.slice(2);
  return path;
}

/**
 * The files a branch changed that the task's claims do not cover, widened
 * exactly as planClaims widens them (shared paths, mirrors, lockfiles).
 * Deduplicated, input order kept. No claims: every file is outside.
 */
export function outsideClaims(
  files: readonly string[],
  claims: readonly string[],
  profile: Pick<ProjectProfile, "sharedPaths" | "mirrors">,
): string[] {
  const held = expandClaims(claims, profile);
  const out: string[] = [];
  for (const raw of files) {
    const file = normalizeFile(raw);
    if (file === "" || out.includes(file)) continue;
    if (!held.some((claim) => covers(claim, file))) out.push(file);
  }
  return out;
}

/**
 * Why a hand-off (open_pr, ready_for_review, land) refuses a branch with
 * files outside its task's claims, and the two ways to fix it. Claims are
 * never widened automatically: that would skip the overlap check.
 */
export function outsideClaimsRefusal(files: readonly string[], limit = 20): string {
  const shown = files.slice(0, limit);
  const more = files.length - shown.length;
  return [
    `Refused: the branch changes ${files.length} file(s) outside the task's claims:`,
    ...shown.map((file) => `- ${file}`),
    ...(more > 0 ? [`- …and ${more} more`] : []),
    "Fix it one of two ways, then call this again:",
    "- Widen the claims: build(touches: every file or dir/** the task changes, old and new paths, claimOnly: true). That replaces the task's claims and re-checks overlaps with other tasks' claims.",
    "- Or drop those changes from the branch: revert them in the worktree and commit.",
    "Nothing is widened automatically.",
  ].join("\n");
}

/** Every held claim, from another task in the same project, that this build would cross. */
export function findConflicts({
  taskId,
  projectId,
  paths,
  held,
}: {
  taskId: string;
  projectId: string;
  paths: readonly string[];
  held: readonly Claim[];
}): Conflict[] {
  const conflicts: Conflict[] = [];
  for (const path of paths) {
    for (const claim of held) {
      if (claim.taskId === taskId || claim.projectId !== projectId) continue;
      if (overlaps(path, claim.path)) {
        conflicts.push({ path, heldBy: claim.taskId, heldPath: claim.path });
      }
    }
  }
  return conflicts;
}

/**
 * The whole claim decision for one build: normalise, widen, and check against
 * what other tasks hold. `ok: false` carries every reason at once.
 */
export function planClaims({
  taskId,
  projectId,
  touches,
  held,
  profile,
}: {
  taskId: string;
  projectId: string;
  touches: readonly string[];
  held: readonly Claim[];
  profile: Pick<ProjectProfile, "sharedPaths" | "mirrors">;
}):
  | { ok: true; paths: string[] }
  | { ok: false; invalid: string[]; conflicts: Conflict[] } {
  const invalid: string[] = [];
  const normalized: string[] = [];
  for (const touch of touches) {
    const result = normalizeTouch(touch);
    if (result.ok) normalized.push(result.path);
    else invalid.push(result.reason);
  }
  if (touches.length === 0) invalid.push("touches is empty: name every file or dir/** you will change");
  const paths = expandClaims(normalized, profile);
  const conflicts = findConflicts({ taskId, projectId, paths, held });
  if (invalid.length > 0 || conflicts.length > 0) {
    return { ok: false, invalid, conflicts };
  }
  return { ok: true, paths };
}

/** Meta key of a build refused on claims, waiting for them to free. */
export function claimWaitKey(taskId: string): string {
  return `claim_wait:${taskId}`;
}

export interface ClaimWait {
  taskId: string;
  projectId: string;
  touches: readonly string[];
  /** The tasks that held what it asked for when it was refused. */
  holders?: readonly string[];
  since?: number;
}

/**
 * The waiting builds that would now get their claims: their touches, widened
 * exactly as planClaims widens them, no longer cross any claim another task
 * holds. Touches that are invalid never wake: a build would refuse them again.
 */
export function claimWaitsToWake(
  waits: readonly Pick<ClaimWait, "taskId" | "projectId" | "touches">[],
  held: readonly Claim[],
  profileFor: (projectId: string) => Pick<ProjectProfile, "sharedPaths" | "mirrors">,
): string[] {
  return waits
    .filter((wait) =>
      planClaims({
        taskId: wait.taskId,
        projectId: wait.projectId,
        touches: wait.touches,
        held,
        profile: profileFor(wait.projectId),
      }).ok,
    )
    .map((wait) => wait.taskId);
}
