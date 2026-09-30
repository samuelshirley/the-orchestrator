// Which task a thread works for, when bb asks at thread.start. The dossier
// records a spawned thread's id only after threads.spawn returns, but bb runs
// agents.configure during the spawn, and a running session keeps the tools and
// instructions it started with. So a fresh thread falls back to the metadata it
// was spawned with, checked against the dossier. Metadata is untrusted (any
// client can write it): it can only name a slot the dossier left open for it.
// Pure; roles.test.ts pins it.
import type { Child, Task } from "./store";

export type ThreadRole =
  | { kind: "task"; task: Task }
  | { kind: "research" | "build"; owner: Task };

export function threadRole({
  threadId,
  parentThreadId,
  metadata,
  taskByThread,
  child,
  task,
}: {
  threadId: string;
  parentThreadId: string | null;
  metadata: { readonly [key: string]: unknown };
  /** The open or closed task whose thread this is, per the dossier. */
  taskByThread: Task | null;
  /** The dossier's child row for this thread. */
  child: Child | null;
  /** Dossier lookup by task id. */
  task: (id: string) => Task | null;
}): ThreadRole | null {
  if (taskByThread !== null) return taskByThread.closedAt === null ? { kind: "task", task: taskByThread } : null;
  if (child !== null) {
    const owner = task(child.taskId);
    return owner === null ? null : { kind: child.kind, owner };
  }
  const role = metadata.role;
  const taskId = typeof metadata.taskId === "string" ? metadata.taskId : null;
  if (taskId === null) return null;
  const named = task(taskId);
  if (named === null || named.closedAt !== null) return null;
  if (role === "task") {
    // Only a task still waiting for its thread: an existing one is not taken over.
    return named.threadId === null ? { kind: "task", task: named } : null;
  }
  if (role === "research" || role === "build") {
    // Children hang under their task's thread.
    return named.threadId !== null && named.threadId === parentThreadId && named.threadId !== threadId
      ? { kind: role, owner: named }
      : null;
  }
  return null;
}
