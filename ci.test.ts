import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ciDeferredKey,
  ciFailedKey,
  ciFailureActions,
  isCiFailure,
  MAX_CI_STARTS_PER_PASS,
  runCiPass,
  type CiAction,
  type CiPassDeps,
} from "./ci";
import type { PullRequest } from "./contract";
import { Store, type SqlDb, type Task } from "./store";
import { setOwner } from "./owner";

// The name is whoever runs it (owner.ts): a neutral one here, the fallback after.
beforeEach(() => setOwner("Alex"));
afterEach(() => setOwner(null));

const NOW = 1_700_000_000_000;
const SHA = "69abcdef00000000";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_owner",
    projectId: "proj_f",
    title: "Tiers",
    brief: "b",
    stage: "pr",
    threadId: "thr_owner",
    branch: "task/tiers",
    baseRef: "origin/main",
    worktreePath: null,
    worktreeNote: null,
    buildState: "none",
    buildError: null,
    buildFailures: 0,
    buildRequest: null,
    prNumber: 69,
    prUrl: "https://github.com/o/r/pull/69",
    headSha: SHA,
    verdict: null,
    verifiedSha: null,
    decisions: [],
    testList: [],
    note: null,
    createdAt: NOW,
    updatedAt: NOW,
    closedAt: null,
    ...overrides,
  };
}

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 69,
    title: "Tiers",
    url: "https://github.com/o/r/pull/69",
    state: "open",
    isDraft: false,
    headRefName: "task/tiers",
    headRefOid: SHA,
    updatedAt: NOW + 10,
    checks: "failing",
    failedConclusions: ["FAILURE"],
    mergeable: "mergeable",
    mergeStateStatus: "UNSTABLE",
    labels: [],
    previewSha: null,
    ...overrides,
  };
}

function actions(over: Partial<Parameters<typeof ciFailureActions>[0]> = {}): CiAction[] {
  return ciFailureActions({
    projectId: "proj_f",
    projectName: "Acme",
    pullRequests: [pr()],
    openTasks: [task()],
    acted: () => false,
    gate: null,
    startsLeft: MAX_CI_STARTS_PER_PASS,
    ...over,
  });
}

/** Red PRs nobody owns, numbered from 70. */
const unowned = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    pr({ number: 70 + i, title: `Orphan ${i}`, headRefName: `feature/o${i}`, headRefOid: `o${i}sha000000` }),
  );

describe("isCiFailure", () => {
  it("wants an open, red PR with a head sha and a real failure", () => {
    expect(isCiFailure(pr())).toBe(true);
    expect(isCiFailure(pr({ headRefOid: "" }))).toBe(false);
    expect(isCiFailure(pr({ failedConclusions: [] }))).toBe(false);
  });
});

describe("ciFailureActions: owned PRs", () => {
  it("tells the owning task's thread about red CI", () => {
    const result = actions();
    expect(result).toHaveLength(1);
    const tell = result[0];
    expect(tell).toMatchObject({
      kind: "tell",
      taskId: "task_owner",
      threadId: "thr_owner",
      key: ciFailedKey("proj_f", 69, SHA),
    });
    if (tell.kind !== "tell") throw new Error("expected tell");
    expect(tell.message).toContain('CI is failing on your PR #69 ("Tiers") at 69abcde.');
    expect(tell.message).toContain("gh pr checks 69; gh run view --log-failed");
    expect(tell.message).toContain("Do not weaken a test to pass. Merging stays Alex's.");
  });

  it("does nothing for a head already acted on", () => {
    const key = ciFailedKey("proj_f", 69, SHA);
    expect(actions({ acted: (k) => k === key })).toEqual([]);
  });

  it("acts again when a new head is pushed", () => {
    const key = ciFailedKey("proj_f", 69, SHA);
    const result = actions({ pullRequests: [pr({ headRefOid: "70fedcba0000" })], acted: (k) => k === key });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "tell", key: ciFailedKey("proj_f", 69, "70fedcba0000") });
  });

  it.each(["pending", "passing", "none"] as const)("does nothing while checks are %s", (checks) => {
    expect(actions({ pullRequests: [pr({ checks })] })).toEqual([]);
  });

  it("does nothing for a PR with only a cancelled run", () => {
    expect(actions({ pullRequests: [pr({ failedConclusions: ["CANCELLED"] })] })).toEqual([]);
  });

  it("does nothing for a PR with only a skipped run", () => {
    expect(actions({ pullRequests: [pr({ failedConclusions: ["skipped"] })] })).toEqual([]);
  });

  it("does nothing for a PR with only a neutral run", () => {
    expect(actions({ pullRequests: [pr({ failedConclusions: ["Neutral"] })] })).toEqual([]);
  });

  it("does nothing for a PR with only a stale run", () => {
    expect(actions({ pullRequests: [pr({ failedConclusions: ["STALE", "stale"] })] })).toEqual([]);
  });

  it("acts when a real failure sits beside a cancelled run", () => {
    const result = actions({ pullRequests: [pr({ failedConclusions: ["CANCELLED", "FAILURE"] })] });
    expect(result.map((a) => a.kind)).toEqual(["tell"]);
  });

  it.each(["closed", "merged"] as const)("does nothing for a %s PR", (state) => {
    expect(actions({ pullRequests: [pr({ state })] })).toEqual([]);
  });

  it("tells the owner of a draft PR", () => {
    expect(actions({ pullRequests: [pr({ isDraft: true })] }).map((a) => a.kind)).toEqual(["tell"]);
  });

  it("does nothing for a PR whose task has no thread, and never starts a second owner", () => {
    expect(actions({ openTasks: [task({ threadId: null })] })).toEqual([]);
  });
});

describe("ciFailureActions: unowned PRs", () => {
  it("starts a Fix failing CI task for an unowned red PR", () => {
    const orphan = pr({ number: 70, title: "Orphan", headRefName: "feature/x", headRefOid: "deadbeef1234" });
    const result = actions({ pullRequests: [orphan], openTasks: [] });
    expect(result).toHaveLength(1);
    const start = result[0];
    expect(start).toMatchObject({
      kind: "start",
      projectId: "proj_f",
      prNumber: 70,
      key: ciFailedKey("proj_f", 70, "deadbeef1234"),
      title: "Fix failing CI on PR #70: Orphan",
    });
    if (start.kind !== "start") throw new Error("expected start");
    expect(start.brief).toContain('CI is failing on PR #70 "Orphan" in Acme.');
    expect(start.brief).toContain("feature/x");
    expect(start.brief).toContain("deadbee");
    expect(start.brief).toContain(orphan.url);
    expect(start.brief).toContain("FAILURE");
    expect(start.brief).toContain("No open task owns this PR");
    expect(start.brief).toContain("gh pr checks 70; gh run view --log-failed");
    expect(start.brief).toContain("records PR #70");
    expect(start.brief).toContain("ask_sam");
    expect(start.brief).toContain("Never weaken a test");
    expect(start.brief).toContain("Merging stays Alex's.");
  });

  it("clips a long title to 120 with an ellipsis", () => {
    const [start] = actions({ pullRequests: [pr({ title: "x".repeat(300) })], openTasks: [] });
    if (start.kind !== "start") throw new Error("expected start");
    expect(start.title).toHaveLength(120);
    expect(start.title.endsWith("…")).toBe(true);
  });

  it("starts nothing for an unowned head already acted on, and moves to the next red PR", () => {
    const acted = (key: string) => key === ciFailedKey("proj_f", 70, "o0sha000000");
    const result = actions({ pullRequests: unowned(2), openTasks: [], acted });
    expect(result).toMatchObject([{ kind: "start", prNumber: 71 }]);
  });

  it("leaves an unowned draft alone", () => {
    expect(actions({ pullRequests: [pr({ isDraft: true })], openTasks: [] })).toEqual([]);
  });

  it.each([
    [1, 1],
    [2, 2],
    [0, 0],
  ])("with %i starts left, starts %i of 3 red PRs, lowest number first", (startsLeft, expected) => {
    const result = actions({ pullRequests: unowned(3), openTasks: [], startsLeft });
    expect(result.map((a) => a.kind)).toEqual(Array(expected).fill("start"));
    expect(result.map((a) => (a.kind === "start" ? a.prNumber : 0))).toEqual([70, 71, 72].slice(0, expected));
  });

  it("orders actions by PR number, owned and unowned together", () => {
    const orphan = pr({ number: 12, title: "Early", headRefName: "feature/e", headRefOid: "e12sha" });
    const result = actions({ pullRequests: [pr(), orphan] });
    expect(result.map((a) => a.kind)).toEqual(["start", "tell"]);
  });
});

describe("ciFailureActions: gates", () => {
  const inputs = { pullRequests: [pr(), ...unowned(2)] };

  it("defers owned and unowned work while a gate holds, starting and telling nothing", () => {
    const result = actions({ ...inputs, gate: "Claude usage is at 92%." });
    expect(result).toEqual([
      { kind: "defer", key: ciFailedKey("proj_f", 69, SHA), prNumber: 69, taskId: "task_owner", reason: "Claude usage is at 92%." },
      { kind: "defer", key: ciFailedKey("proj_f", 70, "o0sha000000"), prNumber: 70, taskId: null, reason: "Claude usage is at 92%." },
      { kind: "defer", key: ciFailedKey("proj_f", 71, "o1sha000000"), prNumber: 71, taskId: null, reason: "Claude usage is at 92%." },
    ]);
  });

  it("does not drop deferred work: the same inputs act once the gate lifts", () => {
    const result = actions({ ...inputs, gate: null });
    expect(result.map((a) => [a.kind, a.kind === "tell" ? 69 : a.prNumber])).toEqual([
      ["tell", 69],
      ["start", 70],
    ]);
  });

  it("keys a deferral note off the failure key", () => {
    expect(ciDeferredKey(ciFailedKey("p", 1, "s"))).toBe("ci_deferred:ci_failed:p:1:s");
  });
});

describe("ciFailureActions: persistence", () => {
  it("remembers an acted head across a store rebuilt on the same db file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-test-"));
    const file = join(dir, "dossier.sqlite");
    try {
      const firstDb = new DatabaseSync(file);
      Store.migrateInPlace(firstDb as unknown as SqlDb);
      new Store(firstDb as unknown as SqlDb).setMeta(ciFailedKey("proj_f", 69, SHA), "1");
      firstDb.close();

      const secondDb = new DatabaseSync(file);
      const store = new Store(secondDb as unknown as SqlDb);
      const acted = (key: string) => store.getMeta(key) !== null;
      expect(acted(ciFailedKey("proj_f", 69, SHA))).toBe(true);
      expect(actions({ acted })).toEqual([]);
      secondDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runCiPass", () => {
  type Fake = CiPassDeps & {
    meta: Map<string, string>;
    tells: string[];
    starts: number[];
    logs: string[];
    failTell: boolean;
    failStart: boolean;
  };

  function fake(meta = new Map<string, string>()): Fake {
    const deps: Fake = {
      meta,
      tells: [],
      starts: [],
      logs: [],
      failTell: false,
      failStart: false,
      acted: (key) => meta.has(key),
      deferredNoted: (key) => meta.has(ciDeferredKey(key)),
      markActed: (key) => {
        meta.set(key, "1");
        meta.delete(ciDeferredKey(key));
      },
      noteDeferred: (key, reason) => {
        meta.set(ciDeferredKey(key), reason);
      },
      tell: async (action) => {
        if (deps.failTell) throw new Error("bb refused the message");
        deps.tells.push(action.taskId);
      },
      start: async (action) => {
        if (deps.failStart) throw new Error("no Patches chat for the project yet");
        deps.starts.push(action.prNumber);
      },
      log: (message) => {
        deps.logs.push(message);
      },
    };
    return deps;
  }

  const owned = { projectId: "proj_f", projectName: "Acme", pullRequests: [pr()] };
  const pass = (deps: CiPassDeps, over: Partial<Parameters<typeof runCiPass>[0]> = {}) =>
    runCiPass({ projects: [owned], openTasks: [task()], gate: () => null, deps, ...over });

  it("tells the owner, then marks the key; a second pass with the same state does nothing", async () => {
    const deps = fake();
    expect(await pass(deps)).toEqual({ told: 1, started: 0, deferred: 0, failed: 0 });
    expect(deps.tells).toEqual(["task_owner"]);
    expect(deps.meta.has(ciFailedKey("proj_f", 69, SHA))).toBe(true);

    expect(await pass(deps)).toEqual({ told: 0, started: 0, deferred: 0, failed: 0 });
    expect(deps.tells).toEqual(["task_owner"]);
  });

  it("a failing tell does not mark the key, and the next pass tells again", async () => {
    const deps = fake();
    deps.failTell = true;
    expect(await pass(deps)).toMatchObject({ told: 0, failed: 1 });
    expect(deps.meta.has(ciFailedKey("proj_f", 69, SHA))).toBe(false);
    expect(deps.logs.join("\n")).toContain("bb refused the message");

    deps.failTell = false;
    expect(await pass(deps)).toMatchObject({ told: 1, failed: 0 });
    expect(deps.tells).toEqual(["task_owner"]);
    expect(deps.meta.has(ciFailedKey("proj_f", 69, SHA))).toBe(true);
  });

  it("starts at most one task per pass across projects; the next pass starts the other", async () => {
    const deps = fake();
    const projects = [
      { projectId: "proj_a", projectName: "A", pullRequests: [pr({ number: 5, headRefOid: "a5sha" })] },
      { projectId: "proj_b", projectName: "B", pullRequests: [pr({ number: 6, headRefOid: "b6sha" })] },
    ];
    expect(await runCiPass({ projects, openTasks: [], gate: () => null, deps })).toMatchObject({ started: 1 });
    expect(deps.starts).toEqual([5]);

    expect(await runCiPass({ projects, openTasks: [], gate: () => null, deps })).toMatchObject({ started: 1 });
    expect(deps.starts).toEqual([5, 6]);

    expect(await runCiPass({ projects, openTasks: [], gate: () => null, deps })).toMatchObject({ started: 0 });
    expect(deps.starts).toEqual([5, 6]);
  });

  it("defers while a gate holds, logging once and marking nothing; acts once it lifts", async () => {
    const deps = fake();
    const projects = [{ projectId: "proj_f", projectName: "Acme", pullRequests: [pr(), ...unowned(1)] }];
    const held = () => "Claude usage is at 92%.";
    for (let i = 0; i < 2; i += 1) {
      expect(await runCiPass({ projects, openTasks: [task()], gate: held, deps })).toMatchObject({ deferred: 2 });
    }
    expect(deps.tells).toEqual([]);
    expect(deps.starts).toEqual([]);
    expect(deps.logs).toEqual(["ci: PR #69 waits: Claude usage is at 92%.", "ci: PR #70 waits: Claude usage is at 92%."]);
    expect(deps.meta.has(ciFailedKey("proj_f", 69, SHA))).toBe(false);
    expect(deps.meta.has(ciFailedKey("proj_f", 70, "o0sha000000"))).toBe(false);

    expect(await runCiPass({ projects, openTasks: [task()], gate: () => null, deps })).toMatchObject({ told: 1, started: 1 });
    expect(deps.tells).toEqual(["task_owner"]);
    expect(deps.starts).toEqual([70]);
    expect(deps.meta.has(ciDeferredKey(ciFailedKey("proj_f", 69, SHA)))).toBe(false);
  });

  it("a start that throws is not marked, is noted deferred once, and is retried next pass", async () => {
    const deps = fake();
    deps.failStart = true;
    const projects = [{ projectId: "proj_f", projectName: "Acme", pullRequests: unowned(1) }];
    const key = ciFailedKey("proj_f", 70, "o0sha000000");
    for (let i = 0; i < 2; i += 1) {
      expect(await runCiPass({ projects, openTasks: [], gate: () => null, deps })).toMatchObject({ started: 0, failed: 1 });
    }
    expect(deps.meta.has(key)).toBe(false);
    expect(deps.meta.get(ciDeferredKey(key))).toBe("no Patches chat for the project yet");
    expect(deps.logs).toEqual(["ci: PR #70 not started, retried next pass: no Patches chat for the project yet"]);

    deps.failStart = false;
    expect(await runCiPass({ projects, openTasks: [], gate: () => null, deps })).toMatchObject({ started: 1 });
    expect(deps.starts).toEqual([70]);
    expect(deps.meta.has(key)).toBe(true);
  });

  it("does not fire again after a restart on the same dossier", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-pass-"));
    const file = join(dir, "dossier.sqlite");
    const projects = [{ projectId: "proj_f", projectName: "Acme", pullRequests: [pr(), ...unowned(1)] }];
    const storeDeps = (store: Store, calls: { tells: number; starts: number }): CiPassDeps => ({
      acted: (key) => store.getMeta(key) !== null,
      deferredNoted: (key) => store.getMeta(ciDeferredKey(key)) !== null,
      markActed: (key) => {
        store.setMeta(key, String(NOW));
        store.setMeta(ciDeferredKey(key), null);
      },
      noteDeferred: (key, reason) => store.setMeta(ciDeferredKey(key), reason),
      tell: async () => {
        calls.tells += 1;
      },
      start: async () => {
        calls.starts += 1;
      },
      log: () => {},
    });
    try {
      const firstDb = new DatabaseSync(file);
      Store.migrateInPlace(firstDb as unknown as SqlDb);
      const before = { tells: 0, starts: 0 };
      await runCiPass({ projects, openTasks: [task()], gate: () => null, deps: storeDeps(new Store(firstDb as unknown as SqlDb), before) });
      expect(before).toEqual({ tells: 1, starts: 1 });
      firstDb.close();

      const secondDb = new DatabaseSync(file);
      const after = { tells: 0, starts: 0 };
      await runCiPass({ projects, openTasks: [task()], gate: () => null, deps: storeDeps(new Store(secondDb as unknown as SqlDb), after) });
      expect(after).toEqual({ tells: 0, starts: 0 });
      secondDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
