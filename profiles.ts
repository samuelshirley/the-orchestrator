// Per-project profiles: what "checked" means in each repo, what a PR must
// prove before it reaches the owner, and which paths are held whole. Data only —
// every rule that reads a profile lives in a tested module (claims.ts,
// validation.ts, prompts.ts). Only the built-in profiles are here: the
// profiles for the owner's own repos live in the local config file on the
// machine (localconfig.ts), never in this repo.

export interface TestRule {
  /** An exact path or a `dir/**` subtree, matched against the PR's files. */
  pattern: string;
  test: string;
}

export interface ProjectProfile {
  key: string;
  /** Matched case-insensitively against the bb project name. */
  names: readonly string[];
  /** Matched against the `owner/repo` slug of the project's git remote. */
  remotes: readonly string[];
  /** Commands the build agent runs, and reports, before it finishes. */
  checks: readonly string[];
  /** "full": CI + preview + sticky comments gate the PR. "none": no CI. */
  ci: "full" | "none";
  /** Sticky PR comment markers; null when the repo posts none. */
  markers: {
    preview: string | null;
    e2e: string | null;
    ios: string | null;
  };
  /** Only PRs touching these paths must carry a passing iOS comment. */
  iosPaths: readonly string[];
  /** Added LAST, once everything else is green. Null when the repo has none. */
  aiTestsLabel: string | null;
  /**
   * Text a passing E2E or iOS sticky comment built from the head carries when
   * the AI-tests run ran: regex sources, compiled with the "iu" flags. Empty
   * when the repo has no AI run (then a label on the PR proves nothing).
   */
  aiRanPatterns: readonly string[];
  /** Held by one task at a time, as a whole: a claim inside widens to all of it. */
  sharedPaths: readonly string[];
  /** Pairs that are copies of each other: a claim on one is a claim on both. */
  mirrors: readonly (readonly [string, string])[];
  /** "worktree": build() makes a branch. "flux-prompts": nothing builds; the task drives Flux in the owner's Chrome. */
  build: "worktree" | "flux-prompts";
  /**
   * How finished work reaches the default branch. "pr": pushed, PR, the owner
   * merges (merge = deploy). "main": a local app in development — the task
   * fast-forwards the default branch itself with land(), no PR. Having a git
   * remote never makes a "main" profile PR-based.
   */
  land: "pr" | "main";
  /**
   * land: "main" only: the git remote the default branch is pushed to after
   * land(), as a backup nothing reads from. Never forced.
   */
  backup: string | null;
  /**
   * Run in the main checkout after land(), in order, as argv (no shell), so
   * the change is live. The last one may restart this plugin: it runs detached.
   */
  afterLand: readonly (readonly string[])[];
  /**
   * Untracked files copied from the main checkout into a new worktree
   * (gitignore-style, one directory level, e.g. `.claude/settings.local.json`).
   * A productionEnv profile never includes .env files. The
   * profile is the home for a project's includes and setup; they are never
   * committed to the app repo (plumbing.ts refuses them in a PR). A repo's own
   * .worktreeinclude, if one exists, still adds to these, except that for a
   * productionEnv profile its env patterns are dropped too (worktrees.ts
   * mergeWorktreeInclude); The Orchestrator never commits one.
   */
  worktreeInclude: readonly string[];
  /**
   * True when the repo's untracked .env holds production secrets; such a
   * profile may never copy .env files into a build worktree, from its own
   * list or from the repo's .worktreeinclude.
   */
  productionEnv: boolean;
  /** Run in a new worktree, in order, as argv (no shell), before the build starts. */
  setup: readonly (readonly string[])[];
  testRules: readonly TestRule[];
  /** One-line rules every brief in this project repeats. */
  rules: readonly string[];
}

const ORCHESTRATOR: ProjectProfile = {
  key: "the-orchestrator",
  names: ["the-orchestrator", "the orchestrator"],
  remotes: [],
  checks: ["npm test", "npm run typecheck", "bb plugin build"],
  ci: "none",
  markers: { preview: null, e2e: null, ios: null },
  iosPaths: [],
  aiTestsLabel: null,
  aiRanPatterns: [],
  sharedPaths: ["CLAUDE.md", "README.md"],
  mirrors: [],
  build: "worktree",
  land: "main",
  backup: "origin",
  afterLand: [
    ["bb", "plugin", "build"],
    ["bb", "plugin", "reload", "the-orchestrator"],
  ],
  worktreeInclude: [],
  productionEnv: false,
  setup: [["npm", "ci", "--include=dev", "--ignore-scripts", "--no-audit", "--no-fund"]],
  testRules: [{ pattern: "app.tsx", test: "The Orchestrator page, once land has rebuilt and reloaded it" }],
  rules: [
    "Keep policy in the pure, tested modules; run `npm test` and `npm run typecheck`.",
    "A local app in development: no PRs. Quick fixes land straight on main with land().",
  ],
};

export const DEFAULT_PROFILE: ProjectProfile = {
  key: "default",
  names: [],
  remotes: [],
  checks: [],
  ci: "none",
  markers: { preview: null, e2e: null, ios: null },
  iosPaths: [],
  aiTestsLabel: null,
  aiRanPatterns: [],
  sharedPaths: ["CLAUDE.md"],
  mirrors: [],
  build: "worktree",
  land: "pr",
  backup: null,
  afterLand: [],
  worktreeInclude: [],
  productionEnv: false,
  setup: [],
  testRules: [],
  rules: ["Follow the repo's CLAUDE.md or README if it has one."],
};

/** The built-in profiles. The Orchestrator's own matches by name only. */
export const PROFILES: readonly ProjectProfile[] = [ORCHESTRATOR];

/** `owner/repo`, lower-cased, from any GitHub remote URL form; null otherwise. */
export function githubSlug(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const match = remote.trim().match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * The profile for a project: `local` (the local config's profiles) first, then
 * the built-in ones, each by remote slug and then by name; else the default.
 */
export function profileFor(
  project: { name: string; gitRemoteUrl?: string | null },
  local: readonly ProjectProfile[] = [],
): ProjectProfile {
  const slug = githubSlug(project.gitRemoteUrl);
  const name = project.name.trim().toLowerCase();
  const match = (profiles: readonly ProjectProfile[]) =>
    profiles.find((profile) => slug !== null && profile.remotes.some((remote) => remote.toLowerCase() === slug)) ??
    profiles.find((profile) => profile.names.some((candidate) => candidate.toLowerCase() === name));
  return match(local) ?? match(PROFILES) ?? DEFAULT_PROFILE;
}

/**
 * Whether an include pattern could copy an env file (`.env`, `.env.local`,
 * `mobile/.env*`): its file name starts with `.env`, or is a glob whose fixed
 * start does not rule that out (`*`, `.e*`, `[.]env`). Wider than it must be
 * on purpose: a production-env profile lists exact files.
 */
export function couldCopyEnv(pattern: string): boolean {
  const name = pattern.trim().slice(pattern.trim().lastIndexOf("/") + 1);
  const wildcard = name.search(/[*?[]/);
  if (wildcard === -1) return name.startsWith(".env");
  const fixed = name.slice(0, wildcard);
  return fixed.startsWith(".env") || ".env".startsWith(fixed);
}

/**
 * The untracked files a new worktree gets from the main checkout. A
 * productionEnv profile never copies an .env file, whatever its list says:
 * the local config refuses such a profile when it loads (localconfig.ts), and
 * this holds at build time too. The repo's own .worktreeinclude is filtered
 * the same way where the lists are merged (worktrees.ts mergeWorktreeInclude).
 */
export function worktreeIncludeOf(profile: Pick<ProjectProfile, "worktreeInclude" | "productionEnv">): string[] {
  return profile.worktreeInclude.filter((pattern) => !profile.productionEnv || !couldCopyEnv(pattern));
}

/**
 * The `git push` argv that backs up `target` after a land, or null when the
 * profile has no backup. Only land: "main" profiles have one; never forced.
 */
export function backupPush(profile: ProjectProfile, target: string): readonly string[] | null {
  if (profile.land !== "main" || profile.backup === null) return null;
  return ["push", profile.backup, `${target}:${target}`];
}

/**
 * Where a new build branches from. PR-based projects with a remote start
 * from `origin/<default>`; a land: "main" project always starts from its
 * local default branch, which land() fast-forwards: its remote is a backup.
 */
export function buildBaseRef(profile: ProjectProfile, hasRemote: boolean, defaultBranch: string): string {
  return profile.land === "pr" && hasRemote ? `origin/${defaultBranch}` : defaultBranch;
}
