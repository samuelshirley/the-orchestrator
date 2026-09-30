// What the board shows for the open route. A project is its board, with no
// chat; every chat belongs to a task: a task is its chat with only its own
// work beside it, and a research or build thread keeps the board on its task.
// The project's Patches chat still runs (task threads hang under it) but is
// never shown: its thread id resolves to the project board. A closed task
// opens by its own route (archive.ts closedPath), not a thread id: its chat is
// archived, so only its own work shows, none of the open board. Pure;
// scope.test.ts pins it.

import { parseClosedPath } from "./archive";

export type BoardScope =
  /** The project's board, full width, no chat. */
  | { kind: "project" }
  /** "+": a clean chat whose first message starts a task; the project board beside it. */
  | { kind: "compose" }
  /** A task's own thread or one of its research/build threads; only that task beside it. */
  | { kind: "task"; taskId: string; threadId: string }
  /** A closed task, by its own route; its archived chat (when a thread is named) and only its own work. */
  | { kind: "closed"; taskId: string; threadId: string | null }
  /** A thread outside any task (another agent's); the project board beside it. */
  | { kind: "other"; threadId: string };

export function boardScope({
  subPath,
  newTaskPath,
  tasks,
  children,
  patchesChats,
  liveThreadIds,
}: {
  subPath: string;
  newTaskPath: string;
  /** Open tasks. */
  tasks: readonly { id: string; threadId: string | null }[];
  children: readonly { taskId: string; threadId: string }[];
  patchesChats: readonly { projectId: string; threadId: string }[];
  /** Threads the host lists; an unknown thread outside any task is the project board. */
  liveThreadIds: ReadonlySet<string>;
}): BoardScope {
  if (subPath === "") return { kind: "project" };
  const closed = parseClosedPath(subPath);
  if (closed !== null) return { kind: "closed", taskId: closed.taskId, threadId: closed.threadId };
  if (subPath === newTaskPath) return { kind: "compose" };
  // A project's Patches chat is not shown: its board is.
  if (patchesChats.some((entry) => entry.threadId === subPath)) return { kind: "project" };
  // A task just started with "+" is its scope before the host lists its thread.
  const own = tasks.find((task) => task.threadId === subPath);
  if (own !== undefined) return { kind: "task", taskId: own.id, threadId: subPath };
  const child = children.find((entry) => entry.threadId === subPath);
  if (child !== undefined && tasks.some((task) => task.id === child.taskId)) {
    return { kind: "task", taskId: child.taskId, threadId: subPath };
  }
  if (liveThreadIds.has(subPath)) return { kind: "other", threadId: subPath };
  return { kind: "project" };
}

/** The thread the chat column shows; null when the scope has none (the project board, or "+"). */
export function scopeThread(scope: BoardScope): string | null {
  return scope.kind === "task" || scope.kind === "other" || scope.kind === "closed" ? scope.threadId : null;
}

/** Whether the page has a chat column: everything but the project board. */
export function showsChat(scope: BoardScope): boolean {
  return scope.kind !== "project";
}

/** Whether the right side carries the project-wide sections (Other agents, Other open PRs, Completed). */
export function showsProjectSections(scope: BoardScope): boolean {
  return scope.kind !== "task" && scope.kind !== "closed";
}

/** Needs-you items or task rows narrowed to the scope: a task sees only its own; a closed task, none; anything else, all. */
export function inScope<T>(scope: BoardScope, items: readonly T[], taskIdOf: (item: T) => string | null): T[] {
  if (scope.kind === "closed") return [];
  if (scope.kind !== "task") return [...items];
  return items.filter((item) => taskIdOf(item) === scope.taskId);
}

export interface ScopeThread {
  threadId: string;
  kind: "task" | "research" | "build";
  label: string;
  /** The one the chat column shows. */
  current: boolean;
}

/**
 * The task's own threads, for the task view's list: the task thread, then each
 * research and build child the host still lists (or the one open), in order.
 */
export function taskThreads({
  task,
  children,
  liveThreadIds,
  currentThreadId,
}: {
  task: { id: string; title: string; threadId: string | null };
  children: readonly { taskId: string; threadId: string; kind: "research" | "build"; label: string }[];
  liveThreadIds: ReadonlySet<string>;
  currentThreadId: string | null;
}): ScopeThread[] {
  const list: ScopeThread[] = [];
  if (task.threadId !== null) {
    list.push({ threadId: task.threadId, kind: "task", label: task.title, current: task.threadId === currentThreadId });
  }
  for (const child of children) {
    if (child.taskId !== task.id) continue;
    const current = child.threadId === currentThreadId;
    if (!current && !liveThreadIds.has(child.threadId)) continue;
    list.push({
      threadId: child.threadId,
      kind: child.kind,
      label: `${child.kind === "research" ? "Research" : "Build"}: ${child.label}`,
      current,
    });
  }
  return list;
}
