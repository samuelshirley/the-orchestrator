// Patches chats: one per project, no other. Every chat reads the one dossier
// but sees and starts only its own project's tasks; the build cap and Claude
// usage are shared by every project. This module names the chats and decides
// which chat a thread is, what a chat may see, which project the board shows,
// and when a chat shows as unread. Clicking a project opens its board, never
// a chat (scope.ts).
// Pure; chats.test.ts pins it.

/** Meta key holding the thread id of a project's chat. */
export function chatKey(projectId: string): string {
  return `orchestrator_thread_id:${projectId}`;
}

/**
 * Where the retired Any-project chat's thread id still sits. It is not a chat:
 * nothing reads this key except to keep that thread off the board; the thread
 * itself is left as it is.
 */
export const RETIRED_ANY_CHAT_KEY = "orchestrator_thread_id";

/**
 * Reverse index, thread → the project whose chat it is, so caller() can stay
 * synchronous. The retired Any-project chat stored "*" here: no project has
 * that id, so it no longer resolves to a chat.
 */
export function chatOfThreadKey(threadId: string): string {
  return `chat_of_thread:${threadId}`;
}

export function replyAtKey(projectId: string): string {
  return `chat_reply_at:${chatKey(projectId)}`;
}

export function seenAtKey(projectId: string): string {
  return `chat_seen_at:${chatKey(projectId)}`;
}

/**
 * The project the board, rail and chat show. There is always one while any
 * project exists: the stored pick while it still exists (a hidden one the owner
 * opened stays), else the first visible project in list order, else the first.
 */
export function focusedProject(
  stored: string | null,
  projects: readonly { id: string; hidden: boolean }[],
): string | null {
  if (stored !== null && projects.some((project) => project.id === stored)) return stored;
  return (projects.find((project) => !project.hidden) ?? projects[0])?.id ?? null;
}

/** A reply the owner has not seen, in a chat they are not looking at. */
export function isUnread({
  replyAt,
  seenAt,
  shown,
}: {
  replyAt: number | null;
  seenAt: number | null;
  shown: boolean;
}): boolean {
  return replyAt !== null && replyAt > (seenAt ?? 0) && !shown;
}

/**
 * Which chat an unregistered thread claims to be, from what it was started
 * with. A project chat lives in the very project its metadata names. Anything
 * else is not Patches, the retired Any-project chat (Personal, no projectId)
 * included.
 */
export function claimedChat({
  role,
  metadataProjectId,
  projectId,
  projectKind,
}: {
  role: unknown;
  metadataProjectId: unknown;
  projectId: string;
  projectKind: "personal" | "standard";
}): { projectId: string } | null {
  if (role !== "orchestrator") return null;
  if (projectKind !== "personal" && metadataProjectId === projectId) {
    return { projectId };
  }
  return null;
}

/** The tasks a project's chat sees: its own project's, no other. */
export function chatTasks<T extends { projectId: string }>(tasks: readonly T[], projectId: string): T[] {
  return tasks.filter((task) => task.projectId === projectId);
}

/**
 * Why a project's chat may not act on (or read) a task in another project, or
 * null when the task is its own. Names the chat that can.
 */
export function chatRefusal(
  chatProjectId: string,
  task: { id: string; projectId: string },
  projectName: string,
): string | null {
  if (task.projectId === chatProjectId) return null;
  return `${task.id} is in ${projectName}: ask in ${projectName}'s Patches chat.`;
}

/**
 * Whether opening a project starts its Patches chat: only when it has none,
 * has a local checkout to run in, and is not the Personal project.
 */
export function shouldStartChat({
  hasChat,
  hasCheckout,
  kind,
}: {
  hasChat: boolean;
  hasCheckout: boolean;
  kind: "personal" | "standard";
}): boolean {
  return !hasChat && hasCheckout && kind !== "personal";
}

export interface ParentFix {
  taskId: string;
  threadId: string;
  projectId: string;
  /** The project's live chat; null when it has none (the server starts one). */
  chatThreadId: string | null;
}

/**
 * The open tasks whose thread does not hang under its project's live Patches
 * chat. bb tells a thread's parent when it goes idle, so a task under no chat,
 * an archived chat or another project's chat is heard by nobody. A thread
 * missing from `parents` could not be read: it waits for the next beat.
 * `tasks` are open task rows only: never a chat or a research/build child.
 */
export function parentFixes({
  tasks,
  parents,
  chats,
}: {
  tasks: readonly { id: string; projectId: string; threadId: string | null }[];
  parents: ReadonlyMap<string, string | null>;
  chats: ReadonlyMap<string, string | null>;
}): ParentFix[] {
  const fixes: ParentFix[] = [];
  for (const task of tasks) {
    if (task.threadId === null || !parents.has(task.threadId)) continue;
    const chatThreadId = chats.get(task.projectId) ?? null;
    const parent = parents.get(task.threadId) ?? null;
    if (chatThreadId !== null && parent === chatThreadId) continue;
    fixes.push({ taskId: task.id, threadId: task.threadId, projectId: task.projectId, chatThreadId });
  }
  return fixes;
}

/** The one message a chat gets for the tasks re-attached under it in a beat. */
export function reattachedMessage(projectName: string, tasks: readonly { id: string; title: string }[]): string {
  const count = `${tasks.length} task${tasks.length === 1 ? "" : "s"}`;
  return [
    `[The Orchestrator] Re-attached ${count} of ${projectName} to this chat: they had no live Patches chat as parent, so you heard nothing from them. Check each with task_status and send it what it needs next:`,
    ...tasks.map((task) => `- ${task.id}: ${task.title}`),
  ].join("\n");
}

/** Why Patches is not told when a task's thread goes idle; null when she is. */
export function unheardReason(fix: ParentFix | undefined, projectName: string): string | null {
  if (fix === undefined) return null;
  const possessive = projectName.endsWith("s") ? `${projectName}'` : `${projectName}'s`;
  return fix.chatThreadId === null
    ? `No Patches chat hears it (${projectName} has no live chat)`
    : `No Patches chat hears it (its parent is not ${possessive} chat)`;
}
