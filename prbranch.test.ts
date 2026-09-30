import { describe, expect, it } from "vitest";
import { followUpBuild, prPushPlan, pushReachedPr } from "./prbranch";

const REPO = "/Users/me/Github/AcmeGoods";
const OLD = "8857a3e000000000000000000000000000000000";
const NEW = "4b4c420000000000000000000000000000000000";

const pr63 = (over: Partial<{ state: "open" | "closed" | "merged"; headRefName: string; headRefOid: string }> = {}) => ({
  number: 63,
  state: "open" as const,
  headRefName: "task/landing-page-at-research-design-build-on",
  headRefOid: OLD,
  ...over,
});

describe("followUpBuild", () => {
  it("cuts a fresh branch when the task has no PR", () => {
    expect(followUpBuild({ repoPath: REPO, task: { branch: null, worktreePath: null }, pr: null, checkedOutAt: null })).toEqual({ kind: "fresh" });
  });

  it("cuts a fresh branch once the PR is merged or closed", () => {
    for (const state of ["merged", "closed"] as const) {
      expect(
        followUpBuild({ repoPath: REPO, task: { branch: "task/x", worktreePath: null }, pr: pr63({ state }), checkedOutAt: null }).kind,
      ).toBe("fresh");
    }
  });

  it("continues the open PR's branch in the task's own worktree, not a new branch from main", () => {
    const wt = `${REPO}/.claude/worktrees/landing-page-at-research-design-build-on`;
    expect(
      followUpBuild({
        repoPath: REPO,
        task: { branch: "task/landing-page-at-research-design-build-on", worktreePath: wt },
        pr: pr63(),
        checkedOutAt: null,
      }),
    ).toEqual({ kind: "continue", branch: "task/landing-page-at-research-design-build-on", worktreePath: wt, prNumber: 63 });
  });

  it("follows the PR's head branch even when the task recorded another (the -2 incident)", () => {
    const old = `${REPO}/.claude/worktrees/landing-page-at-research-design-build-on`;
    const plan = followUpBuild({
      repoPath: REPO,
      task: { branch: "task/landing-page-at-research-design-build-on-2", worktreePath: `${old}-2` },
      pr: pr63(),
      checkedOutAt: old,
    });
    expect(plan).toEqual({ kind: "continue", branch: "task/landing-page-at-research-design-build-on", worktreePath: old, prNumber: 63 });
  });

  it("asks for a new worktree on the PR branch when none of the task worktrees has it", () => {
    const plan = followUpBuild({
      repoPath: REPO,
      task: { branch: "task/other", worktreePath: `${REPO}/.claude/worktrees/other` },
      pr: pr63(),
      checkedOutAt: REPO, // the main checkout: never adopt it
    });
    expect(plan).toEqual({ kind: "continue", branch: "task/landing-page-at-research-design-build-on", worktreePath: null, prNumber: 63 });
  });
});

describe("prPushPlan", () => {
  it("opens a PR when the task has none", () => {
    expect(prPushPlan("task/x", null)).toEqual({ kind: "new-pr", note: null });
  });

  it("pushes the task branch when it is the PR's head", () => {
    expect(prPushPlan("task/landing-page-at-research-design-build-on", pr63())).toEqual({
      kind: "same",
      prNumber: 63,
      target: "task/landing-page-at-research-design-build-on",
      expectedOld: OLD,
    });
  });

  it("fast-forwards the PR's own head branch when the build ran on another branch", () => {
    expect(prPushPlan("task/landing-page-at-research-design-build-on-2", pr63())).toEqual({
      kind: "onto",
      prNumber: 63,
      target: "task/landing-page-at-research-design-build-on",
      expectedOld: OLD,
    });
  });

  it("opens a new PR, and says why, when the old one is merged or closed", () => {
    const plan = prPushPlan("task/x", pr63({ state: "merged" }));
    expect(plan.kind).toBe("new-pr");
    expect(plan.kind === "new-pr" && plan.note).toMatch(/#63 is merged/);
  });
});

describe("pushReachedPr", () => {
  const target = "task/landing-page-at-research-design-build-on";

  it("confirms only when GitHub reports the PR's head at the pushed sha", () => {
    expect(pushReachedPr({ prNumber: 63, target, pushedSha: NEW, after: { state: "open", headRefName: target, headRefOid: NEW } })).toEqual({ ok: true });
  });

  it("refuses to say pushed to PR #63 when its head did not move", () => {
    const verdict = pushReachedPr({ prNumber: 63, target, pushedSha: NEW, after: { state: "open", headRefName: target, headRefOid: OLD } });
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toMatch(/#63's head is still 8857a3e/);
  });

  it("refuses when the PR reports another head branch", () => {
    const verdict = pushReachedPr({ prNumber: 63, target: `${target}-2`, pushedSha: NEW, after: { state: "open", headRefName: target, headRefOid: NEW } });
    expect(verdict.ok).toBe(false);
  });

  it("refuses when the PR closed meanwhile", () => {
    expect(pushReachedPr({ prNumber: 63, target, pushedSha: NEW, after: { state: "closed", headRefName: target, headRefOid: NEW } }).ok).toBe(false);
  });
});
