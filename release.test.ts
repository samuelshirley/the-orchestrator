import { describe, expect, it } from "vitest";
import type { Branch, PullRequest } from "./contract";
import { headShaUpdate, prCounts, staleReason, type BranchFate } from "./release";
import type { Task } from "./store";

const NOW = 1_700_000_000_000;

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_z4",
    projectId: "proj_f",
    title: "Sign in with Apple revoke",
    brief: "b",
    stage: "build",
    threadId: "thr_task",
    branch: "task/apple-revoke",
    baseRef: "origin/main",
    worktreePath: null,
    worktreeNote: null,
    buildState: "running",
    buildError: null,
    buildFailures: 0,
    buildRequest: null,
    prNumber: null,
    prUrl: null,
    headSha: "332aae2f00000000",
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
    number: 61,
    title: "PR",
    url: "https://github.com/o/r/pull/61",
    state: "open",
    isDraft: false,
    headRefName: "task/apple-revoke",
    headRefOid: "332aae2f00000000",
    updatedAt: NOW + 10,
    checks: "passing",
    failedConclusions: [],
    mergeable: "mergeable",
    mergeStateStatus: "CLEAN",
    labels: [],
    previewSha: null,
    ...overrides,
  };
}

function branch(overrides: Partial<Branch> = {}): Branch {
  return {
    name: "task/apple-revoke",
    sha: "aaaa111",
    committedAt: NOW,
    subject: "Revoke",
    ahead: 2,
    behind: 0,
    worktreePath: null,
    ...overrides,
  };
}

const gone: BranchFate = { local: false, remote: false, headOnBase: true };

describe("prCounts", () => {
  it("counts a PR matched by number even when it is older than the task", () => {
    expect(prCounts(task({ prNumber: 61 }), pr({ updatedAt: NOW - 1 }))).toBe(true);
  });
  it("ignores a branch-matched PR older than the task", () => {
    expect(prCounts(task(), pr({ updatedAt: NOW - 1 }))).toBe(false);
    expect(prCounts(task({ prNumber: 7 }), pr({ updatedAt: NOW - 1 }))).toBe(false);
    expect(prCounts(task(), pr({ updatedAt: NOW }))).toBe(true);
  });
});

describe("staleReason", () => {
  it("releases on a merged PR", () => {
    expect(staleReason({ task: task({ prNumber: 61 }), pr: pr({ state: "merged" }), fate: null })).toBe("PR #61 merged.");
  });

  it("releases on a closed PR, found by branch too", () => {
    expect(staleReason({ task: task(), pr: pr({ state: "closed", number: 57 }), fate: null })).toBe("PR #57 closed.");
  });

  it("ignores a branch-matched PR older than the task", () => {
    expect(staleReason({ task: task(), pr: pr({ state: "merged", updatedAt: NOW - 1 }), fate: null })).toBeNull();
  });

  it("keeps a task with an open PR", () => {
    expect(staleReason({ task: task({ prNumber: 61 }), pr: pr(), fate: gone })).toBeNull();
  });

  it("does nothing for a closed task", () => {
    expect(staleReason({ task: task({ closedAt: NOW }), pr: pr({ state: "merged" }), fate: gone })).toBeNull();
  });

  it("releases when the branch is gone and its commits are on the default branch", () => {
    expect(staleReason({ task: task(), pr: null, fate: gone })).toBe(
      "Branch task/apple-revoke is gone and its commits (332aae2) are on the default branch.",
    );
  });

  it("keeps a gone branch whose commits are not on the default branch", () => {
    expect(staleReason({ task: task(), pr: null, fate: { ...gone, headOnBase: false } })).toBeNull();
    expect(staleReason({ task: task(), pr: null, fate: { ...gone, headOnBase: null } })).toBeNull();
  });

  it("keeps a branch that still exists locally or on the remote", () => {
    expect(staleReason({ task: task(), pr: null, fate: { ...gone, remote: true } })).toBeNull();
    expect(staleReason({ task: task(), pr: null, fate: { ...gone, local: true } })).toBeNull();
  });

  it("needs a head sha, a branch and a fate", () => {
    expect(staleReason({ task: task({ headSha: null }), pr: null, fate: gone })).toBeNull();
    expect(staleReason({ task: task({ branch: null }), pr: null, fate: gone })).toBeNull();
    expect(staleReason({ task: task(), pr: null, fate: null })).toBeNull();
  });

  it("never releases a preparing build by the branch rule", () => {
    expect(staleReason({ task: task({ buildState: "preparing" }), pr: null, fate: gone })).toBeNull();
  });
});

describe("headShaUpdate", () => {
  it("records a branch tip with work on it", () => {
    expect(headShaUpdate(task({ headSha: null }), branch())).toBe("aaaa111");
    expect(headShaUpdate(task(), branch())).toBe("aaaa111");
  });
  it("ignores a branch with nothing ahead", () => {
    expect(headShaUpdate(task({ headSha: null }), branch({ ahead: 0 }))).toBeNull();
  });
  it("ignores an unchanged tip", () => {
    expect(headShaUpdate(task({ headSha: "aaaa111" }), branch())).toBeNull();
  });
  it("ignores another branch, a missing branch and a task without one", () => {
    expect(headShaUpdate(task(), branch({ name: "task/other" }))).toBeNull();
    expect(headShaUpdate(task(), undefined)).toBeNull();
    expect(headShaUpdate(task({ branch: null }), branch())).toBeNull();
  });
});
