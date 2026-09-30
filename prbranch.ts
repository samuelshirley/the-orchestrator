// One PR per effort: a task that already has an open PR keeps building on and
// pushing to that PR's head branch. A PR's head branch cannot change, so a
// build round on any other branch would strand its commits outside the PR.
// Pure — the server hands in the PR's facts read fresh from GitHub.

import type { PrFacts } from "./contract";
import { isRepoWorktreePath } from "./worktrees.js";

type PrHead = Pick<PrFacts, "number" | "state" | "headRefName" | "headRefOid">;

/**
 * Where a follow-up build round works. With an open PR it continues the PR's
 * head branch: in the worktree that already has it checked out when that is
 * one of this repo's task worktrees, else in the task's own worktree when it
 * is on that branch, else in a new worktree (worktreePath null) on that
 * branch. Without an open PR, a fresh branch from the base.
 */
export function followUpBuild(args: {
  repoPath: string;
  task: { branch: string | null; worktreePath: string | null };
  pr: PrHead | null;
  /** Where the PR's head branch is checked out, from the last repo snapshot. */
  checkedOutAt: string | null;
}): { kind: "fresh" } | { kind: "continue"; branch: string; worktreePath: string | null; prNumber: number } {
  const { repoPath, task, pr, checkedOutAt } = args;
  if (pr === null || pr.state !== "open") return { kind: "fresh" };
  const branch = pr.headRefName;
  let worktreePath: string | null = null;
  if (checkedOutAt !== null && isRepoWorktreePath(repoPath, checkedOutAt)) {
    worktreePath = checkedOutAt;
  } else if (task.branch === branch && task.worktreePath !== null && isRepoWorktreePath(repoPath, task.worktreePath)) {
    worktreePath = task.worktreePath;
  }
  return { kind: "continue", branch, worktreePath, prNumber: pr.number };
}

export type PrPush =
  /** No PR, or one that can no longer take commits: open a new PR from the task branch. */
  | { kind: "new-pr"; note: string | null }
  /** Push the task branch; it is the PR's head. */
  | { kind: "same"; prNumber: number; target: string; expectedOld: string }
  /** Fast-forward the PR's head branch to the worktree's HEAD. */
  | { kind: "onto"; prNumber: number; target: string; expectedOld: string };

/** Where open_pr pushes, given the task's recorded PR as GitHub reports it now. */
export function prPushPlan(taskBranch: string, pr: PrHead | null): PrPush {
  if (pr === null) return { kind: "new-pr", note: null };
  if (pr.state !== "open") {
    return { kind: "new-pr", note: `PR #${pr.number} is ${pr.state} and cannot take new commits, so this opens a new PR.` };
  }
  const kind = pr.headRefName === taskBranch ? "same" : "onto";
  return { kind, prNumber: pr.number, target: pr.headRefName, expectedOld: pr.headRefOid };
}

/**
 * Did the push reach the PR? Only when GitHub reports the PR's head at the
 * pushed sha; anything else is a failure to report, never "pushed to PR #N".
 */
export function pushReachedPr(args: {
  prNumber: number;
  target: string;
  pushedSha: string;
  after: Pick<PrFacts, "state" | "headRefName" | "headRefOid">;
}): { ok: true } | { ok: false; reason: string } {
  const { prNumber, target, pushedSha, after } = args;
  if (after.headRefName !== target) {
    return { ok: false, reason: `PR #${prNumber} now reports head branch ${after.headRefName}, not ${target}.` };
  }
  if (after.headRefOid !== pushedSha) {
    return {
      ok: false,
      reason: `Pushed ${pushedSha.slice(0, 7)} to ${target}, but PR #${prNumber}'s head is still ${after.headRefOid.slice(0, 7) || "unknown"}. The PR did not move.`,
    };
  }
  if (after.state !== "open") {
    return { ok: false, reason: `PR #${prNumber} is ${after.state}: the push did not update an open PR.` };
  }
  return { ok: true };
}
