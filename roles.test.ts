import { describe, expect, it } from "vitest";
import { threadRole } from "./roles";
import type { Child, Task } from "./store";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_a",
    projectId: "proj_o",
    title: "T",
    brief: "b",
    stage: "research",
    threadId: null,
    branch: null,
    baseRef: null,
    worktreePath: null,
    worktreeNote: null,
    buildState: "none",
    buildError: null,
    buildFailures: 0,
    buildRequest: null,
    prNumber: null,
    prUrl: null,
    headSha: null,
    verdict: null,
    verifiedSha: null,
    decisions: [],
    testList: [],
    note: null,
    createdAt: 1,
    updatedAt: 1,
    closedAt: null,
    ...overrides,
  };
}

const child = (overrides: Partial<Child> = {}): Child => ({
  threadId: "thr_child",
  taskId: "task_a",
  kind: "build",
  label: "task/x",
  summary: null,
  createdAt: 1,
  ...overrides,
});

function role(args: {
  threadId?: string;
  parentThreadId?: string | null;
  metadata?: Record<string, unknown>;
  taskByThread?: Task | null;
  child?: Child | null;
  tasks?: Task[];
}) {
  const tasks = args.tasks ?? [];
  return threadRole({
    threadId: args.threadId ?? "thr_new",
    parentThreadId: args.parentThreadId ?? null,
    metadata: args.metadata ?? {},
    taskByThread: args.taskByThread ?? null,
    child: args.child ?? null,
    task: (id) => tasks.find((t) => t.id === id) ?? null,
  });
}

describe("threadRole", () => {
  it("a task thread bb configures mid-spawn, before the dossier has its id, is still the task's", () => {
    // The bug: every task thread started with no build/land tools and no instructions.
    const pending = task({ threadId: null });
    expect(role({ metadata: { role: "task", taskId: "task_a" }, tasks: [pending] })).toEqual({ kind: "task", task: pending });
  });

  it("the dossier's own record wins, and a closed task gets nothing", () => {
    const mine = task({ threadId: "thr_new" });
    expect(role({ taskByThread: mine })).toEqual({ kind: "task", task: mine });
    expect(role({ taskByThread: task({ threadId: "thr_new", closedAt: 5 }), metadata: { role: "task", taskId: "task_a" } })).toBeNull();
  });

  it("metadata cannot take over a task that already has its thread, or a closed or unknown one", () => {
    const meta = { role: "task", taskId: "task_a" };
    expect(role({ metadata: meta, tasks: [task({ threadId: "thr_other" })] })).toBeNull();
    expect(role({ metadata: meta, tasks: [task({ closedAt: 9 })] })).toBeNull();
    expect(role({ metadata: meta, tasks: [] })).toBeNull();
    expect(role({ metadata: { role: "task", taskId: 7 }, tasks: [task()] })).toBeNull();
    expect(role({ metadata: { role: "patches", taskId: "task_a" }, tasks: [task()] })).toBeNull();
  });

  it("a builder or researcher configured mid-spawn is its task's child when it hangs under the task thread", () => {
    const owner = task({ threadId: "thr_task" });
    expect(role({ parentThreadId: "thr_task", metadata: { role: "build", taskId: "task_a" }, tasks: [owner] })).toEqual({ kind: "build", owner });
    expect(role({ parentThreadId: "thr_task", metadata: { role: "research", taskId: "task_a" }, tasks: [owner] })).toEqual({ kind: "research", owner });
    expect(role({ parentThreadId: "thr_elsewhere", metadata: { role: "build", taskId: "task_a" }, tasks: [owner] })).toBeNull();
    expect(role({ threadId: "thr_task", parentThreadId: "thr_task", metadata: { role: "build", taskId: "task_a" }, tasks: [owner] })).toBeNull();
    expect(role({ parentThreadId: null, metadata: { role: "build", taskId: "task_a" }, tasks: [task({ threadId: null })] })).toBeNull();
  });

  it("a recorded child keeps its kind and owner", () => {
    const owner = task({ threadId: "thr_task" });
    expect(role({ threadId: "thr_child", child: child({ kind: "research" }), tasks: [owner] })).toEqual({ kind: "research", owner });
    expect(role({ threadId: "thr_child", child: child(), tasks: [] })).toBeNull();
  });
});
