import { describe, expect, it } from "vitest";
import {
  claimWaitsToWake,
  expandClaims,
  findConflicts,
  LOCKFILES,
  normalizeTouch,
  outsideClaims,
  outsideClaimsRefusal,
  overlaps,
  planClaims,
  type Claim,
} from "./claims";
import { DEFAULT_PROFILE, profileFor, type ProjectProfile } from "./profiles";

/** A web + mobile app whose shared folder is mirrored: held whole, and a claim on one side claims both. */
const SHOP: ProjectProfile = {
  ...DEFAULT_PROFILE,
  key: "shop",
  names: ["acme shop"],
  remotes: ["acme/shop"],
  sharedPaths: ["CLAUDE.md", "docs/notes.md", "packages/shared/**"],
  mirrors: [["web/shared/**", "packages/shared/**"]],
};
const shop = profileFor({ name: "Acme Shop", gitRemoteUrl: "https://github.com/acme/Shop.git" }, [SHOP]);
const plainProfile = { sharedPaths: [] as string[], mirrors: [] as [string, string][] };

describe("normalizeTouch", () => {
  it("accepts exact files and dir/** subtrees, tidying the spelling", () => {
    expect(normalizeTouch("./src/lib/a.ts")).toEqual({ ok: true, path: "src/lib/a.ts" });
    expect(normalizeTouch("web/admin/")).toEqual({ ok: true, path: "web/admin/**" });
    expect(normalizeTouch("src/app/**")).toEqual({ ok: true, path: "src/app/**" });
  });

  it("refuses the whole repo, other wildcards, and paths outside the repo", () => {
    for (const bad of ["**", "*", "/**", "src/*.ts", "src/**/x.ts", "/etc/passwd", "../other/x", ""]) {
      expect(normalizeTouch(bad).ok, bad).toBe(false);
    }
  });
});

describe("overlaps", () => {
  it("matches equal files, a file inside a subtree, and nested subtrees", () => {
    expect(overlaps("src/a.ts", "src/a.ts")).toBe(true);
    expect(overlaps("web/**", "web/admin/page.tsx")).toBe(true);
    expect(overlaps("web/admin/page.tsx", "web/**")).toBe(true);
    expect(overlaps("src/**", "src/app/**")).toBe(true);
  });

  it("does not match siblings or a shared name prefix", () => {
    expect(overlaps("src/a.ts", "src/b.ts")).toBe(false);
    expect(overlaps("src/app/**", "src/application.ts")).toBe(false);
    expect(overlaps("src/app/**", "src/apps/**")).toBe(false);
  });
});

describe("expandClaims", () => {
  it("widens a file inside packages/shared to the whole mirror, on both sides", () => {
    expect(expandClaims(["packages/shared/units.ts"], shop)).toEqual([
      "packages/shared/**",
      "web/shared/**",
    ]);
    expect(expandClaims(["web/shared/units.ts"], shop)).toEqual([
      "web/shared/units.ts",
      "packages/shared/**",
    ]);
  });

  it("keeps CLAUDE.md and docs/notes.md as whole files", () => {
    expect(expandClaims(["CLAUDE.md", "docs/notes.md"], shop)).toEqual(["CLAUDE.md", "docs/notes.md"]);
  });
});

describe("expandClaims: lockfiles", () => {
  it("a claimed package.json brings every lockfile in its own directory", () => {
    expect(expandClaims(["package.json"], plainProfile)).toEqual(["package.json", ...LOCKFILES]);
    expect(expandClaims(["web/package.json"], plainProfile)).toEqual([
      "web/package.json",
      ...LOCKFILES.map((lockfile) => `web/${lockfile}`),
    ]);
  });

  it("never the root lockfile for a nested package.json, and nothing for a subtree", () => {
    expect(expandClaims(["app/package.json"], plainProfile)).not.toContain("package-lock.json");
    expect(expandClaims(["src/**"], plainProfile)).toEqual(["src/**"]);
    expect(expandClaims(["src/package.json.ts"], plainProfile)).toEqual(["src/package.json.ts"]);
    expect(expandClaims(["mypackage.json"], plainProfile)).toEqual(["mypackage.json"]);
  });
});

describe("outsideClaims", () => {
  it("covers an exact file and nothing beside it", () => {
    expect(outsideClaims(["src/a.ts", "src/b.ts"], ["src/a.ts"], plainProfile)).toEqual(["src/b.ts"]);
  });

  it("a subtree covers nested files but not a sibling sharing its name prefix", () => {
    expect(
      outsideClaims(["src/app/x/page.tsx", "src/app/y.ts", "src/application.ts"], ["src/app/**"], plainProfile),
    ).toEqual(["src/application.ts"]);
  });

  it("widens the claims through shared paths and mirrors", () => {
    expect(
      outsideClaims(["packages/shared/units.ts", "packages/shared/other.ts", "web/shared/x.ts", "src/lib/y.ts"], ["packages/shared/units.ts"], shop),
    ).toEqual(["src/lib/y.ts"]);
  });

  it("a claimed package.json covers its own lockfile, never the root one for a nested package", () => {
    expect(outsideClaims(["package.json", "package-lock.json"], ["package.json"], plainProfile)).toEqual([]);
    expect(
      outsideClaims(["app/package.json", "app/yarn.lock", "package-lock.json"], ["app/package.json"], plainProfile),
    ).toEqual(["package-lock.json"]);
  });

  it("no claims: every file is outside; no files: nothing is", () => {
    expect(outsideClaims(["a.ts", "b/c.ts"], [], plainProfile)).toEqual(["a.ts", "b/c.ts"]);
    expect(outsideClaims([], ["src/**"], plainProfile)).toEqual([]);
  });

  it("normalises and deduplicates, in input order", () => {
    expect(
      outsideClaims(["./x.ts", " x.ts ", "src\\a.ts", "y.ts", "./src/b.ts"], ["src/b.ts"], plainProfile),
    ).toEqual(["x.ts", "src/a.ts", "y.ts"]);
  });
});

describe("outsideClaimsRefusal", () => {
  it("names the files and both fixes, and says nothing is widened", () => {
    const refusal = outsideClaimsRefusal(["src/a.ts", "package-lock.json"]);
    expect(refusal).toContain("- src/a.ts");
    expect(refusal).toContain("- package-lock.json");
    expect(refusal).toContain("claimOnly: true");
    expect(refusal).toContain("re-checks overlaps");
    expect(refusal).toContain("revert them");
    expect(refusal).toContain("Nothing is widened automatically");
  });

  it("caps a long list", () => {
    const files = Array.from({ length: 25 }, (_, i) => `f${i}.ts`);
    const refusal = outsideClaimsRefusal(files);
    expect(refusal).toContain("- f19.ts");
    expect(refusal).not.toContain("- f20.ts");
    expect(refusal).toContain("…and 5 more");
  });
});

describe("findConflicts / planClaims", () => {
  const held: Claim[] = [
    { taskId: "task_a", projectId: "proj_f", path: "server/billing/**" },
    { taskId: "task_a", projectId: "proj_f", path: "CLAUDE.md" },
    { taskId: "task_b", projectId: "proj_f", path: "packages/shared/**" },
    { taskId: "task_c", projectId: "proj_s", path: "server/billing/**" },
  ];

  it("refuses a build whose touches cross another task's claim in the same project", () => {
    const result = planClaims({
      taskId: "task_new",
      projectId: "proj_f",
      touches: ["server/billing/index.ts", "src/lib/assistant/tools/search.ts"],
      held,
      profile: shop,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflicts).toEqual([
        { path: "server/billing/index.ts", heldBy: "task_a", heldPath: "server/billing/**" },
      ]);
    }
  });

  it("treats CLAUDE.md as held whole, and a shared mirror as held whole", () => {
    const claude = planClaims({ taskId: "t", projectId: "proj_f", touches: ["CLAUDE.md"], held, profile: shop });
    expect(claude.ok).toBe(false);
    const mirror = planClaims({
      taskId: "t",
      projectId: "proj_f",
      touches: ["web/shared/format.ts"],
      held,
      profile: shop,
    });
    expect(mirror.ok).toBe(false);
    if (!mirror.ok) expect(mirror.conflicts[0]?.heldBy).toBe("task_b");
  });

  it("grants disjoint touches, ignores other projects, and ignores the task's own claims", () => {
    expect(
      planClaims({ taskId: "t", projectId: "proj_f", touches: ["src/lib/assistant/**"], held, profile: shop }),
    ).toEqual({ ok: true, paths: ["src/lib/assistant/**"] });
    expect(findConflicts({ taskId: "t", projectId: "proj_x", paths: ["server/billing/a.ts"], held })).toEqual([]);
    expect(findConflicts({ taskId: "task_a", projectId: "proj_f", paths: ["CLAUDE.md"], held })).toEqual([]);
  });

  it("reports every invalid touch at once and claims nothing", () => {
    const result = planClaims({ taskId: "t", projectId: "proj_f", touches: ["**", "src/*.ts"], held, profile: shop });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.invalid).toHaveLength(2);
  });
});

describe("claimWaitsToWake", () => {
  const plain = { sharedPaths: [] as string[], mirrors: [] as [string, string][] };
  const wait = (touches: string[], taskId = "task_w") => ({ taskId, projectId: "p", touches });
  const claim = (path: string, taskId = "task_h"): Claim => ({ taskId, projectId: "p", path });
  const wake = (waits: ReturnType<typeof wait>[], held: Claim[], profile = plain) => claimWaitsToWake(waits, held, () => profile);

  it("keeps waiting while the holder still holds what it asked for", () => {
    expect(wake([wait(["src/a.ts"])], [claim("src/**")])).toEqual([]);
  });

  it("wakes once the holder released, or holds only paths that do not cross", () => {
    // The bug: task_sj2339j81h waited on claims that were freed eight minutes later, and nobody told it.
    expect(wake([wait(["src/a.ts"])], [])).toEqual(["task_w"]);
    expect(wake([wait(["src/a.ts"])], [claim("docs/**")])).toEqual(["task_w"]);
  });

  it("ignores the waiter's own claims and other projects' claims", () => {
    expect(wake([wait(["src/a.ts"])], [claim("src/a.ts", "task_w"), { taskId: "task_h", projectId: "other", path: "src/a.ts" }])).toEqual([
      "task_w",
    ]);
  });

  it("widens shared paths as a build would", () => {
    const shared = { sharedPaths: ["packages/shared/**"], mirrors: [] as [string, string][] };
    // The waiter touches one file, the holder another: both are the whole shared subtree.
    expect(wake([wait(["packages/shared/a.ts"])], [claim("packages/shared/b.ts")], shared)).toEqual([]);
    expect(wake([wait(["packages/shared/a.ts"])], [claim("packages/shared/b.ts")])).toEqual(["task_w"]);
  });

  it("never wakes invalid touches", () => {
    expect(wake([wait(["**"]), wait([], "task_e")], [])).toEqual([]);
  });

  it("uses each waiter's own project's profile", () => {
    const profiles: string[] = [];
    claimWaitsToWake([{ taskId: "t", projectId: "p_x", touches: ["a.ts"] }], [], (projectId) => {
      profiles.push(projectId);
      return plain;
    });
    expect(profiles).toEqual(["p_x"]);
  });
});
