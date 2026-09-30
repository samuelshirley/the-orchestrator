// land() refuses a branch that changes a guard without its tests. A guard is a
// module whose failure lets something dangerous through or stops The
// Orchestrator loading: the memory guard, claims, the reload check, recovery,
// what closes a task (landed, done) and this rule itself. When a branch changes one (a repo-root path), its
// <name>.test.ts must change too, and land runs those tests in the worktree
// before landing; a missing test or a failing run lands nothing.
// Pure; landguard.test.ts pins it.

export const GUARD_FILES = ["memory.ts", "guard.ts", "claims.ts", "reload.ts", "recovery.ts", "landguard.ts", "landed.ts", "done.ts"] as const;

export type GuardTestResult = { ok: true; tests: string[] } | { ok: false; reason: string };

function testFileOf(guard: string): string {
  return guard.replace(/\.ts$/, ".test.ts");
}

/** The guard files a branch changed must come with their tests; `tests` are the ones to run. */
export function guardTestRule(changed: readonly string[]): GuardTestResult {
  const files = new Set(changed);
  const guards = GUARD_FILES.filter((guard) => files.has(guard));
  const missing = guards.filter((guard) => !files.has(testFileOf(guard)));
  if (missing.length > 0) {
    const each = missing.map((guard) => `${guard} changed but ${testFileOf(guard)} did not`).join("; ");
    return { ok: false, reason: `${each}: a guard changes with its tests (mutation-check them).` };
  }
  return { ok: true, tests: guards.map(testFileOf) };
}
