// A review ticket ("PR #N ready: test and merge") holds only while the PR is
// still what ready_for_review proved: open, its head the proven commit, CI
// green on it, no conflicts, and ai-tests still on. Anything else voids it, so
// the owner never sees a merge ask for an unproven head. Pure; review.test.ts pins it.
import { owners } from "./owner";
import type { PullRequest } from "./contract";
import type { Task } from "./store";

const short = (sha: string) => sha.slice(0, 7);

/**
 * Why the task's review ticket no longer holds, or null while it does or we
 * cannot tell (no PR on the task, or no fresh snapshot of it). Closing needs
 * evidence: a failed PR lookup is not a moved head.
 */
export function reviewStale({
  task,
  pr,
  aiTestsLabel,
}: {
  task: Pick<Task, "prNumber" | "verifiedSha">;
  pr: PullRequest | null;
  aiTestsLabel: string | null;
}): string | null {
  // A hand-off with no PR (a repo with no remote) has nothing to go stale.
  if (pr === null || pr.number !== task.prNumber) return null;
  if (pr.state !== "open") return `PR #${pr.number} is ${pr.state}`;
  const head = pr.headRefOid;
  if (task.verifiedSha === null) return `no proven head (head is ${short(head)})`;
  if (head !== task.verifiedSha) return `head moved to ${short(head)} (proven ${short(task.verifiedSha)})`;
  if (pr.checks === "failing") return `CI failing on ${short(head)}`;
  if (pr.checks === "pending") return `CI running again on ${short(head)}`;
  if (pr.mergeable === "conflicting" || pr.mergeStateStatus === "DIRTY") return `merge conflicts on ${short(head)}`;
  if (aiTestsLabel !== null && !pr.labels.includes(aiTestsLabel)) return `${aiTestsLabel} is no longer on ${short(head)}`;
  return null;
}

/** What the task hears, once, when its review ticket is voided. */
export function reviewVoidedMessage(task: Pick<Task, "id" | "prNumber">, reason: string): string {
  return `Your review hand-off for PR #${task.prNumber} is void: ${reason}. It is off ${owners()} Needs you and they will not be asked to merge it. When the new head is green, call ready_for_review again; that opens a fresh one. (${task.id})`;
}

/** The label a proven PR must still carry: ready_for_review demands it only under full CI. */
export function reviewLabel(profile: { ci: string; aiTestsLabel: string | null }): string | null {
  return profile.ci === "full" ? profile.aiTestsLabel : null;
}
