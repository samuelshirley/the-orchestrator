import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  branchCheckedOut,
  branchFor,
  cleanupAfterFailedPrepare,
  cleanupDecision,
  includeMatcher,
  isRepoWorktreePath,
  leftoverDecision,
  mergeWorktreeInclude,
  ORPHAN_ACTIVE_MS,
  orphanDecision,
  parseWorktreeInclude,
  porcelainDirty,
  recordAfterCleanup,
  setupEnv,
  sweepTargets,
  taskSlug,
  unlandedCommits,
  untrackedPaths,
  worktreePathFor,
} from "./worktrees";

describe("worktree naming", () => {
  it("slugs a title and stays unique within the repo", () => {
    expect(taskSlug("Subscription tiers: $3.50 / 3 months!", new Set())).toBe("subscription-tiers-3-50-3-months");
    expect(taskSlug("Tiers", new Set(["tiers", "tiers-2"]))).toBe("tiers-3");
    expect(taskSlug("!!!", new Set())).toBe("task");
  });

  it("puts every worktree inside its own repo's .claude/worktrees", () => {
    const path = worktreePathFor("/Users/s/Github/Acme Board/", "flux-transmitter");
    expect(path).toBe("/Users/s/Github/Acme Board/.claude/worktrees/flux-transmitter");
    expect(isRepoWorktreePath("/Users/s/Github/Acme Board", path)).toBe(true);
    expect(isRepoWorktreePath("/Users/s/Github/AcmeGoods", "/Users/s/Github/AcmeGoods/.claude/worktrees/../../x")).toBe(false);
    expect(isRepoWorktreePath("/Users/s/Github/AcmeGoods", "/Users/s/.bb/worktrees/x")).toBe(false);
  });

  it("uses the requested branch when it is sane, else task/<slug>", () => {
    expect(branchFor("tiers", "feat/subscription-tiers")).toBe("feat/subscription-tiers");
    expect(branchFor("tiers", undefined)).toBe("task/tiers");
    for (const bad of ["main", "master", "-x", "a..b", "x.lock", "a b"]) {
      expect(branchFor("tiers", bad), bad).toBe("task/tiers");
    }
  });
});

describe(".worktreeinclude", () => {
  it("parses patterns, dropping comments and negations", () => {
    expect(parseWorktreeInclude("# env\n.env*\n!.env.example\n\nmobile/.env*\n")).toEqual([".env*", "mobile/.env*"]);
  });

  it("matches one directory level and refuses recursion or escape", () => {
    const root = includeMatcher(".env*");
    expect(root?.dir).toBe("");
    expect(root?.matches(".env.local")).toBe(true);
    expect(root?.matches("env")).toBe(false);
    const mobile = includeMatcher("mobile/.env*");
    expect(mobile?.dir).toBe("mobile");
    expect(includeMatcher(".claude/settings.local.json")?.matches("settings.local.json")).toBe(true);
    expect(includeMatcher("**/.env")).toBeNull();
    expect(includeMatcher("../secrets")).toBeNull();
  });

  it("drops every env pattern for a productionEnv profile, from the repo's file and the profile's list", () => {
    const fromRepo = [".env*", "mobile/.env.local", ".claude/settings.local.json"];
    expect(mergeWorktreeInclude([".npmrc"], fromRepo, true)).toEqual([".npmrc", ".claude/settings.local.json"]);
    expect(mergeWorktreeInclude([".npmrc", ".env.local", "mobile/.env*"], fromRepo, true)).toEqual([
      ".npmrc",
      ".claude/settings.local.json",
    ]);
    expect(mergeWorktreeInclude([".env"], [], true)).toEqual([]);
  });

  it("keeps everything without productionEnv: each pattern once, the profile's first", () => {
    expect(
      mergeWorktreeInclude(
        [".npmrc", ".env*"],
        [".env*", "mobile/.env.local", ".npmrc", ".claude/settings.local.json"],
        false,
      ),
    ).toEqual([".npmrc", ".env*", "mobile/.env.local", ".claude/settings.local.json"]);
  });

  it("drops wide globs that could match an env file for a productionEnv profile", () => {
    expect(mergeWorktreeInclude(["*"], [".e*", "mobile/*", ".npmrc"], true)).toEqual([".npmrc"]);
    expect(mergeWorktreeInclude(["*"], [".e*", ".npmrc"], false)).toEqual(["*", ".e*", ".npmrc"]);
  });
});

describe("cleanupDecision", () => {
  const repo = { exists: true };
  it("removes only a clean, fully pushed worktree", () => {
    expect(cleanupDecision({ exists: true, dirty: false, unpushed: 0 }, repo)).toEqual({ remove: true });
    expect(cleanupDecision({ exists: true, dirty: true, unpushed: 0 }, repo)).toMatchObject({ remove: false, gone: false });
    expect(cleanupDecision({ exists: true, dirty: false, unpushed: 2 }, repo)).toEqual({
      remove: false,
      gone: false,
      reason: "Worktree has 2 unpushed commits: kept.",
    });
  });

  it("a missing folder is gone only while its repo exists", () => {
    expect(cleanupDecision({ exists: false, dirty: false, unpushed: 0 }, repo)).toEqual({ remove: false, gone: true, reason: null });
    expect(cleanupDecision({ exists: false, dirty: false, unpushed: 0 }, { exists: false })).toEqual({
      remove: false,
      gone: false,
      reason: null,
    });
  });
});

describe("recordAfterCleanup", () => {
  const path = "/r/.claude/worktrees/x";
  it("clears the record once the worktree is removed or already gone", () => {
    expect(recordAfterCleanup(path, { removed: true, gone: false, reason: null })).toEqual({ worktreePath: null, worktreeNote: null });
    expect(recordAfterCleanup(path, { removed: false, gone: true, reason: null })).toEqual({ worktreePath: null, worktreeNote: null });
  });

  it("keeps the record with the reason otherwise", () => {
    expect(recordAfterCleanup(path, { removed: false, gone: false, reason: "Worktree has uncommitted changes: kept." })).toEqual({
      worktreePath: path,
      worktreeNote: "Worktree has uncommitted changes: kept.",
    });
    // A missing repo: nothing known, the record stays.
    expect(recordAfterCleanup(path, { removed: false, gone: false, reason: null })).toEqual({ worktreePath: path, worktreeNote: null });
  });
});

describe("porcelainDirty", () => {
  it("a half-removed worktree (tracked files deleted, nothing else) holds nothing of its own", () => {
    expect(porcelainDirty("")).toBe(false);
    expect(porcelainDirty(" D app.tsx\n D server.ts\n")).toBe(false);
    expect(porcelainDirty("D  staged-delete.ts\nDD both-deleted.ts")).toBe(false);
  });

  it("anything else is dirty: untracked, modified, added, renamed", () => {
    expect(porcelainDirty(" D a.ts\n?? notes.md")).toBe(true);
    expect(porcelainDirty(" M a.ts")).toBe(true);
    expect(porcelainDirty("M  a.ts")).toBe(true);
    expect(porcelainDirty("A  new.ts")).toBe(true);
    expect(porcelainDirty("R  a.ts -> b.ts")).toBe(true);
    expect(porcelainDirty("UD conflict.ts")).toBe(true);
    expect(porcelainDirty("AD added-then-deleted.ts")).toBe(true);
  });

  it("an untracked symlink holds nothing of the worktree's own; untracked files and dirs still do", () => {
    const links = new Set(["node_modules"]);
    expect(porcelainDirty("?? node_modules", links)).toBe(false);
    expect(porcelainDirty("?? node_modules\n D gone.ts", links)).toBe(false);
    expect(porcelainDirty("?? node_modules")).toBe(true);
    expect(porcelainDirty("?? node_modules\n?? notes.md", links)).toBe(true);
    expect(porcelainDirty("?? node_modules\n M a.ts", links)).toBe(true);
    // Only untracked entries: a modified path of the same name is still dirty.
    expect(porcelainDirty(" M node_modules", links)).toBe(true);
  });

  it("offers only untracked non-directory entries as symlink candidates", () => {
    expect(untrackedPaths("?? node_modules\n?? dist/\n M a.ts\n?? notes.md\n")).toEqual(["node_modules", "notes.md"]);
  });
});

describe("unlandedCommits", () => {
  it("one ref: the commits cherry marks +", () => {
    expect(unlandedCommits(["+ aaa\n- bbb\n+ ccc\n"])).toEqual(["aaa", "ccc"]);
    expect(unlandedCommits([""])).toEqual([]);
  });

  it("two refs: unlanded only when + in both", () => {
    expect(unlandedCommits(["+ aaa\n+ bbb", "+ aaa\n+ bbb"])).toEqual(["aaa", "bbb"]);
    // Patch-equivalent on origin/main, or already contained there (left out): landed.
    expect(unlandedCommits(["+ aaa\n+ bbb", "- aaa\n+ bbb"])).toEqual(["bbb"]);
    expect(unlandedCommits(["+ aaa", ""])).toEqual([]);
    expect(unlandedCommits(["", "+ aaa"])).toEqual([]);
  });

  it("no ref to compare with: null, never 'all landed'", () => {
    expect(unlandedCommits([])).toBeNull();
  });
});

describe("orphanDecision", () => {
  const now = 10 * ORPHAN_ACTIVE_MS;
  const idle = { registered: true as const, dirty: false, unlanded: 0, inUse: false, lastActiveAt: now - ORPHAN_ACTIVE_MS, now };

  it("an unregistered folder goes only when it holds no files", () => {
    expect(orphanDecision({ registered: false, empty: true })).toEqual({ action: "remove-empty" });
    expect(orphanDecision({ registered: false, empty: false })).toEqual({
      action: "keep",
      reason: "Not a git worktree and not empty: kept.",
    });
  });

  it("a clean, landed, idle worktree goes", () => {
    expect(orphanDecision(idle)).toEqual({ action: "remove-worktree" });
  });

  it("keeps a worktree with anything of its own or in use", () => {
    expect(orphanDecision({ ...idle, dirty: true })).toEqual({ action: "keep", reason: "Uncommitted changes: kept." });
    expect(orphanDecision({ ...idle, unlanded: 1 })).toEqual({ action: "keep", reason: "1 commit not on main: kept." });
    expect(orphanDecision({ ...idle, unlanded: 3 })).toEqual({ action: "keep", reason: "3 commits not on main: kept." });
    expect(orphanDecision({ ...idle, unlanded: null })).toEqual({ action: "keep", reason: "No main to compare with: kept." });
    expect(orphanDecision({ ...idle, inUse: true })).toEqual({ action: "keep", reason: "In use by a running process: kept." });
    expect(orphanDecision({ ...idle, lastActiveAt: now - ORPHAN_ACTIVE_MS + 1 })).toEqual({
      action: "keep",
      reason: "Active in the last hour: kept.",
    });
  });
});

describe("sweepTargets", () => {
  const repo = "/r";
  const t = (id: string, overrides: Partial<{ worktreePath: string | null; closedAt: number | null; buildState: string }> = {}) => ({
    id,
    worktreePath: null,
    closedAt: null,
    buildState: "none",
    ...overrides,
  });

  it("sweeps closed tasks that still record a worktree, and directories no task records", () => {
    const result = sweepTargets({
      repoPath: repo,
      dirSlugs: ["done", "open", "orphan", "Bad Name"],
      tasks: [
        t("closed", { worktreePath: "/r/.claude/worktrees/done", closedAt: 1 }),
        t("closed-clean", { closedAt: 1 }),
        t("open", { worktreePath: "/r/.claude/worktrees/open" }),
      ],
    });
    expect(result).toEqual({ tasks: ["closed"], orphans: ["/r/.claude/worktrees/orphan"] });
  });

  it("leaves orphans alone while a build is preparing or running", () => {
    for (const buildState of ["preparing", "running"]) {
      const result = sweepTargets({
        repoPath: repo,
        dirSlugs: ["orphan"],
        tasks: [t("closed", { worktreePath: "/r/.claude/worktrees/done", closedAt: 1 }), t("building", { buildState })],
      });
      expect(result).toEqual({ tasks: ["closed"], orphans: [] });
    }
    // A closed task's stale buildState does not hold the sweep.
    expect(
      sweepTargets({ repoPath: repo, dirSlugs: ["orphan"], tasks: [t("old", { closedAt: 1, buildState: "running" })] }).orphans,
    ).toEqual(["/r/.claude/worktrees/orphan"]);
  });
});

describe("setup environment", () => {
  it("drops the host's npm settings and keeps everything else", () => {
    const env = setupEnv({
      PATH: "/usr/bin",
      HOME: "/Users/s",
      npm_config_allow_scripts: "better-sqlite3,node-pty",
      NPM_CONFIG_REGISTRY: "https://example.test",
      npm_lifecycle_event: "start",
      npm_package_name: "bb",
      npm_execpath: "/x/npm-cli.js",
      INIT_CWD: "/somewhere",
      NPM_TOKEN_NOT_CONFIG: "kept",
      UNSET: undefined,
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/Users/s", NPM_TOKEN_NOT_CONFIG: "kept" });
  });
});

describe("leftoverDecision", () => {
  const names = { worktreePath: "/repo/.claude/worktrees/x", branch: "task/x", baseRef: "origin/main" };
  const worktree = { kind: "worktree" as const, current: "task/x", dirty: false, ahead: 0 };
  const branch = { kind: "branch" as const, checkedOut: false, ahead: 0 };

  it("reuses a clean worktree on the task's branch with nothing of its own", () => {
    expect(leftoverDecision(worktree, names)).toEqual({ action: "reuse-worktree" });
  });
  it("refuses a folder that is not a git worktree", () => {
    const d = leftoverDecision({ ...worktree, current: null }, names);
    expect(d).toEqual({ action: "refuse", reason: "/repo/.claude/worktrees/x already exists: it is not a git worktree." });
  });
  it("refuses a worktree on another branch", () => {
    const d = leftoverDecision({ ...worktree, current: "main" }, names);
    expect(d).toEqual({ action: "refuse", reason: "/repo/.claude/worktrees/x already exists: it is on main, not task/x." });
  });
  it("refuses a worktree with uncommitted changes", () => {
    const d = leftoverDecision({ ...worktree, dirty: true }, names);
    expect(d).toEqual({
      action: "refuse",
      reason: "/repo/.claude/worktrees/x already exists: it has uncommitted changes.",
    });
  });
  it("refuses a worktree with commits of its own", () => {
    expect(leftoverDecision({ ...worktree, ahead: 1 }, names)).toEqual({
      action: "refuse",
      reason: "/repo/.claude/worktrees/x already exists: it has 1 commit of its own.",
    });
    expect(leftoverDecision({ ...worktree, ahead: 3 }, names)).toMatchObject({
      reason: expect.stringContaining("has 3 commits of its own"),
    });
  });
  it("refuses a worktree whose commits can't be counted", () => {
    expect(leftoverDecision({ ...worktree, ahead: null }, names)).toEqual({
      action: "refuse",
      reason: "/repo/.claude/worktrees/x already exists: it cannot be compared with origin/main.",
    });
  });
  it("resets a leftover branch checked out nowhere with nothing of its own", () => {
    expect(leftoverDecision(branch, names)).toEqual({ action: "reset-branch" });
  });
  it("refuses a branch checked out in a worktree", () => {
    expect(leftoverDecision({ ...branch, checkedOut: true }, names)).toEqual({
      action: "refuse",
      reason: "Branch task/x already exists: it is checked out in another worktree.",
    });
  });
  it("refuses a branch with commits of its own, or uncountable ones", () => {
    expect(leftoverDecision({ ...branch, ahead: 2 }, names)).toEqual({
      action: "refuse",
      reason: "Branch task/x already exists: it has 2 commits of its own.",
    });
    expect(leftoverDecision({ ...branch, ahead: null }, names)).toMatchObject({ action: "refuse" });
  });
});

describe("branchCheckedOut", () => {
  const list = [
    "worktree /repo",
    "HEAD 1111111111111111111111111111111111111111",
    "branch refs/heads/main",
    "",
    "worktree /repo/.claude/worktrees/y",
    "HEAD 2222222222222222222222222222222222222222",
    "branch refs/heads/task/y",
    "",
  ].join("\n");
  it("finds a branch checked out in any worktree, and only an exact match", () => {
    expect(branchCheckedOut(list, "task/y")).toBe(true);
    expect(branchCheckedOut(list, "main")).toBe(true);
    expect(branchCheckedOut(list, "task/x")).toBe(false);
    expect(branchCheckedOut(list, "task")).toBe(false);
  });
});

describe("cleanupAfterFailedPrepare", () => {
  const names = { worktreePath: "/repo/.claude/worktrees/x", branch: "task/x" };
  it("removes what this call created, the worktree first", () => {
    expect(cleanupAfterFailedPrepare({ createdWorktree: true, createdBranch: true }, names)).toEqual([
      ["worktree", "remove", "--force", "/repo/.claude/worktrees/x"],
      ["branch", "-D", "task/x"],
    ]);
  });
  it("keeps a branch that was there before (worktree add -B or an existing branch)", () => {
    expect(cleanupAfterFailedPrepare({ createdWorktree: true, createdBranch: false }, names)).toEqual([
      ["worktree", "remove", "--force", "/repo/.claude/worktrees/x"],
    ]);
  });
  it("touches nothing that pre-existed this call", () => {
    expect(cleanupAfterFailedPrepare({ createdWorktree: false, createdBranch: false }, names)).toEqual([]);
  });
});

const hasGit = spawnSync("git", ["--version"]).status === 0;

describe.skipIf(!hasGit)("a failed prepare, against a real repo", () => {
  const git = (cwd: string, ...args: string[]) => {
    const out = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`);
    return out.stdout;
  };
  const branchExists = (repo: string, branch: string) =>
    spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo }).status === 0;
  const setup = () => {
    const repo = mkdtempSync(join(tmpdir(), "prepare-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    git(repo, "config", "commit.gpgsign", "false");
    writeFileSync(join(repo, ".gitignore"), ".claude/\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    return repo;
  };

  it("removes the worktree and branch it created", () => {
    const repo = setup();
    try {
      const path = worktreePathFor(repo, "x");
      git(repo, "worktree", "add", "-q", "-b", "task/x", path, "main");
      writeFileSync(join(path, ".env"), "copied include\n");
      const steps = cleanupAfterFailedPrepare(
        { createdWorktree: true, createdBranch: true },
        { worktreePath: path, branch: "task/x" },
      );
      for (const argv of steps) git(repo, ...argv);
      expect(existsSync(path)).toBe(false);
      expect(branchExists(repo, "task/x")).toBe(false);
      expect(branchCheckedOut(git(repo, "worktree", "list", "--porcelain"), "task/x")).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps a branch that existed before (worktree add -B), removing only the worktree", () => {
    const repo = setup();
    try {
      git(repo, "branch", "task/y");
      const path = worktreePathFor(repo, "y");
      const facts = {
        kind: "branch" as const,
        checkedOut: branchCheckedOut(git(repo, "worktree", "list", "--porcelain"), "task/y"),
        ahead: Number(git(repo, "rev-list", "--count", "main..refs/heads/task/y").trim()),
      };
      expect(leftoverDecision(facts, { worktreePath: path, branch: "task/y", baseRef: "main" })).toEqual({
        action: "reset-branch",
      });
      git(repo, "worktree", "add", "-q", "-B", "task/y", path, "main");
      expect(branchCheckedOut(git(repo, "worktree", "list", "--porcelain"), "task/y")).toBe(true);
      const steps = cleanupAfterFailedPrepare(
        { createdWorktree: true, createdBranch: false },
        { worktreePath: path, branch: "task/y" },
      );
      for (const argv of steps) git(repo, ...argv);
      expect(existsSync(path)).toBe(false);
      expect(branchExists(repo, "task/y")).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
