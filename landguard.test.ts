import { describe, expect, it } from "vitest";
import { GUARD_FILES, guardTestRule } from "./landguard";

describe("guardTestRule", () => {
  it("lets a branch with no guard file through, running nothing", () => {
    expect(guardTestRule(["server.ts", "README.md"])).toEqual({ ok: true, tests: [] });
    expect(guardTestRule([])).toEqual({ ok: true, tests: [] });
  });

  it("refuses a guard changed without its test, naming it", () => {
    const result = guardTestRule(["memory.ts", "server.ts"]);
    expect(result).toEqual({
      ok: false,
      reason: "memory.ts changed but memory.test.ts did not: a guard changes with its tests (mutation-check them).",
    });
  });

  it("names every guard missing its test", () => {
    const result = guardTestRule(["claims.ts", "reload.ts", "reload.test.ts", "landguard.ts"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("claims.ts changed but claims.test.ts did not");
    expect(result.reason).toContain("landguard.ts changed but landguard.test.ts did not");
    expect(result.reason).not.toContain("reload.ts changed");
  });

  it("runs the tests of every guard that changed with them", () => {
    expect(guardTestRule(["guard.ts", "guard.test.ts", "recovery.ts", "recovery.test.ts", "host.ts"])).toEqual({
      ok: true,
      tests: ["guard.test.ts", "recovery.test.ts"],
    });
  });

  it("covers every guard file, each on its own", () => {
    for (const guard of GUARD_FILES) {
      expect(guardTestRule([guard]).ok).toBe(false);
      const test = guard.replace(/\.ts$/, ".test.ts");
      expect(guardTestRule([guard, test])).toEqual({ ok: true, tests: [test] });
    }
    expect(GUARD_FILES).toEqual(["memory.ts", "guard.ts", "claims.ts", "reload.ts", "recovery.ts", "landguard.ts", "landed.ts", "done.ts"]);
  });

  it("holds what closes a task: landed.ts and done.ts land only with their tests", () => {
    expect(guardTestRule(["landed.ts", "done.ts", "done.test.ts"])).toEqual({
      ok: false,
      reason: "landed.ts changed but landed.test.ts did not: a guard changes with its tests (mutation-check them).",
    });
    expect(guardTestRule(["landed.ts", "landed.test.ts", "done.ts", "done.test.ts"])).toEqual({
      ok: true,
      tests: ["landed.test.ts", "done.test.ts"],
    });
  });

  it("reads repo-root paths only: a same-named file elsewhere is not the guard", () => {
    expect(guardTestRule(["mobile/shared/guard.ts", "lib/memory.ts"])).toEqual({ ok: true, tests: [] });
  });

  it("does not demand a guard for a changed test alone", () => {
    expect(guardTestRule(["memory.test.ts"])).toEqual({ ok: true, tests: [] });
  });
});
