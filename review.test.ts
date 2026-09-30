import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PullRequest } from "./contract";
import { reviewLabel, reviewStale, reviewVoidedMessage } from "./review";
import { setOwner } from "./owner";

// The name is whoever runs it (owner.ts): a neutral one here, the fallback after.
beforeEach(() => setOwner("Alex"));
afterEach(() => setOwner(null));

const PROVEN = "8bfbbe310d08ff70d720579af87197e79c331e42";
const MOVED = "ab347a583fa2e0cd4c98a2a5628ab2bb741170d9";

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 62,
    title: "Forced-stop reason",
    url: "https://github.com/o/r/pull/62",
    state: "open",
    isDraft: false,
    headRefName: "task/forced-stop",
    headRefOid: PROVEN,
    updatedAt: 1,
    checks: "passing",
    failedConclusions: [],
    mergeable: "mergeable",
    mergeStateStatus: "CLEAN",
    labels: ["ai-tests"],
    previewSha: "8bfbbe3",
    ...overrides,
  };
}

const task: { prNumber: number | null; verifiedSha: string | null } = { prNumber: 62, verifiedSha: PROVEN };
const stale = (over: Partial<PullRequest>, label: string | null = "ai-tests", t = task) =>
  reviewStale({ task: t, pr: pr(over), aiTestsLabel: label });

describe("reviewStale", () => {
  it("holds while the PR is open, on the proven head, green, clean and labelled", () => {
    expect(stale({})).toBeNull();
  });

  it("voids when the head moved (PR #62: proven 8bfbbe3, now ab347a5)", () => {
    expect(stale({ headRefOid: MOVED, checks: "passing" })).toBe("head moved to ab347a5 (proven 8bfbbe3)");
  });

  it("names the moved head before its CI state", () => {
    expect(stale({ headRefOid: MOVED, checks: "failing" })).toBe("head moved to ab347a5 (proven 8bfbbe3)");
  });

  it("voids when CI fails or re-runs on the proven head", () => {
    expect(stale({ checks: "failing" })).toBe("CI failing on 8bfbbe3");
    expect(stale({ checks: "pending" })).toBe("CI running again on 8bfbbe3");
  });

  it("does not demand checks from a repo with none", () => {
    expect(stale({ checks: "none", labels: [] }, null)).toBeNull();
  });

  it("voids on merge conflicts", () => {
    expect(stale({ mergeable: "conflicting" })).toBe("merge conflicts on 8bfbbe3");
    expect(stale({ mergeStateStatus: "DIRTY" })).toBe("merge conflicts on 8bfbbe3");
  });

  it("voids when ai-tests came off, only where the profile demands it", () => {
    expect(stale({ labels: [] })).toBe("ai-tests is no longer on 8bfbbe3");
    expect(stale({ labels: [] }, null)).toBeNull();
  });

  it("voids a PR that is no longer open", () => {
    expect(stale({ state: "closed" })).toBe("PR #62 is closed");
    expect(stale({ state: "merged" })).toBe("PR #62 is merged");
  });

  it("voids a ticket with no proven head", () => {
    expect(stale({}, "ai-tests", { prNumber: 62, verifiedSha: null })).toBe("no proven head (head is 8bfbbe3)");
  });

  it("keeps the ticket without evidence: no PR on the task, no snapshot, another PR", () => {
    expect(reviewStale({ task: { prNumber: null, verifiedSha: null }, pr: null, aiTestsLabel: "ai-tests" })).toBeNull();
    expect(reviewStale({ task, pr: null, aiTestsLabel: "ai-tests" })).toBeNull();
    expect(reviewStale({ task, pr: pr({ number: 64, headRefOid: MOVED }), aiTestsLabel: "ai-tests" })).toBeNull();
  });
});

describe("reviewLabel", () => {
  it("demands ai-tests only under full CI, as ready_for_review does", () => {
    expect(reviewLabel({ ci: "full", aiTestsLabel: "ai-tests" })).toBe("ai-tests");
    expect(reviewLabel({ ci: "none", aiTestsLabel: "ai-tests" })).toBeNull();
    expect(reviewLabel({ ci: "full", aiTestsLabel: null })).toBeNull();
  });
});

describe("reviewVoidedMessage", () => {
  it("tells the task why and what to do next", () => {
    const text = reviewVoidedMessage({ id: "task_4g", prNumber: 62 }, "head moved to ab347a5 (proven 8bfbbe3)");
    expect(text).toContain("PR #62");
    expect(text).toContain("head moved to ab347a5");
    expect(text).toContain("ready_for_review again");
  });
});
