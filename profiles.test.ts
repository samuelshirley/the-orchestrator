import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE, PROFILES, backupPush, buildBaseRef, couldCopyEnv, profileFor, worktreeIncludeOf, type ProjectProfile } from "./profiles";

const REMOTE = "https://github.com/octocat/the-orchestrator.git";

/** A deploying app, as the local config would hold it: production env, an AI-tests run. */
const SHOP: ProjectProfile = {
  ...DEFAULT_PROFILE,
  key: "shop",
  names: ["acme shop"],
  remotes: ["acme/shop"],
  ci: "full",
  aiTestsLabel: "ai-tests",
  aiRanPatterns: ["Assistant specs ran", "\\| `ai` \\| ✅ success"],
  worktreeInclude: [".claude/settings.local.json"],
  productionEnv: true,
};
const ALL = [SHOP, ...PROFILES, DEFAULT_PROFILE];

describe("The Orchestrator's profile", () => {
  it("stays land: main with its backup remote: a remote never makes it PR-based", () => {
    const profile = profileFor({ name: "the-orchestrator", gitRemoteUrl: REMOTE });
    expect(profile.key).toBe("the-orchestrator");
    expect(profile.land).toBe("main");
    expect(profile.backup).toBe("origin");
  });

  it("is the same profile with no remote", () => {
    const profile = profileFor({ name: "the-orchestrator", gitRemoteUrl: null });
    expect(profile.key).toBe("the-orchestrator");
    expect(profile.land).toBe("main");
  });
});

describe("profileFor", () => {
  it("has only The Orchestrator's own profile built in, matched by name and never by a remote", () => {
    expect(PROFILES.map((profile) => profile.key)).toEqual(["the-orchestrator"]);
    expect(PROFILES[0]?.remotes).toEqual([]);
    expect(profileFor({ name: "my-fork", gitRemoteUrl: REMOTE }).key).toBe("default");
    expect(profileFor({ name: "The Orchestrator", gitRemoteUrl: REMOTE }).key).toBe("the-orchestrator");
  });

  it("knows a local profile only when it is passed in", () => {
    const project = { name: "Acme Shop", gitRemoteUrl: "git@github.com:Acme/Shop.git" };
    expect(profileFor(project).key).toBe("default");
    expect(profileFor(project, [SHOP]).key).toBe("shop");
    expect(profileFor({ name: "renamed", gitRemoteUrl: project.gitRemoteUrl }, [SHOP]).key).toBe("shop");
    expect(profileFor({ name: " ACME shop " }, [SHOP]).key).toBe("shop");
    // No state is kept between calls.
    expect(profileFor(project).key).toBe("default");
  });

  it("searches local profiles first: by remote, then by name, then the built-in ones", () => {
    const byName: ProjectProfile = { ...SHOP, key: "by-name", names: ["acme shop"], remotes: [] };
    const byRemote: ProjectProfile = { ...SHOP, key: "by-remote", names: [], remotes: ["acme/shop"] };
    expect(profileFor({ name: "Acme Shop", gitRemoteUrl: "https://github.com/acme/shop" }, [byName, byRemote]).key).toBe("by-remote");
    expect(profileFor({ name: "Acme Shop", gitRemoteUrl: null }, [byName, byRemote]).key).toBe("by-name");
    const shadow: ProjectProfile = { ...SHOP, key: "shadow", names: ["the-orchestrator"], remotes: [] };
    expect(profileFor({ name: "the-orchestrator" }, [shadow]).key).toBe("shadow");
    expect(profileFor({ name: "the-orchestrator" }, [SHOP]).key).toBe("the-orchestrator");
  });
});

describe("backupPush", () => {
  it("pushes the landed branch to the backup remote, never forced", () => {
    const argv = backupPush(profileFor({ name: "the-orchestrator", gitRemoteUrl: REMOTE }), "main");
    expect(argv).toEqual(["push", "origin", "main:main"]);
    expect(argv).not.toContain("--force");
    expect(argv).not.toContain("-f");
    expect(argv?.some((arg) => arg.startsWith("+") || arg.startsWith("--force"))).toBe(false);
  });

  it("is null for every PR-based profile, even with a backup set", () => {
    for (const profile of ALL.filter((p) => p.land === "pr")) {
      expect(profile.backup).toBeNull();
      expect(backupPush(profile, "main")).toBeNull();
      expect(backupPush({ ...profile, backup: "origin" }, "main")).toBeNull();
    }
  });

  it("is null for a land: main profile with no backup", () => {
    const orchestrator = profileFor({ name: "the-orchestrator" });
    expect(backupPush({ ...orchestrator, backup: null }, "main")).toBeNull();
  });
});

describe("buildBaseRef", () => {
  it("branches The Orchestrator's builds from local main even with its backup remote", () => {
    const profile = profileFor({ name: "the-orchestrator", gitRemoteUrl: REMOTE });
    expect(buildBaseRef(profile, true, "main")).toBe("main");
  });

  it("branches PR-based builds from origin when there is a remote, else locally", () => {
    expect(buildBaseRef(DEFAULT_PROFILE, true, "main")).toBe("origin/main");
    expect(buildBaseRef(DEFAULT_PROFILE, false, "main")).toBe("main");
  });
});

describe("aiRanPatterns", () => {
  it("compile, and only a profile with an AI-tests label has any", () => {
    for (const profile of ALL) {
      for (const pattern of profile.aiRanPatterns) expect(() => new RegExp(pattern, "iu")).not.toThrow();
      if (profile.aiTestsLabel === null) expect(profile.aiRanPatterns).toEqual([]);
    }
    expect(profileFor({ name: "Acme Shop" }, [SHOP]).aiRanPatterns.length).toBeGreaterThan(0);
  });
});

describe("worktreeInclude", () => {
  it("no production-env profile copies an .env file", () => {
    for (const profile of ALL.filter((p) => p.productionEnv)) {
      for (const include of profile.worktreeInclude) {
        const name = include.split("/").pop() ?? include;
        expect(name.startsWith(".env"), `${profile.key} includes ${include}`).toBe(false);
      }
    }
    expect(ALL.some((p) => p.productionEnv)).toBe(true);
  });

  it("knows a pattern that could copy an env file, globs included", () => {
    for (const pattern of [".env", ".env*", ".env.local", "mobile/.env.production", "/.env", "*", "mobile/*", ".e*", "?env", "[.]env", ".env?", "config/*.json"]) {
      expect(couldCopyEnv(pattern), pattern).toBe(true);
    }
    for (const pattern of [".claude/settings.local.json", "env.json", ".envoy/settings.json", "notes.env", "a*"]) {
      expect(couldCopyEnv(pattern), pattern).toBe(false);
    }
  });

  it("a production-env profile copies only its local Claude settings", () => {
    const profile = profileFor({ name: "Acme Shop" }, [SHOP]);
    expect(profile.key).toBe("shop");
    expect(profile.productionEnv).toBe(true);
    expect(worktreeIncludeOf(profile)).toEqual([".claude/settings.local.json"]);
  });

  it("never hands a production-env profile's .env files to a worktree, whatever the profile lists", () => {
    const leaky: ProjectProfile = { ...SHOP, worktreeInclude: [".env", ".claude/settings.local.json", "mobile/.env.local", "/.env.production", "*", "mobile/.e*"] };
    expect(worktreeIncludeOf(leaky)).toEqual([".claude/settings.local.json"]);
    // Without production secrets the profile's list stands.
    expect(worktreeIncludeOf({ ...leaky, productionEnv: false })).toEqual(leaky.worktreeInclude);
  });

  it("a project with no profile copies nothing", () => {
    expect(DEFAULT_PROFILE.worktreeInclude).toEqual([]);
  });

  it("a project with no profile falls back to the default and copies nothing", () => {
    const profile = profileFor({ name: "old-thing", gitRemoteUrl: "https://github.com/octocat/old-thing.git" });
    expect(profile.key).toBe("default");
    expect(worktreeIncludeOf(profile)).toEqual([]);
  });
});
