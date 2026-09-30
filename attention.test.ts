import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILD_FAILURE_LIMIT, askLine, buildFailedMessage, buildNeedsSam, validateAsk, type Ask } from "./attention";
import { setOwner } from "./owner";

// The name is whoever runs it (owner.ts): a neutral one here, the fallback after.
beforeEach(() => setOwner("Alex"));
afterEach(() => setOwner(null));

const decision = (overrides: Partial<Extract<Ask, { kind: "decision" }>> = {}): Ask => ({
  kind: "decision",
  question: "Which price for the three-month plan?",
  options: ["$3.50", "$4.99"],
  recommended: 0,
  ...overrides,
});

const command = (overrides: Partial<Extract<Ask, { kind: "command" }>> = {}): Ask => ({
  kind: "command",
  question: "gh is signed out; only your login can fix it.",
  command: "gh auth login",
  cwd: null,
  reason: "credential",
  ...overrides,
});

describe("validateAsk", () => {
  it("lets a real decision and an owner-only command through", () => {
    expect(validateAsk(decision())).toBeNull();
    expect(validateAsk(command())).toBeNull();
  });

  it("refuses a decision with nothing to choose", () => {
    expect(validateAsk(decision({ options: ["$3.50"] }))).toMatch(/2 to 5 options/);
    expect(validateAsk(decision({ options: ["a", "b", "c", "d", "e", "f"] }))).toMatch(/2 to 5 options/);
    expect(validateAsk(decision({ options: ["same", "same"] }))).toMatch(/repeat/);
  });

  it("requires the agent's own pick", () => {
    expect(validateAsk(decision({ recommended: 2 }))).toMatch(/Recommend/);
    expect(validateAsk(decision({ recommended: -1 }))).toMatch(/Recommend/);
  });

  it("refuses a command the owner has no special reason to run", () => {
    expect(validateAsk(command({ reason: "convenience" as never }))).toMatch(/run it yourself/);
    expect(validateAsk(command({ command: "  " }))).toMatch(/exact command/);
  });

  it("names whoever runs it: the refusal follows setOwner, and the fallback without one", () => {
    const refusal = () => validateAsk(command({ reason: "convenience" as never }));
    expect(refusal()).toBe("A command reaches Alex only for their credential, account, device. Anything else, run it yourself.");
    setOwner("Robin");
    expect(refusal()).toBe("A command reaches Robin only for their credential, account, device. Anything else, run it yourself.");
    setOwner(null);
    expect(refusal()).toBe("A command reaches the owner only for their credential, account, device. Anything else, run it yourself.");
  });

  it("refuses a vague ask", () => {
    expect(validateAsk(decision({ question: "Ok?" }))).toMatch(/full sentence/);
  });
});

describe("askLine", () => {
  it("marks the recommended option and names the command", () => {
    expect(askLine(decision())).toBe("Which price for the three-month plan? Options: $3.50 (recommended) / $4.99");
    expect(askLine(command({ cwd: "~/repo" }))).toBe("gh is signed out; only your login can fix it. Run: gh auth login (in ~/repo)");
  });
});

describe("failed builds", () => {
  it("stay with the task until it has failed BUILD_FAILURE_LIMIT times", () => {
    expect(buildNeedsSam({ buildState: "failed", buildFailures: BUILD_FAILURE_LIMIT - 1 })).toBe(false);
    expect(buildNeedsSam({ buildState: "failed", buildFailures: BUILD_FAILURE_LIMIT })).toBe(true);
    expect(buildNeedsSam({ buildState: "running", buildFailures: 9 })).toBe(false);
  });

  it("tell the task to fix it first, and only then that the owner has it", () => {
    const first = buildFailedMessage({ taskId: "task_1", reason: "npm ci: EALLOWSCRIPTS", failures: 1, worktreePath: "/r/.claude/worktrees/x" });
    expect(first).toContain("Fix it yourself");
    expect(first).toContain("EALLOWSCRIPTS");
    expect(first).toContain("reuses it");
    const last = buildFailedMessage({ taskId: "task_1", reason: "boom", failures: BUILD_FAILURE_LIMIT, worktreePath: null });
    expect(last).toContain("Retry and Dismiss");
    expect(last).not.toContain("Fix it yourself");
    // The name is the owner's, in both messages.
    expect(first).toContain(`(1 of ${BUILD_FAILURE_LIMIT} before Alex sees it)`);
    expect(first).toContain("Do not ask Alex for anything you can run.");
    expect(last).toContain("Alex now has it on their board with Retry and Dismiss. If only they can unblock it (their login, account or device),");
    setOwner(null);
    expect(buildFailedMessage({ taskId: "task_1", reason: "boom", failures: BUILD_FAILURE_LIMIT, worktreePath: null })).toContain(
      "\n\nThe owner now has it on their board",
    );
  });
});
