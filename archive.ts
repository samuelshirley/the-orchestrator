// Closed tasks, for the board's archive: which ones a project lists (searched,
// newest first, paged), what one says about itself once its chat is archived
// (how it finished, the commit or PR, decisions, answered questions,
// withdrawals, releases, its threads), and the route that opens it. A closed
// task opens by its own id, never by thread id: archived threads are not in the
// host's live list. Pure, no I/O; archive.test.ts pins it.

import { completionLabel, completionOf } from "./model";
import type { Child, Decision, Release, Task, Ticket, Withdrawal } from "./store";

export const CLOSED_PAGE_SIZE = 25;
export const CLOSED_PAGE_MAX = 100;

type Searchable = Pick<Task, "id" | "projectId" | "title" | "brief" | "note" | "prNumber" | "closedAt">;

/** Everything a search term may match, one field per line so a term never spans two. */
function haystack(task: Searchable): string {
  return [task.title, task.brief, task.note ?? "", task.id, task.prNumber === null ? "" : `#${task.prNumber}`]
    .join("\n")
    .toLowerCase();
}

/**
 * One page of a project's closed tasks, newest first. Every whitespace-separated
 * term must match somewhere in the title, brief, note, id or PR number ("#12"
 * and "12" both find PR 12). `total` counts the matches before paging.
 */
export function closedTaskPage<T extends Searchable>({
  tasks,
  projectId,
  query = "",
  offset = 0,
  limit = CLOSED_PAGE_SIZE,
}: {
  tasks: readonly T[];
  projectId: string;
  query?: string;
  offset?: number;
  limit?: number;
}): { rows: T[]; total: number } {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term !== "");
  const matches = tasks
    .filter((task) => task.closedAt !== null && task.projectId === projectId)
    .filter((task) => {
      if (terms.length === 0) return true;
      const text = haystack(task);
      return terms.every((term) => text.includes(term));
    })
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  const size = Number.isFinite(limit) ? Math.min(CLOSED_PAGE_MAX, Math.max(1, Math.floor(limit))) : CLOSED_PAGE_SIZE;
  return { rows: matches.slice(start, start + size), total: matches.length };
}

/** How many closed tasks each project has; a project with none has no key. */
export function closedCounts(tasks: readonly Pick<Task, "projectId" | "closedAt">[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    if (task.closedAt === null) continue;
    counts[task.projectId] = (counts[task.projectId] ?? 0) + 1;
  }
  return counts;
}

export interface ClosedQuestion {
  question: string;
  /** Null when the owner never answered it. */
  answer: string | null;
  askedAt: number;
}

export interface ClosedThread {
  threadId: string;
  kind: "task" | "research" | "build";
  label: string;
  summary: string | null;
}

export interface ClosedTaskSummary {
  id: string;
  projectId: string;
  title: string;
  brief: string;
  note: string | null;
  branch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  createdAt: number;
  closedAt: number | null;
  /** How it finished: "Landed on main · abc1234", "Merged PR #12". */
  how: string;
  /** The commit it landed at; null when it did not land. */
  sha: string | null;
  decisions: Decision[];
  questions: ClosedQuestion[];
  withdrawals: { questions: string[]; reason: string; by: Withdrawal["by"]; at: number }[];
  releases: Release[];
  /** The task thread first, then its research and build threads, oldest first. */
  threads: ClosedThread[];
}

/**
 * A closed task's dossier as one plain view. Tickets, withdrawals and children
 * of other tasks are ignored; review tickets are not questions. Releases carry
 * no task id: the caller hands this task's own.
 */
export function closedTaskSummary({
  task,
  tickets,
  withdrawals,
  releases,
  children,
}: {
  task: Task;
  tickets: readonly Ticket[];
  withdrawals: readonly Withdrawal[];
  releases: readonly Release[];
  children: readonly Child[];
}): ClosedTaskSummary {
  const completion = completionOf(task);
  const threads: ClosedThread[] = [];
  if (task.threadId !== null) threads.push({ threadId: task.threadId, kind: "task", label: task.title, summary: null });
  const own = children
    .filter((child) => child.taskId === task.id)
    .sort((a, b) => a.createdAt - b.createdAt || (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0));
  for (const child of own) {
    threads.push({ threadId: child.threadId, kind: child.kind, label: child.label, summary: child.summary });
  }
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    brief: task.brief,
    note: task.note,
    branch: task.branch,
    prNumber: task.prNumber,
    prUrl: task.prUrl,
    createdAt: task.createdAt,
    closedAt: task.closedAt,
    how: completionLabel(completion),
    sha: completion.kind === "landed" ? completion.sha : null,
    decisions: task.decisions.map((entry) => ({ question: entry.question, decision: entry.decision })),
    questions: tickets
      .filter((ticket) => ticket.taskId === task.id && ticket.kind === "questions")
      .sort((a, b) => a.createdAt - b.createdAt)
      .flatMap((ticket) =>
        ticket.questions.map((question, index) => ({
          question,
          answer: ticket.answers?.[index] ?? null,
          askedAt: ticket.createdAt,
        })),
      ),
    withdrawals: withdrawals
      .filter((entry) => entry.taskId === task.id)
      .map((entry) => ({ questions: [...entry.questions], reason: entry.reason, by: entry.by, at: entry.at })),
    releases: releases.map((entry) => ({
      paths: [...entry.paths],
      reason: entry.reason,
      by: entry.by,
      closed: entry.closed,
      at: entry.at,
    })),
    threads,
  };
}

/**
 * The chat a closed task's view shows: the thread the route names when it is one
 * of the task's and still readable, else (no thread named) the task thread.
 * Null when there is none to read: a gone thread, or one that is not this task's.
 */
export function closedChatThread<T extends { threadId: string; kind: ClosedThread["kind"]; state: "live" | "archived" | "gone" }>(
  threads: readonly T[],
  threadId: string | null,
): T | null {
  const wanted =
    threadId === null ? threads.find((entry) => entry.kind === "task") : threads.find((entry) => entry.threadId === threadId);
  return wanted === undefined || wanted.state === "gone" ? null : wanted;
}

const CLOSED_PREFIX = "closed";

/** The route that opens a closed task: `closed:<taskId>`, or `closed:<taskId>:<threadId>` on one of its threads. */
export function closedPath(taskId: string, threadId?: string | null): string {
  return threadId === undefined || threadId === null
    ? `${CLOSED_PREFIX}:${taskId}`
    : `${CLOSED_PREFIX}:${taskId}:${threadId}`;
}

/** The closed task a route names; null for any other route, an empty id or extra segments. */
export function parseClosedPath(subPath: string): { taskId: string; threadId: string | null } | null {
  const parts = subPath.split(":");
  if (parts[0] !== CLOSED_PREFIX || parts.length < 2 || parts.length > 3) return null;
  const taskId = parts[1]!;
  if (taskId === "") return null;
  if (parts.length === 2) return { taskId, threadId: null };
  const threadId = parts[2]!;
  return threadId === "" ? null : { taskId, threadId };
}
