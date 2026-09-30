import { describe, expect, it } from "vitest";
import { boardScope, inScope, scopeThread, showsChat, showsProjectSections, taskThreads, type BoardScope } from "./scope";

const base = {
  newTaskPath: "new",
  tasks: [
    { id: "t1", threadId: "thr_t1" },
    { id: "t2", threadId: "thr_t2" },
    { id: "t3", threadId: null },
  ],
  children: [
    { taskId: "t1", threadId: "thr_r1" },
    { taskId: "t1", threadId: "thr_b1" },
    { taskId: "t_closed", threadId: "thr_old" },
  ],
  patchesChats: [
    { projectId: "p_a", threadId: "thr_pa" },
    { projectId: "p_b", threadId: "thr_pb" },
  ],
  liveThreadIds: new Set(["thr_t1", "thr_r1", "thr_b1", "thr_pa", "thr_pb", "thr_other", "thr_old"]),
};

const scope = (subPath: string) => boardScope({ ...base, subPath });

describe("boardScope", () => {
  it("shows the project board, with no chat, on the bare route", () => {
    expect(scope("")).toEqual({ kind: "project" });
  });

  it("composes a new task on the new-task path", () => {
    expect(scope("new")).toEqual({ kind: "compose" });
  });

  it("shows the project board, not the chat, for a project's Patches chat thread", () => {
    expect(scope("thr_pa")).toEqual({ kind: "project" });
    expect(scope("thr_pb")).toEqual({ kind: "project" });
  });

  it("scopes a task's own thread to that task", () => {
    expect(scope("thr_t1")).toEqual({ kind: "task", taskId: "t1", threadId: "thr_t1" });
  });

  it("scopes a task just started with + before the host lists its thread", () => {
    expect(scope("thr_t2")).toEqual({ kind: "task", taskId: "t2", threadId: "thr_t2" });
  });

  it("keeps a research or build thread on its task", () => {
    expect(scope("thr_r1")).toEqual({ kind: "task", taskId: "t1", threadId: "thr_r1" });
    expect(scope("thr_b1")).toEqual({ kind: "task", taskId: "t1", threadId: "thr_b1" });
  });

  it("treats a child of a task that is no longer open as another agent's thread", () => {
    expect(scope("thr_old")).toEqual({ kind: "other", threadId: "thr_old" });
  });

  it("shows another agent's listed thread as other", () => {
    expect(scope("thr_other")).toEqual({ kind: "other", threadId: "thr_other" });
  });

  it("falls back to the project board for a thread nobody lists", () => {
    expect(scope("thr_unknown")).toEqual({ kind: "project" });
  });

  it("opens a closed task by its own route, with or without one of its threads", () => {
    expect(scope("closed:t_closed")).toEqual({ kind: "closed", taskId: "t_closed", threadId: null });
    expect(scope("closed:t_closed:thr_gone")).toEqual({ kind: "closed", taskId: "t_closed", threadId: "thr_gone" });
  });

  it("resolves the closed route before everything else, even when it names a live thread or is the new-task path", () => {
    expect(scope("closed:t1:thr_t1")).toEqual({ kind: "closed", taskId: "t1", threadId: "thr_t1" });
    expect(boardScope({ ...base, newTaskPath: "closed:t9", subPath: "closed:t9" })).toEqual({
      kind: "closed",
      taskId: "t9",
      threadId: null,
    });
  });

  it("does not take a malformed closed route for a closed task", () => {
    for (const path of ["closed", "closed:", "closed:t1:", "closed:t1:thr:extra", "Closed:t1"]) {
      expect(scope(path)).toEqual({ kind: "project" });
    }
  });
});

describe("scope layout", () => {
  const all: BoardScope[] = [
    { kind: "project" },
    { kind: "compose" },
    { kind: "task", taskId: "t1", threadId: "thr_r1" },
    { kind: "other", threadId: "thr_other" },
  ];

  it("has a chat column everywhere but the project board", () => {
    expect(all.map(showsChat)).toEqual([false, true, true, true]);
  });

  it("hides the project-wide sections only in a task", () => {
    expect(all.map(showsProjectSections)).toEqual([true, true, false, true]);
  });

  it("names the thread the chat column shows", () => {
    expect(all.map(scopeThread)).toEqual([null, null, "thr_r1", "thr_other"]);
  });

  it("gives a closed task a chat column on its thread and none of the project-wide sections", () => {
    const bare: BoardScope = { kind: "closed", taskId: "t9", threadId: null };
    const onThread: BoardScope = { kind: "closed", taskId: "t9", threadId: "thr_gone" };
    expect([bare, onThread].map(showsChat)).toEqual([true, true]);
    expect([bare, onThread].map(showsProjectSections)).toEqual([false, false]);
    expect([bare, onThread].map(scopeThread)).toEqual([null, "thr_gone"]);
  });
});

describe("inScope", () => {
  const needs = [
    { key: "a", taskId: "t1" },
    { key: "b", taskId: "t2" },
    { key: "c", taskId: null },
    { key: "d", taskId: "t1" },
  ];
  const taskIdOf = (item: { taskId: string | null }) => item.taskId;

  it("keeps only the task's own items in a task", () => {
    const keys = inScope({ kind: "task", taskId: "t1", threadId: "thr_b1" }, needs, taskIdOf).map((item) => item.key);
    expect(keys).toEqual(["a", "d"]);
  });

  it("keeps everything outside a task", () => {
    for (const outside of [
      { kind: "project" },
      { kind: "compose" },
      { kind: "other", threadId: "thr_other" },
    ] as BoardScope[]) {
      expect(inScope(outside, needs, taskIdOf)).toEqual(needs);
    }
  });

  it("keeps nothing in a closed task, not even items carrying its own id", () => {
    expect(inScope({ kind: "closed", taskId: "t1", threadId: null }, needs, taskIdOf)).toEqual([]);
    expect(inScope({ kind: "closed", taskId: "t9", threadId: "thr_gone" }, needs, taskIdOf)).toEqual([]);
  });
});

describe("taskThreads", () => {
  const task = { id: "t1", title: "Tiers", threadId: "thr_t1" };
  const children = [
    { taskId: "t1", threadId: "thr_r1", kind: "research" as const, label: "prices" },
    { taskId: "t2", threadId: "thr_x", kind: "research" as const, label: "not mine" },
    { taskId: "t1", threadId: "thr_b1", kind: "build" as const, label: "task/tiers" },
    { taskId: "t1", threadId: "thr_gone", kind: "build" as const, label: "old" },
  ];
  const liveThreadIds = new Set(["thr_t1", "thr_r1", "thr_b1", "thr_x"]);

  it("lists the task thread, then its own live research and build threads, marking the open one", () => {
    expect(taskThreads({ task, children, liveThreadIds, currentThreadId: "thr_b1" })).toEqual([
      { threadId: "thr_t1", kind: "task", label: "Tiers", current: false },
      { threadId: "thr_r1", kind: "research", label: "Research: prices", current: false },
      { threadId: "thr_b1", kind: "build", label: "Build: task/tiers", current: true },
    ]);
  });

  it("keeps an unlisted child while it is the one open", () => {
    const list = taskThreads({ task, children, liveThreadIds, currentThreadId: "thr_gone" });
    expect(list.map((entry) => entry.threadId)).toEqual(["thr_t1", "thr_r1", "thr_b1", "thr_gone"]);
    expect(list[0]?.current).toBe(false);
  });

  it("marks the task thread current and skips it when the task has none yet", () => {
    expect(taskThreads({ task, children: [], liveThreadIds, currentThreadId: "thr_t1" })).toEqual([
      { threadId: "thr_t1", kind: "task", label: "Tiers", current: true },
    ]);
    expect(taskThreads({ task: { ...task, threadId: null }, children: [], liveThreadIds, currentThreadId: null })).toEqual([]);
  });
});
