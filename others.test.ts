import { describe, expect, it } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import {
  MAX_LOOSE_PROBES,
  OLDER_MS,
  closedTaskThreadIds,
  looseCandidates,
  otherAgentsView,
  othersOpen,
  savedFlag,
  type ListedThread,
  type OtherLiveness,
} from "./others";

const NOW = 1_800_000_000_000;

function thread(overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    id: "thr_a",
    projectId: "proj_f",
    title: "A",
    titleFallback: null,
    displayTitle: "A",
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "claude-code",
    status: "idle",
    runtimeStatus: "idle",
    queuedWork: "none",
    hasPendingInteraction: false,
    activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    pinnedAt: null,
    pinSortKey: null,
    isArchived: false,
    archivedAt: null,
    href: "/projects/proj_f/threads/thr_a",
    isHidden: false,
    environment: null,
    host: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastReadAt: null,
    latestAttentionAt: NOW,
    ...overrides,
  };
}

const view = (
  threads: PluginSidebarThread[],
  {
    owned = [],
    closed = [],
    live = {},
  }: { owned?: string[]; closed?: string[]; live?: Record<string, OtherLiveness> } = {},
) =>
  otherAgentsView({
    threads,
    ownedThreadIds: new Set(owned),
    closedThreadIds: new Set(closed),
    liveness: new Map(Object.entries(live)),
    now: NOW,
  });

const ids = (entries: { thread: PluginSidebarThread }[]) => entries.map((entry) => entry.thread.id);

describe("otherAgentsView", () => {
  it("leaves out owned, closed tasks' threads and their children, archived and hidden threads", () => {
    const result = view(
      [
        thread({ id: "owned" }),
        thread({ id: "closed-task" }),
        thread({ id: "closed-child", status: "active" }),
        thread({ id: "archived", isArchived: true }),
        thread({ id: "hidden", isHidden: true }),
        thread({ id: "loose" }),
      ],
      { owned: ["owned"], closed: ["closed-task", "closed-child"] },
    );
    expect(ids(result.entries)).toEqual(["loose"]);
    expect(result.older).toEqual([]);
    expect(result.count).toBe(1);
  });

  it("takes the server's state: working, waiting, idle, trouble with its reason; drops gone", () => {
    const result = view(
      [
        thread({ id: "w", status: "idle" }),
        thread({ id: "q" }),
        thread({ id: "i", status: "active" }),
        thread({ id: "b" }),
        thread({ id: "e" }),
        thread({ id: "s" }),
        thread({ id: "g" }),
      ],
      {
        live: {
          w: { state: "working", reason: null },
          q: { state: "waiting", reason: "queued to start" },
          i: { state: "idle", reason: null },
          b: { state: "blocked", reason: "can't receive messages" },
          e: { state: "error", reason: "stopped with an error: boom" },
          s: { state: "stale", reason: "no activity for 20 min" },
          g: { state: "gone", reason: "thread is gone" },
        },
      },
    );
    const byId = new Map(result.entries.map((entry) => [entry.thread.id, entry]));
    expect(byId.get("w")?.state).toBe("working");
    expect(byId.get("q")).toMatchObject({ state: "waiting", reason: "queued to start" });
    expect(byId.get("i")?.state).toBe("idle");
    expect(byId.get("b")).toMatchObject({ state: "trouble", reason: "can't receive messages" });
    expect(byId.get("e")).toMatchObject({ state: "trouble", reason: "stopped with an error: boom" });
    expect(byId.get("s")).toMatchObject({ state: "trouble", reason: "no activity for 20 min" });
    expect(byId.has("g")).toBe(false);
  });

  it("falls back to the sidebar thread without a server reading", () => {
    const result = view([thread({ id: "busy", status: "active" }), thread({ id: "err", status: "error" }), thread({ id: "calm" })]);
    const byId = new Map(result.entries.map((entry) => [entry.thread.id, entry]));
    expect(byId.get("busy")?.state).toBe("working");
    expect(byId.get("err")).toMatchObject({ state: "trouble", reason: "stopped with an error" });
    expect(byId.get("calm")?.state).toBe("idle");
  });

  it("an open question is needs-you unless the thread works or is in trouble", () => {
    const result = view(
      [
        thread({ id: "ask", hasPendingInteraction: true }),
        thread({ id: "ask-wait", indicator: "waiting-for-input", updatedAt: NOW - OLDER_MS * 3 }),
        thread({ id: "ask-busy", hasPendingInteraction: true, status: "active" }),
        thread({ id: "ask-bad", hasPendingInteraction: true }),
      ],
      { live: { "ask-bad": { state: "error", reason: "boom" } } },
    );
    const byId = new Map(result.entries.map((entry) => [entry.thread.id, entry]));
    expect(byId.get("ask")?.state).toBe("needs-you");
    // Old, but asking: never folded into Older.
    expect(byId.get("ask-wait")?.state).toBe("needs-you");
    expect(byId.get("ask-busy")?.state).toBe("working");
    expect(byId.get("ask-bad")?.state).toBe("trouble");
  });

  it("sorts trouble, working, needs you, waiting, idle; ties newest first", () => {
    const result = view(
      [
        thread({ id: "idle-new", updatedAt: NOW - 1 }),
        thread({ id: "idle-old", updatedAt: NOW - 1000 }),
        thread({ id: "wait", updatedAt: NOW - 5 }),
        thread({ id: "ask", hasPendingInteraction: true, updatedAt: NOW - 50 }),
        thread({ id: "work", status: "active", updatedAt: NOW - 500 }),
        thread({ id: "bad", status: "error", updatedAt: NOW - 5000 }),
      ],
      { live: { wait: { state: "waiting", reason: "queued" } } },
    );
    expect(ids(result.entries)).toEqual(["bad", "work", "ask", "wait", "idle-new", "idle-old"]);
  });

  it("folds idle threads older than 2 days into older, and the count leaves them out", () => {
    const result = view([
      thread({ id: "edge", updatedAt: NOW - OLDER_MS }),
      thread({ id: "past", updatedAt: NOW - OLDER_MS - 1 }),
      thread({ id: "old-working", status: "active", updatedAt: NOW - OLDER_MS * 5 }),
      thread({ id: "old-bad", status: "error", updatedAt: NOW - OLDER_MS * 5 }),
    ]);
    expect(OLDER_MS).toBe(2 * 24 * 60 * 60 * 1000);
    expect(ids(result.entries)).toEqual(["old-bad", "old-working", "edge"]);
    expect(ids(result.older)).toEqual(["past"]);
    expect(result.count).toBe(3);
  });

  it("an old waiting thread stays in entries", () => {
    const result = view([thread({ id: "w", updatedAt: NOW - OLDER_MS * 2 })], { live: { w: { state: "waiting", reason: "limit" } } });
    expect(ids(result.entries)).toEqual(["w"]);
    expect(result.hasActive).toBe(false);
  });

  it("hasActive only for working, trouble or needs you", () => {
    expect(view([thread({ id: "a" })]).hasActive).toBe(false);
    expect(view([thread({ id: "a", status: "active" })]).hasActive).toBe(true);
    expect(view([thread({ id: "a", status: "error" })]).hasActive).toBe(true);
    expect(view([thread({ id: "a", hasPendingInteraction: true })]).hasActive).toBe(true);
    // Working, but belonging to a closed task: not the owner's other agent.
    expect(view([thread({ id: "a", status: "active" })], { closed: ["a"] }).hasActive).toBe(false);
  });
});

describe("looseCandidates", () => {
  const listed = (id: string, overrides: Partial<ListedThread> = {}): ListedThread => ({
    id,
    archivedAt: null,
    deletedAt: null,
    visibility: "visible",
    updatedAt: NOW,
    ...overrides,
  });

  it("keeps listed, visible, unowned threads that run or were touched within 2 days", () => {
    const result = looseCandidates({
      threads: [
        listed("recent", { updatedAt: NOW - 10 }),
        listed("edge", { updatedAt: NOW - OLDER_MS }),
        listed("old", { updatedAt: NOW - OLDER_MS - 1 }),
        listed("old-running", { updatedAt: NOW - OLDER_MS * 4 }),
        listed("archived", { archivedAt: NOW }),
        listed("deleted", { deletedAt: NOW }),
        listed("hidden", { visibility: "hidden" }),
        listed("task-thread"),
      ],
      excludedIds: new Set(["task-thread"]),
      running: new Set(["old-running"]),
      now: NOW,
    });
    expect(result).toEqual(["old-running", "recent", "edge"]);
  });

  it("caps the probes at 40, most recent first", () => {
    const threads = Array.from({ length: 60 }, (_, n) => listed(`t${n}`, { updatedAt: NOW - n }));
    const result = looseCandidates({ threads, excludedIds: new Set(), running: new Set(), now: NOW });
    expect(MAX_LOOSE_PROBES).toBe(40);
    expect(result).toHaveLength(40);
    expect(result[0]).toBe("t0");
    expect(result[39]).toBe("t39");
  });
});

describe("closedTaskThreadIds", () => {
  it("lists closed tasks' threads and every child of a closed task, nothing of open ones", () => {
    const ids = closedTaskThreadIds(
      [
        { id: "done", threadId: "thr_done", closedAt: 1 },
        { id: "no-thread", threadId: null, closedAt: 1 },
        { id: "open", threadId: "thr_open", closedAt: null },
      ],
      [
        { taskId: "done", threadId: "thr_done_build" },
        { taskId: "no-thread", threadId: "thr_orphan_research" },
        { taskId: "open", threadId: "thr_open_build" },
      ],
    );
    expect(ids.sort()).toEqual(["thr_done", "thr_done_build", "thr_orphan_research"]);
  });
});

describe("Other agents open state", () => {
  it("The owner's saved choice wins; unset opens only while something is active", () => {
    expect(savedFlag("1")).toBe(true);
    expect(savedFlag("0")).toBe(false);
    expect(savedFlag(null)).toBe(null);
    expect(savedFlag("yes")).toBe(null);
    expect(othersOpen(null, true)).toBe(true);
    expect(othersOpen(null, false)).toBe(false);
    expect(othersOpen(false, true)).toBe(false);
    expect(othersOpen(true, false)).toBe(true);
  });
});
