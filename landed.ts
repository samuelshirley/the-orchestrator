// When a task's work is on main, whatever route it took there. land() closes
// its own task once the reload is live (reload.ts); this catches the rest: a
// task that committed on main itself, or anything else that got a commit there
// without land. A commit belongs to a task only when it is the task's own: its
// `Orchestrator-Task` trailer, or the sha of the task's own build (its
// branch's tip, its verifiedSha). A sha its report mentions never counts: a
// report may name another task's commit. git decides: the commit must be on
// the default branch and newer than the task. A task closes only when nothing
// of it is still open, and never while it has steps left (steps.ts): a
// multi-step task's landed step is on main by design. Pure; landed.test.ts
// pins it.
import type { Task } from "./store";

/** The commit trailer that names a commit's task (land: "main" projects only). */
export const TASK_TRAILER = "Orchestrator-Task";

export function taskTrailer(taskId: string): string {
  return `${TASK_TRAILER}: ${taskId}`;
}

/** Task ids a commit message names in its trailers. */
export function trailerTaskIds(message: string): string[] {
  const out: string[] = [];
  for (const match of message.matchAll(/^Orchestrator-Task:[ \t]*(task_[a-z0-9]+)[ \t]*$/gim)) {
    out.push(match[1]!.toLowerCase());
  }
  return out;
}

/** Meta key holding a task thread's last full report (the claim is often its first line). */
export function reportKey(taskId: string): string {
  return `task_report:${taskId}`;
}

/** How much of a report is kept. */
export const REPORT_MAX = 20_000;

/**
 * Shas a report says are on main: any sha on a line that talks about landing
 * or main, as agents write it: "landed on main as `a94a2f1`", "committed on
 * main as `4f8f65d`", "commit 9c450ab, on main". For display only (model.ts):
 * never evidence for closing a task, not even as a tiebreak, since a report
 * may name another task's commit. Hex words need a digit, so "defaced" is not
 * a sha.
 */
export function reportedLandedShas(report: string | null): string[] {
  if (report === null) return [];
  const out: string[] = [];
  for (const line of report.split("\n")) {
    if (!/\bland(?:ed|s)?\b|\bmain\b/i.test(line)) continue;
    for (const match of line.matchAll(/\b([0-9a-f]{7,40})\b/gi)) {
      const sha = match[1]!.toLowerCase();
      if (/\d/.test(sha) && !out.includes(sha)) out.push(sha);
    }
  }
  return out;
}

/** A commit on the default branch, as the host read it. */
export interface MainCommit {
  sha: string;
  /** Committer time, ms. */
  committedAt: number;
  message: string;
}

/** Tasks this check looks at: open and not yet past the build (PRs close through the PR). */
export function landCandidate(task: Pick<Task, "closedAt" | "stage">): boolean {
  return task.closedAt === null && (task.stage === "research" || task.stage === "build");
}

/** Shortest sha that counts as the task's own; shorter ones match too much. */
const MIN_OWN_SHA = 7;

/**
 * The task's newest commit on main: its trailer first, else the sha of its own
 * build (its branch's tip, its verifiedSha). Never a sha its report mentions.
 */
export function landedCommit({
  task,
  ownShas,
  commits,
}: {
  task: Pick<Task, "id" | "createdAt">;
  /** Full or abbreviated shas of the task's own build: its branch tip, its verifiedSha. */
  ownShas: readonly string[];
  /** Newest first, as git log gives them. */
  commits: readonly MainCommit[];
}): MainCommit | null {
  // Older than the task is not its work.
  const mine = commits.filter((commit) => commit.committedAt >= task.createdAt);
  const byTrailer = mine.find((commit) => trailerTaskIds(commit.message).includes(task.id));
  if (byTrailer !== undefined) return byTrailer;
  const own = ownShas.map((sha) => sha.trim().toLowerCase()).filter((sha) => /^[0-9a-f]+$/.test(sha) && sha.length >= MIN_OWN_SHA);
  return mine.find((commit) => own.some((sha) => commit.sha.toLowerCase().startsWith(sha))) ?? null;
}

/** openWork's reason for a task kept open between its steps. */
export const STEPS_LEFT_PREFIX = "steps left: ";

/** Why the task still has open work, or null when nothing of it is open. */
export function openWork({
  task,
  openTickets,
  running,
  reloadPending,
  stepsLeft,
}: {
  task: Pick<Task, "buildState">;
  /** The task's open tickets (questions, review or report: a report waits on the owner's review). */
  openTickets: number;
  /** The task thread or one of its children is mid-turn or queued. */
  running: boolean;
  /**
   * land() started a reload that is not confirmed live yet (reload.ts).
   * Optional only for done.ts, whose caller in server.ts checks it itself.
   */
  reloadPending?: boolean;
  /** Steps the task recorded as left at its last land (steps.ts stepsLeftCount). */
  stepsLeft?: number;
}): string | null {
  if (task.buildState === "preparing" || task.buildState === "running") return "a build is in flight";
  if (task.buildState === "failed") return "a failed build is still the task's";
  if (reloadPending === true) return "a reload is pending";
  if (openTickets > 0) return "a question, review or report is open";
  if (running) return "an agent of the task is working";
  if (stepsLeft !== undefined && stepsLeft > 0) return `${STEPS_LEFT_PREFIX}${stepsLeft}`;
  return null;
}

/** The close note for a landed task; completionOf (model.ts) reads it back as "Landed on main · sha". */
export function landedNote(base: string, commit: MainCommit): string {
  const subject = (commit.message.split("\n")[0] ?? "").trim().slice(0, 200);
  return `Landed on ${base} at ${commit.sha.slice(0, 7)}: ${subject} (committed without land; closed by The Orchestrator)`;
}

/** Close the task (the note), or null while it is not landed or still has open work. */
export function landedClose(args: {
  task: Pick<Task, "id" | "createdAt" | "closedAt" | "stage" | "buildState">;
  ownShas: readonly string[];
  commits: readonly MainCommit[];
  base: string;
  openTickets: number;
  running: boolean;
  reloadPending: boolean;
  /**
   * Steps the task recorded as left at its last land (steps.ts). Optional only
   * for tickets.test.ts, which calls this without it; server.ts always passes it.
   */
  stepsLeft?: number;
}): string | null {
  if (!landCandidate(args.task)) return null;
  const commit = landedCommit(args);
  if (commit === null) return null;
  if (openWork(args) !== null) return null;
  return landedNote(args.base, commit);
}
