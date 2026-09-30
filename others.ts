// "Other agents": every thread that is not a Patches chat and not part of an
// open task, with its live state from the server's liveness check. Pure;
// others.test.ts pins it. A closed task's threads are not "other": they are
// reachable from that task under Completed. Display only: nothing here tells,
// stops or tickets a loose thread.
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { isAsking, isWorking } from "./model";

/**
 * An idle loose thread the owner has not touched since the day before yesterday is
 * history: it folds into "Older". 3 days let the stale entries through (a
 * Friday's leftovers still listed on Monday); 2 keeps yesterday's work in view.
 */
export const OLDER_MS = 2 * 24 * 60 * 60 * 1000;
/** Loose threads the server probes per liveness beat, most recent first. */
export const MAX_LOOSE_PROBES = 40;

export type OtherState = "working" | "waiting" | "needs-you" | "idle" | "trouble";

/** The server's liveness for a loose thread (liveness.ts agentLiveness, role dropped). */
export interface OtherLiveness {
  state: "working" | "waiting" | "idle" | "blocked" | "stale" | "error" | "gone";
  reason: string | null;
}

export interface OtherEntry {
  thread: PluginSidebarThread;
  state: OtherState;
  reason: string | null;
  lastActivity: number;
}

export interface OtherAgentsView {
  entries: OtherEntry[];
  /** Idle entries untouched for more than OLDER_MS: the "Older" line. */
  older: OtherEntry[];
  /** What the sidebar's "Other agents" row shows: entries only. */
  count: number;
  /** Something in the section is working, in trouble or needs the owner: it opens by default. */
  hasActive: boolean;
}

const RANK: Record<OtherState, number> = { trouble: 0, working: 1, "needs-you": 2, waiting: 3, idle: 4 };

function entryFor(thread: PluginSidebarThread, live: OtherLiveness | undefined): OtherEntry | null {
  let state: OtherState;
  let reason: string | null = null;
  if (live !== undefined) {
    if (live.state === "gone") return null;
    if (live.state === "working") state = "working";
    else if (live.state === "waiting") {
      state = "waiting";
      reason = live.reason;
    } else if (live.state === "idle") state = "idle";
    else {
      state = "trouble";
      reason = live.reason ?? live.state;
    }
  } else if (isWorking(thread)) state = "working";
  else if (thread.status === "error") {
    state = "trouble";
    reason = "stopped with an error";
  } else state = "idle";
  // A question in the thread is the owner's, unless it is running or stuck.
  if (isAsking(thread) && state !== "trouble" && state !== "working") {
    state = "needs-you";
    reason = null;
  }
  return { thread, state, reason, lastActivity: thread.updatedAt };
}

export function otherAgentsView(args: {
  threads: readonly PluginSidebarThread[];
  /** Patches chats, open tasks' threads and their children. */
  ownedThreadIds: ReadonlySet<string>;
  /** Threads of closed tasks and their children. */
  closedThreadIds: ReadonlySet<string>;
  liveness: ReadonlyMap<string, OtherLiveness>;
  now: number;
}): OtherAgentsView {
  const { threads, ownedThreadIds, closedThreadIds, liveness, now } = args;
  const all: OtherEntry[] = [];
  for (const thread of threads) {
    if (ownedThreadIds.has(thread.id) || closedThreadIds.has(thread.id) || thread.isArchived || thread.isHidden) continue;
    const entry = entryFor(thread, liveness.get(thread.id));
    if (entry !== null) all.push(entry);
  }
  all.sort((a, b) => RANK[a.state] - RANK[b.state] || b.lastActivity - a.lastActivity);
  const isOlder = (entry: OtherEntry) => entry.state === "idle" && now - entry.lastActivity > OLDER_MS;
  const entries = all.filter((entry) => !isOlder(entry));
  return {
    entries,
    older: all.filter(isOlder),
    count: entries.length,
    hasActive: entries.some((entry) => entry.state === "working" || entry.state === "trouble" || entry.state === "needs-you"),
  };
}

/** A thread as bb's thread list gives it, as much as the candidate filter reads. */
export interface ListedThread {
  id: string;
  archivedAt: number | null;
  deletedAt: number | null;
  visibility: "visible" | "hidden";
  updatedAt: number;
}

/**
 * The loose threads the liveness check probes: listed, not archived or hidden,
 * not a Patches chat or any task's (open or closed) thread or child, and
 * running or touched within OLDER_MS. Running first, then most recent, at most
 * MAX_LOOSE_PROBES.
 */
export function looseCandidates(args: {
  threads: readonly ListedThread[];
  /** Patches chats, and every task's thread and children, open or closed. */
  excludedIds: ReadonlySet<string>;
  running: ReadonlySet<string>;
  now: number;
}): string[] {
  const { threads, excludedIds, running, now } = args;
  return threads
    .filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.deletedAt === null &&
        thread.visibility !== "hidden" &&
        !excludedIds.has(thread.id) &&
        (running.has(thread.id) || now - thread.updatedAt <= OLDER_MS),
    )
    .sort((a, b) => Number(running.has(b.id)) - Number(running.has(a.id)) || b.updatedAt - a.updatedAt)
    .slice(0, MAX_LOOSE_PROBES)
    .map((thread) => thread.id);
}

/** Thread ids of every closed task and of its children: reachable under Completed, never "other". */
export function closedTaskThreadIds(
  tasks: readonly { id: string; threadId: string | null; closedAt: number | null }[],
  children: readonly { taskId: string; threadId: string }[],
): string[] {
  const closed = new Set(tasks.filter((task) => task.closedAt !== null).map((task) => task.id));
  const ids = new Set<string>();
  for (const task of tasks) if (closed.has(task.id) && task.threadId !== null) ids.add(task.threadId);
  for (const child of children) if (closed.has(child.taskId)) ids.add(child.threadId);
  return [...ids];
}

/** The dossier meta key holding the owner's Other agents open/closed choice. */
export const UI_OTHER_AGENTS_OPEN_KEY = "ui_other_agents_open";

/** A saved "1"/"0" choice; null when the owner has not chosen (or the value is unreadable). */
export function savedFlag(value: string | null): boolean | null {
  return value === "1" ? true : value === "0" ? false : null;
}

/** Other agents is open by the owner's saved choice, else while something in it is active. */
export function othersOpen(saved: boolean | null, hasActive: boolean): boolean {
  return saved ?? hasActive;
}
