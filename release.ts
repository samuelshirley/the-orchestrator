// When a task's work is finished, so its claims and build slot go back: its
// PR merged or closed, or its branch is gone with its commits on the default
// branch (merged through another task's PR). Pure; release.test.ts pins it.
import type { Branch, PullRequest } from "./contract";
import type { Task } from "./store";

/** What git says about a task's branch once the snapshot no longer lists it. */
export type BranchFate = {
  local: boolean;
  remote: boolean;
  /** Is task.headSha an ancestor of the default branch; null when there is no headSha. */
  headOnBase: boolean | null;
};

/**
 * A PR matched by number is the task's. One matched only by branch name counts
 * only if it moved since the task began: branch names get reused.
 */
export function prCounts(task: Task, pr: PullRequest): boolean {
  if (task.prNumber !== null && pr.number === task.prNumber) return true;
  return pr.updatedAt >= task.createdAt;
}

/** Why the task's work is finished, or null while it is not (or we cannot tell). */
export function staleReason({
  task,
  pr,
  fate,
}: {
  task: Task;
  pr: PullRequest | null;
  fate: BranchFate | null;
}): string | null {
  if (task.closedAt !== null) return null;
  if (pr !== null && prCounts(task, pr)) {
    if (pr.state === "merged") return `PR #${pr.number} merged.`;
    if (pr.state === "closed") return `PR #${pr.number} closed.`;
    return null;
  }
  // A preparing build may not have created its branch yet.
  if (task.buildState === "preparing") return null;
  if (task.branch === null || task.headSha === null || fate === null) return null;
  if (fate.local || fate.remote || fate.headOnBase !== true) return null;
  return `Branch ${task.branch} is gone and its commits (${task.headSha.slice(0, 7)}) are on the default branch.`;
}

/** The branch tip to remember: only one with work on it, and only when it moved. */
export function headShaUpdate(task: Task, branch: Branch | undefined): string | null {
  if (branch === undefined || branch.name !== task.branch) return null;
  if (branch.ahead <= 0 || branch.sha === task.headSha) return null;
  return branch.sha;
}
