// The Orchestrator's sidebar list, in place of the host's thread list: one row
// per project (it opens the project's board, not its Patches chat), and under
// the project in view its open tasks with their research and build threads.
// Pure, so the rows and the one-time switch are tested without a browser.
import { focusedProject } from "./chats";
import type { Indicator } from "./liveness";
import type { TabBadge } from "./model";

/** Registration id of the sidebar list; the host names it `<pluginId>/chats`. */
export const THREAD_LIST_ID = "chats";

/** The host's own list, and the legacy values that resolve to it. */
export const DEFAULT_THREAD_LIST_PROVIDERS: readonly string[] = [
  "thread-list/thread-list",
  "__automatic__",
  "__builtin__",
];

export const threadListProviderId = (pluginId: string) => `${pluginId}/${THREAD_LIST_ID}`;

/**
 * Switch the sidebar to our list at most once: only while it still shows the
 * host's default and the dossier has no record of a switch. A choice the owner made
 * in Settings → Appearance, before or after, is theirs and stays.
 */
export function shouldAdoptSidebar(current: string, alreadyAdopted: boolean): boolean {
  if (alreadyAdopted) return false;
  return DEFAULT_THREAD_LIST_PROVIDERS.includes(current);
}

const NO_BADGE: TabBadge = { needsYou: 0, working: 0 };

export interface SidebarChatRow {
  kind: "chat";
  key: string;
  projectId: string;
  name: string;
  threadId: string | null;
  badge: TabBadge;
  unread: boolean;
  /** The project the board shows. */
  focused: boolean;
  /** The route shows the project's Patches chat (opened from the board). */
  active: boolean;
}

export interface SidebarTaskRow {
  kind: "task";
  key: string;
  projectId: string;
  title: string;
  threadId: string;
  /** 0 for the task, 1 for its research and build threads. */
  depth: 0 | 1;
  active: boolean;
  /** Spinner, waiting or trouble (liveness.ts); null when nothing runs. */
  indicator: Indicator;
}

export interface SidebarAgentsRow {
  kind: "agents";
  key: "agents";
  count: number;
}

export type SidebarRow = SidebarChatRow | SidebarTaskRow | SidebarAgentsRow;

export interface SidebarInput {
  projects: readonly { id: string; name: string; hidden: boolean }[];
  patchesChats: readonly { projectId: string; threadId: string; unread: boolean }[];
  /** Open tasks only. */
  tasks: readonly { id: string; projectId: string; title: string; threadId: string | null }[];
  children: readonly { taskId: string; threadId: string; kind: "research" | "build"; label: string }[];
  /** Thread ids the host still lists (not archived); a child outside it is not shown. */
  liveThreadIds: ReadonlySet<string>;
  badges: ReadonlyMap<string, TabBadge>;
  /** By thread id: the task's indicator on its task thread, each child's on its own. */
  indicators?: ReadonlyMap<string, Indicator>;
  focusProjectId: string | null;
  activeThreadId: string | null;
  /** others.ts otherAgentsView count: active or loose-and-recent, never a closed task's threads. */
  otherAgents: number;
}

/**
 * The project whose tasks the list opens: the one the active thread belongs to
 * (a chat, a task or one of its children), else the chat the board shows
 * (focusedProject: a gone or unset focus is the first visible project).
 */
export function expandedProject(input: SidebarInput): string | null {
  const active = input.activeThreadId;
  if (active !== null) {
    const chat = input.patchesChats.find((entry) => entry.threadId === active);
    if (chat !== undefined) return chat.projectId;
    const taskId = input.children.find((child) => child.threadId === active)?.taskId;
    const task = input.tasks.find((entry) => entry.threadId === active || entry.id === taskId);
    if (task !== undefined) return task.projectId;
  }
  return focusedProject(input.focusProjectId, input.projects);
}

export function sidebarRows(input: SidebarInput): SidebarRow[] {
  const focus = focusedProject(input.focusProjectId, input.projects);
  const expanded = expandedProject(input);
  const chatFor = (projectId: string) => input.patchesChats.find((chat) => chat.projectId === projectId);
  const tasksUnder = (projectId: string): SidebarTaskRow[] =>
    input.tasks
      .filter((task) => task.threadId !== null && task.projectId === projectId)
      .flatMap((task) => [
        {
          kind: "task" as const,
          key: `task:${task.id}`,
          projectId: task.projectId,
          title: task.title,
          threadId: task.threadId as string,
          depth: 0 as const,
          active: task.threadId === input.activeThreadId,
          indicator: input.indicators?.get(task.threadId as string) ?? null,
        },
        ...input.children
          .filter((child) => child.taskId === task.id && input.liveThreadIds.has(child.threadId))
          .map((child) => ({
            kind: "task" as const,
            key: `child:${child.threadId}`,
            projectId: task.projectId,
            title: `${child.kind === "research" ? "Research" : "Build"}: ${child.label}`,
            threadId: child.threadId,
            depth: 1 as const,
            active: child.threadId === input.activeThreadId,
            indicator: input.indicators?.get(child.threadId) ?? null,
          })),
      ]);
  const chat = (projectId: string, name: string): SidebarChatRow => {
    const entry = chatFor(projectId);
    return {
      kind: "chat",
      key: `chat:${projectId}`,
      projectId,
      name,
      threadId: entry?.threadId ?? null,
      badge: input.badges.get(projectId) ?? NO_BADGE,
      unread: entry?.unread ?? false,
      focused: projectId === focus,
      active: entry !== undefined && entry.threadId === input.activeThreadId,
    };
  };

  const rows: SidebarRow[] = [];
  for (const project of input.projects) {
    // A hidden project keeps its row while it is the one in view.
    if (project.hidden && project.id !== expanded && project.id !== focus) continue;
    rows.push(chat(project.id, project.name));
    if (project.id === expanded) rows.push(...tasksUnder(project.id));
  }
  rows.push({ kind: "agents", key: "agents", count: input.otherAgents });
  return rows;
}
