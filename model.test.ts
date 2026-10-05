import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { BUILD_FAILURE_LIMIT } from "./attention";
import type { PullRequest } from "./contract";
import {
  PALETTE,
  answeredTaskPatch,
  assignColors,
  buildsInFlight,
  completionLabel,
  completionOf,
  needsYou,
  notPlanning,
  prForTask,
  tabBadges,
  taskRow,
  untrackedPullRequests,
} from "./model";
import type { AgentLiveness, TaskLiveness } from "./liveness";
import type { Child, Task, Ticket } from "./store";
import { setOwner } from "./owner";

// The name is whoever runs it (owner.ts): a neutral one here, the fallback after.
beforeEach(() => setOwner("Alex"));
afterEach(() => setOwner(null));

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

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task_1",
    projectId: "proj_f",
    title: "Subscription tiers",
    brief: "b",
    stage: "research",
    threadId: "thr_task",
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
    createdAt: NOW,
    updatedAt: NOW,
    closedAt: null,
    ...overrides,
  };
}

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "tkt_1",
    taskId: "task_1",
    kind: "questions",
    questions: ["Q1?", "Q2?", "Q3?"],
    asks: [],
    answers: null,
    status: "open",
    createdAt: NOW,
    closedAt: null,
    ...overrides,
  };
}

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 55,
    title: "PR",
    url: "https://github.com/o/r/pull/55",
    state: "open",
    isDraft: false,
    headRefName: "task/tiers",
    headRefOid: "cc65f6a0000000",
    updatedAt: NOW,
    checks: "passing",
    failedConclusions: [],
    mergeable: "mergeable",
    mergeStateStatus: "CLEAN",
    labels: [],
    previewSha: "cc65f6a",
    ...overrides,
  };
}

describe("needsYou", () => {
  it("folds every question, a native ask and a review into ONE ticket per task", () => {
    const items = needsYou({
      tasks: [task({ prNumber: 55 })],
      tickets: [ticket(), ticket({ id: "tkt_r", kind: "review", questions: [] })],
      children: [{ threadId: "thr_build", taskId: "task_1", kind: "build", label: "b", summary: null, createdAt: NOW }],
      threads: [thread({ id: "thr_build", hasPendingInteraction: true })],
      ownedThreadIds: new Set(["thr_task", "thr_build"]),
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      taskId: "task_1",
      tone: "attention",
      threadId: "thr_build",
      questionTicketId: "tkt_1",
      reviewTicketId: "tkt_r",
    });
    expect(items[0]?.summary).toBe(
      "Subscription tiers · 3 questions · waiting on you in chat · PR #55 ready: test and merge",
    );
  });

  it("never shows a merge ask for an unproven head: a stale review ticket is left out", () => {
    const list = (reviewStale: (t: Task) => string | null) =>
      needsYou({
        tasks: [task({ prNumber: 62 })],
        tickets: [ticket({ id: "tkt_r", kind: "review", questions: [] })],
        children: [],
        threads: [],
        ownedThreadIds: new Set(["thr_task"]),
        reviewStale,
      });
    expect(list(() => null)).toHaveLength(1);
    expect(list(() => "head moved to ab347a5 (proven 8bfbbe3)")).toEqual([]);
  });

  it("still shows a task's questions when only its review went stale", () => {
    const items = needsYou({
      tasks: [task({ prNumber: 62 })],
      tickets: [ticket(), ticket({ id: "tkt_r", kind: "review", questions: [] })],
      children: [],
      threads: [],
      ownedThreadIds: new Set(["thr_task"]),
      reviewStale: () => "CI failing on ab347a5",
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ reviewTicketId: null, questionTicketId: "tkt_1" });
    expect(items[0]?.summary).not.toContain("test and merge");
  });

  it("lists loose agents blocked on the owner after task tickets, and skips owned ones", () => {
    const items = needsYou({
      tasks: [task({ prNumber: 55 })],
      tickets: [ticket({ id: "tkt_r", kind: "review", questions: [] })],
      children: [],
      threads: [thread({ id: "loose", hasPendingInteraction: true }), thread({ id: "thr_task", hasPendingInteraction: true })],
      ownedThreadIds: new Set(["thr_task"]),
    });
    expect(items.map((item) => item.key)).toEqual(["task:task_1", "thread:loose"]);
  });

  it("keeps a failed build off the owner's list until the task has tried BUILD_FAILURE_LIMIT times", () => {
    const list = (buildFailures: number) =>
      needsYou({
        tasks: [task({ buildState: "failed", buildError: "npm ci: EALLOWSCRIPTS\ntail", buildFailures })],
        tickets: [],
        children: [],
        threads: [],
        ownedThreadIds: new Set(),
      });
    expect(list(1)).toEqual([]);
    expect(list(2)).toHaveLength(1);
    expect(list(2)[0]).toMatchObject({
      tone: "danger",
      buildFailed: true,
      asking: false,
      summary: "Subscription tiers · build failed 2×: npm ci: EALLOWSCRIPTS",
    });
  });

  it("brings the owner a task whose own thread is in trouble, but not a child's trouble the task owns", () => {
    const list = (samMustAct: boolean) =>
      needsYou({
        tasks: [task()],
        tickets: [],
        children: [],
        threads: [],
        ownedThreadIds: new Set(),
        trouble: new Map([
          [
            "task_1",
            [{ kind: "stale" as const, threadId: "thr_task", role: "task" as const, reason: "Task went silent: no activity for 14 min", samMustAct }],
          ],
        ]),
      });
    expect(list(false)).toEqual([]);
    expect(list(true)).toMatchObject([
      {
        tone: "danger",
        agentTrouble: "Task went silent: no activity for 14 min",
        agentBlocked: false,
        buildFailed: false,
        summary: "Subscription tiers · Task went silent: no activity for 14 min",
      },
    ]);
  });

  it("marks a blocked task thread so the board does not offer Restart", () => {
    const [item] = needsYou({
      tasks: [task()],
      tickets: [],
      children: [],
      threads: [],
      ownedThreadIds: new Set(),
      trouble: new Map([
        ["task_1", [{ kind: "blocked" as const, threadId: "thr_task", role: "task" as const, reason: "Task can't receive messages: x", samMustAct: true }]],
      ]),
    });
    expect(item).toMatchObject({ tone: "danger", agentTrouble: "Task can't receive messages: x", agentBlocked: true });
  });

  it("says nothing for a task with nothing waiting", () => {
    expect(
      needsYou({ tasks: [task()], tickets: [], children: [], threads: [], ownedThreadIds: new Set() }),
    ).toEqual([]);
  });

  it("drops a task once the owner answers its ticket, even after a failed build", () => {
    const failed = task({ buildState: "failed", buildError: "could not start", buildFailures: BUILD_FAILURE_LIMIT });
    const before = needsYou({ tasks: [failed], tickets: [ticket()], children: [], threads: [], ownedThreadIds: new Set() });
    expect(before).toMatchObject([{ buildFailed: true, questionTicketId: "tkt_1" }]);
    const answered = { ...failed, ...answeredTaskPatch(failed) };
    expect(
      needsYou({
        tasks: [answered],
        tickets: [ticket({ status: "closed", answers: ["a", "b", "c"], closedAt: NOW })],
        children: [],
        threads: [],
        ownedThreadIds: new Set(),
      }),
    ).toEqual([]);
  });
});

describe("answeredTaskPatch", () => {
  it("hands a failed build back to the task's agent", () => {
    expect(answeredTaskPatch(task({ buildState: "failed", buildError: "x" }))).toEqual({
      buildState: "none",
      buildError: null,
      buildFailures: 0,
    });
  });

  it("leaves a live or absent build alone", () => {
    expect(answeredTaskPatch(task({ buildState: "running" }))).toEqual({});
    expect(answeredTaskPatch(task({ buildState: "none" }))).toEqual({});
  });
});

describe("taskRow", () => {
  const threads = (list: PluginSidebarThread[]) => new Map(list.map((t) => [t.id, t]));

  it("animates Research while the task thread plans", () => {
    const row = taskRow({
      task: task(),
      threads: threads([thread({ id: "thr_task", status: "active" })]),
      children: [],
      tickets: [],
      pullRequests: [],
    });
    expect(row.research).toMatchObject({ state: "working", threadId: "thr_task" });
    expect(row.working).toBe(true);
  });

  it("says Planning only while the task thread runs, and why not otherwise", () => {
    // The bug: four finished tasks sat on the board as "Planning" with nothing running.
    const row = (overrides: { task?: Partial<Task>; threads?: PluginSidebarThread[]; tickets?: Ticket[]; liveness?: TaskLiveness }) =>
      taskRow({
        task: task(overrides.task),
        threads: threads(overrides.threads ?? [thread({ id: "thr_task", status: "idle" })]),
        children: [],
        tickets: overrides.tickets ?? [],
        pullRequests: [],
        liveness: overrides.liveness,
      }).research;
    const live = (state: AgentLiveness["state"]): TaskLiveness => ({
      taskId: "task_1",
      working: state === "working",
      waiting: null,
      trouble: [],
      agents: [{ threadId: "thr_task", role: "task", state, reason: null }],
      unheard: null,
    });

    expect(row({})).toEqual({ state: "pending", label: "Idle · waiting on Patches", threadId: "thr_task" });
    expect(row({ threads: [] })).toMatchObject({ label: "Idle · waiting on Patches" });
    expect(row({ liveness: live("idle") })).toMatchObject({ label: "Idle · waiting on Patches" });
    // The sidebar can lag the liveness check, and the other way round: either running is planning.
    expect(row({ threads: [], liveness: live("working") })).toMatchObject({ state: "working", label: "Planning" });
    expect(row({ liveness: live("waiting") })).toEqual({ state: "pending", label: "Waiting to plan", threadId: "thr_task" });
    expect(row({ liveness: live("stale") })).toMatchObject({ state: "failed", label: "Not running" });
    expect(row({ liveness: live("blocked") })).toMatchObject({ state: "failed", label: "Not running" });
    expect(row({ tickets: [ticket()] })).toMatchObject({ state: "blocked", label: "Waiting on Alex" });
    expect(row({ threads: [thread({ id: "thr_task", hasPendingInteraction: true })] })).toMatchObject({ state: "blocked", label: "Waiting on Alex" });
    expect(row({ task: { note: "Fixed, landed on main as `a94a2f1c`, plugin reloaded." } })).toEqual({
      state: "pending",
      label: "Says landed a94a2f1, not closed",
      threadId: "thr_task",
    });
    // A question outranks a landing claim: it is what the owner has to do.
    expect(row({ task: { note: "landed a94a2f1" }, tickets: [ticket()] })).toMatchObject({ label: "Waiting on Alex" });
    // Another task's liveness entry does not count.
    const other = { ...live("working"), agents: [{ threadId: "thr_else", role: "task" as const, state: "working" as const, reason: null }] };
    expect(row({ liveness: other })).toMatchObject({ label: "Idle · waiting on Patches" });
  });

  it("shows a done report that names work left as Done, with a follow-up", () => {
    const row = (overrides: { followUp?: string | null; tickets?: Ticket[]; running?: boolean; note?: string }) =>
      taskRow({
        task: task({ note: overrides.note ?? null }),
        threads: threads([thread({ id: "thr_task", status: overrides.running === true ? "active" : "idle" })]),
        children: [],
        tickets: overrides.tickets ?? [],
        pullRequests: [],
        followUp: overrides.followUp,
      }).research;
    const item = "Left: unset DEMO_LOGIN after the demo";
    expect(row({ followUp: item })).toEqual({ state: "done", label: "Done, with a follow-up", threadId: "thr_task" });
    // Not while it runs, and a question for the owner comes first.
    expect(row({ followUp: item, running: true })).toMatchObject({ state: "working", label: "Planning" });
    expect(row({ followUp: item, tickets: [ticket()] })).toMatchObject({ label: "Waiting on Alex" });
    // It outranks a landing claim and idleness.
    expect(row({ followUp: item, note: "landed a94a2f1" })).toMatchObject({ label: "Done, with a follow-up" });
    expect(row({ followUp: null })).toMatchObject({ label: "Idle · waiting on Patches" });
    expect(row({})).toMatchObject({ label: "Idle · waiting on Patches" });
    expect(notPlanning({ task: { note: null }, questions: 0, asking: false, taskAgent: undefined, followUp: item })).toEqual({
      state: "done",
      label: "Done, with a follow-up",
    });
    expect(notPlanning({ task: { note: null }, questions: 0, asking: false, taskAgent: undefined })).toMatchObject({
      label: "Idle · waiting on Patches",
    });
  });

  it("shows a task kept open between its steps as idle with the steps left, not planning", () => {
    const row = (overrides: { stepsLeft?: number; tickets?: Ticket[]; running?: boolean; note?: string; followUp?: string }) =>
      taskRow({
        task: task({ note: overrides.note ?? null }),
        threads: threads([thread({ id: "thr_task", status: overrides.running === true ? "active" : "idle" })]),
        children: [],
        tickets: overrides.tickets ?? [],
        pullRequests: [],
        followUp: overrides.followUp,
        stepsLeft: overrides.stepsLeft,
      });
    const kept = row({ stepsLeft: 3 });
    expect(kept.research).toEqual({ state: "pending", label: "Step landed, 3 left", threadId: "thr_task" });
    expect(kept.working).toBe(false);
    expect(row({ stepsLeft: 1 }).research).toMatchObject({ state: "pending", label: "Step landed, 1 left" });
    // A running thread shows its normal working state; a question for the owner comes first.
    expect(row({ stepsLeft: 3, running: true }).research).toMatchObject({ state: "working", label: "Planning" });
    expect(row({ stepsLeft: 3, running: true }).working).toBe(true);
    expect(row({ stepsLeft: 3, tickets: [ticket()] }).research).toMatchObject({ label: "Waiting on Alex" });
    // Its landed step and its report's "Left:" are why it is open, not a stale close or a follow-up.
    expect(row({ stepsLeft: 2, note: "landed a94a2f1" }).research).toMatchObject({ label: "Step landed, 2 left" });
    expect(row({ stepsLeft: 2, followUp: "Left: step 2" }).research).toMatchObject({ state: "pending", label: "Step landed, 2 left" });
    // No steps left: as before.
    expect(row({ stepsLeft: 0 }).research).toMatchObject({ label: "Idle · waiting on Patches" });
    expect(row({}).research).toMatchObject({ label: "Idle · waiting on Patches" });
    expect(row({ stepsLeft: 0, note: "landed a94a2f1" }).research).toMatchObject({ label: "Says landed a94a2f1, not closed" });
    const base = { task: { note: null }, questions: 0, asking: false, taskAgent: undefined };
    expect(notPlanning({ ...base, stepsLeft: 4 })).toEqual({ state: "pending", label: "Step landed, 4 left" });
    expect(notPlanning({ ...base, stepsLeft: 0 })).toMatchObject({ label: "Idle · waiting on Patches" });
  });

  it("shows a task no Patches chat hears as stalled, not waiting on Patches", () => {
    // The bug: every task sat "Idle · waiting on Patches" under archived chats that could not hear it.
    const unheard = "No Patches chat hears it (its parent is not AcmeGoods' chat)";
    const idle: AgentLiveness = { threadId: "thr_task", role: "task", state: "idle", reason: null };
    const base = { task: { note: null }, questions: 0, asking: false, taskAgent: idle };
    expect(notPlanning({ ...base, unheard })).toEqual({ state: "failed", label: "Stalled · Patches not told" });
    expect(notPlanning({ ...base, unheard: null })).toEqual({ state: "pending", label: "Idle · waiting on Patches" });
    // What the owner has to do still comes first, and a thread in trouble says so.
    expect(notPlanning({ ...base, questions: 1, unheard })).toMatchObject({ label: "Waiting on Alex" });
    expect(notPlanning({ ...base, taskAgent: { ...idle, state: "stale" }, unheard })).toMatchObject({ label: "Not running" });
    // Through the row: liveness carries it.
    const row = taskRow({
      task: task(),
      threads: threads([thread({ id: "thr_task", status: "idle" })]),
      children: [],
      tickets: [],
      pullRequests: [],
      liveness: { taskId: "task_1", working: false, waiting: null, trouble: [], agents: [idle], unheard },
    }).research;
    expect(row).toEqual({ state: "failed", label: "Stalled · Patches not told", threadId: "thr_task" });
  });

  it("shows the build working, then the PR with its branch", () => {
    const children: Child[] = [{ threadId: "thr_b", taskId: "task_1", kind: "build", label: "task/tiers", summary: null, createdAt: NOW }];
    const building = taskRow({
      task: task({ stage: "build", buildState: "running", branch: "task/tiers" }),
      threads: threads([thread({ id: "thr_b", status: "active" })]),
      children,
      tickets: [],
      pullRequests: [],
    });
    expect(building.research.state).toBe("done");
    expect(building.build).toMatchObject({ state: "working", threadId: "thr_b" });
    expect(building.pr).toEqual({ pr: null, tone: null, branch: "task/tiers" });

    const inPr = taskRow({
      task: task({ stage: "pr", branch: "task/tiers", prNumber: 55 }),
      threads: threads([]),
      children,
      tickets: [],
      pullRequests: [pr({ previewSha: "137e13f" })],
    });
    expect(inPr.build.state).toBe("done");
    expect(inPr.pr.tone).toBe("stale");
  });

  it("counts a review ticket in the row only while the PR is still what was proven", () => {
    const row = (over: Partial<PullRequest>, aiTestsLabel: string | null = "ai-tests") =>
      taskRow({
        task: task({ stage: "you", branch: "task/tiers", prNumber: 55, verifiedSha: "cc65f6a0000000" }),
        threads: threads([]),
        children: [],
        tickets: [ticket({ id: "tkt_r", kind: "review", questions: [] })],
        pullRequests: [pr({ labels: ["ai-tests"], ...over })],
        aiTestsLabel,
      });
    expect(row({}).you.review).toBe(true);
    expect(row({ headRefOid: "ab347a50000000" }).you.review).toBe(false);
    expect(row({ checks: "failing" }).you.review).toBe(false);
    expect(row({ labels: [] }).you.review).toBe(false);
    expect(row({ labels: [] }, null).you.review).toBe(true);
  });

  it("points finished Research at its latest researcher, and the plan-only cell at nothing", () => {
    const children: Child[] = [
      { threadId: "thr_r1", taskId: "task_1", kind: "research", label: "r1", summary: null, createdAt: NOW },
      { threadId: "thr_r2", taskId: "task_1", kind: "research", label: "r2", summary: null, createdAt: NOW + 1 },
    ];
    const researched = taskRow({ task: task({ stage: "build" }), threads: threads([]), children, tickets: [], pullRequests: [] });
    expect(researched.research).toEqual({ state: "done", label: "2 researched", threadId: "thr_r2" });
    const planned = taskRow({ task: task({ stage: "build" }), threads: threads([]), children: [], tickets: [], pullRequests: [] });
    expect(planned.research).toEqual({ state: "done", label: "Planned", threadId: null });
  });

  it("marks a failed build: the task's to fix first, then the owner's", () => {
    const row = (buildFailures: number) =>
      taskRow({
        task: task({ stage: "research", buildState: "failed", buildError: ".claude/ is not gitignored\nmore", buildFailures }),
        threads: threads([]),
        children: [],
        tickets: [],
        pullRequests: [],
      });
    expect(row(1).build).toMatchObject({ state: "failed", label: "Task fixing (1/2): .claude/ is not gitignored" });
    expect(row(2).build).toMatchObject({ state: "failed", label: ".claude/ is not gitignored" });
  });
});

describe("prForTask / untrackedPullRequests", () => {
  it("finds a task's PR by number, else by branch, and leaves the rest untracked", () => {
    const prs = [pr({ number: 55, headRefName: "task/tiers" }), pr({ number: 54, headRefName: "other" })];
    expect(prForTask(task({ prNumber: 55 }), prs)?.number).toBe(55);
    expect(prForTask(task({ branch: "task/tiers" }), prs)?.number).toBe(55);
    expect(untrackedPullRequests(prs, [task({ branch: "task/tiers" })]).map((p) => p.number)).toEqual([54]);
  });
});

describe("assignColors", () => {
  it("keeps the owner's picks and gives everyone else a distinct free colour", () => {
    const colors = assignColors(["a", "b", "c"], new Map([["b", "blue"]]));
    expect(colors.get("b")).toBe("blue");
    expect(new Set(colors.values()).size).toBe(3);
    expect(colors.get("a")).not.toBe("blue");
    expect(PALETTE.length).toBeGreaterThanOrEqual(4);
  });
});

describe("buildsInFlight", () => {
  it("counts builds preparing or running before their PR", () => {
    expect(
      buildsInFlight([
        task({ id: "1", stage: "build", buildState: "preparing" }),
        task({ id: "2", stage: "build", buildState: "running" }),
        task({ id: "3", stage: "pr", buildState: "none" }),
        task({ id: "4", stage: "build", buildState: "failed" }),
        task({ id: "5", stage: "build", buildState: "running", closedAt: NOW }),
      ]).map((t) => t.id),
    ).toEqual(["1", "2"]);
  });
});

describe("tabBadges", () => {
  const child = (threadId: string, taskId: string, kind: Child["kind"] = "build"): Child => ({
    threadId,
    taskId,
    kind,
    label: "l",
    summary: null,
    createdAt: NOW,
  });

  it("counts Needs you per project and in total, loose agents included", () => {
    const tasks = [task({ id: "t1", projectId: "a", prNumber: 5 }), task({ id: "t2", projectId: "b", threadId: "thr_t2" })];
    const threads = [thread({ id: "loose", projectId: "b", hasPendingInteraction: true })];
    const items = needsYou({
      tasks,
      tickets: [ticket({ taskId: "t1" })],
      children: [],
      threads,
      ownedThreadIds: new Set(["thr_task", "thr_t2"]),
    });
    const badges = tabBadges({ needsYou: items, tasks, children: [], threads, signedOut: false, projectIds: ["a", "b", "c"] });
    expect(badges.get("a")).toEqual({ needsYou: 1, working: 0 });
    expect(badges.get("b")).toEqual({ needsYou: 1, working: 0 });
    expect(badges.get("any")).toEqual({ needsYou: 2, working: 0 });
  });

  it("counts working research and build threads and preparing builds, never the task thread", () => {
    const tasks = [
      task({ id: "t1", projectId: "a", threadId: "thr_t1" }),
      task({ id: "t2", projectId: "a", threadId: "thr_t2", stage: "build", buildState: "preparing" }),
      task({ id: "t3", projectId: "b", threadId: "thr_t3" }),
    ];
    const threads = [
      thread({ id: "thr_t1", status: "active" }),
      thread({ id: "r1", status: "active" }),
      thread({ id: "b1", status: "starting" }),
      thread({ id: "b3", status: "idle" }),
    ];
    const badges = tabBadges({
      needsYou: [],
      tasks,
      children: [child("r1", "t1", "research"), child("b1", "t1"), child("b3", "t3")],
      threads,
      signedOut: false,
      projectIds: ["a", "b"],
    });
    expect(badges.get("a")).toEqual({ needsYou: 0, working: 3 });
    expect(badges.get("b")).toBeUndefined();
    expect(badges.get("any")).toEqual({ needsYou: 0, working: 3 });
  });

  it("never counts a closed task", () => {
    const tasks = [task({ id: "t1", projectId: "a", buildState: "preparing", closedAt: NOW })];
    const badges = tabBadges({
      needsYou: [],
      tasks,
      children: [child("b1", "t1")],
      threads: [thread({ id: "b1", status: "active" })],
      signedOut: false,
      projectIds: ["a"],
    });
    expect(badges.get("a")).toBeUndefined();
    expect(badges.get("any")).toEqual({ needsYou: 0, working: 0 });
  });

  it("Claude signed out is one more Needs you on every project, and one in total", () => {
    const tasks = [task({ id: "t1", projectId: "a", prNumber: 5 })];
    const items = needsYou({ tasks, tickets: [ticket({ taskId: "t1" })], children: [], threads: [], ownedThreadIds: new Set(["thr_task"]) });
    const badges = tabBadges({ needsYou: items, tasks, children: [], threads: [], signedOut: true, projectIds: ["a", "b", "a"] });
    expect(badges.get("a")).toEqual({ needsYou: 2, working: 0 });
    expect(badges.get("b")).toEqual({ needsYou: 1, working: 0 });
    expect(badges.get("any")).toEqual({ needsYou: 2, working: 0 });
    // Signed out with no project at all still counts once.
    expect(tabBadges({ needsYou: [], tasks: [], children: [], threads: [], signedOut: true, projectIds: [] }).get("any")).toEqual({ needsYou: 1, working: 0 });
    // A project literally keyed "any" cannot double the total.
    expect(tabBadges({ needsYou: [], tasks: [], children: [], threads: [], signedOut: true, projectIds: ["any"] }).get("any")).toEqual({ needsYou: 1, working: 0 });
  });
});

describe("completionOf", () => {
  const of = (note: string | null) => completionOf(task({ note }));

  it("reads a land", () => {
    const completion = of("Landed on main at abc1234: Tabs and badges");
    expect(completion).toEqual({ kind: "landed", target: "main", sha: "abc1234" });
    expect(completionLabel(completion)).toBe("Landed on main · abc1234");
  });

  it("reads a merged and a closed PR", () => {
    expect(of("PR #12 merged.")).toEqual({ kind: "merged", pr: 12 });
    expect(completionLabel(of("PR #12 merged."))).toBe("Merged PR #12");
    expect(of("PR #7 closed.")).toEqual({ kind: "closed", pr: 7 });
    expect(completionLabel(of("PR #7 closed."))).toBe("PR #7 closed");
  });

  it("reads an archived task thread", () => {
    expect(of("Task thread archived.")).toEqual({ kind: "archived" });
    expect(completionLabel(of("Task thread archived."))).toBe("Archived");
  });

  it("reads a deleted task and a done one", () => {
    expect(of("Deleted by Alex.")).toEqual({ kind: "deleted" });
    expect(completionLabel(of("Deleted by Alex."))).toBe("Deleted");
    // Whatever the owner was called when it was deleted: the note outlives a change of name.
    expect(of("Deleted by the owner.")).toEqual({ kind: "deleted" });
    expect(of("Deleted by Mary Jane.")).toEqual({ kind: "deleted" });
    expect(of("Deleted by .")).toEqual({ kind: "closed" });
    expect(of("Deleted by Alex. Then more")).toEqual({ kind: "closed" });
    expect(of("Deleted by Alex.\nmore.")).toEqual({ kind: "closed" });
    const done = "Done: Prod web locked (idle 30 min with nothing open; closed by The Orchestrator)";
    expect(of(done)).toEqual({ kind: "done" });
    expect(completionLabel(of(done))).toBe("Done");
    expect(of("Not done: x")).toEqual({ kind: "closed" });
  });

  it("calls anything else closed", () => {
    expect(of(null)).toEqual({ kind: "closed" });
    expect(of("PR #12 open.")).toEqual({ kind: "closed" });
    expect(of("Said: Landed on main at abc1234: x")).toEqual({ kind: "closed" });
    expect(completionLabel(of("whatever"))).toBe("Closed");
  });
});

// task "Critical validation of jev and headroom", 2026-10-04: findings in chat only, nothing to review.
describe("a report waiting on the owner", () => {
  const report = (overrides: Partial<Ticket> = {}) =>
    ticket({
      id: "tkt_rep",
      kind: "report",
      questions: [],
      report: { path: "/Users/a/.bb/thread-storage/task_1/report.md", title: "Jev check", summary: "Jev routes.\nHeadroom is gone." },
      ...overrides,
    });

  it("is its own Needs you item, titled by the report, with its summary and path", () => {
    const items = needsYou({ tasks: [task()], tickets: [report()], children: [], threads: [], ownedThreadIds: new Set(["thr_task"]) });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      taskId: "task_1",
      title: "Review report: Jev check",
      summary: "Review report: Jev check",
      tone: "success",
      questionTicketId: null,
      report: { ticketId: "tkt_rep", title: "Jev check", summary: "Jev routes.\nHeadroom is gone.", path: "/Users/a/.bb/thread-storage/task_1/report.md" },
    });
  });

  it("folds into the task's one ticket beside its questions", () => {
    const items = needsYou({ tasks: [task()], tickets: [ticket(), report()], children: [], threads: [], ownedThreadIds: new Set(["thr_task"]) });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ questionTicketId: "tkt_1", report: { ticketId: "tkt_rep" }, tone: "attention" });
    expect(items[0]?.summary).toBe("Subscription tiers · 3 questions · report ready");
  });

  it("is gone once the ticket closes or the task does", () => {
    expect(needsYou({ tasks: [task()], tickets: [report({ status: "closed" })], children: [], threads: [], ownedThreadIds: new Set() })).toEqual([]);
    expect(needsYou({ tasks: [task({ closedAt: 5 })], tickets: [report()], children: [], threads: [], ownedThreadIds: new Set() })).toEqual([]);
  });

  it("reads Report ready · waiting on the owner on the task's row", () => {
    const row = taskRow({
      task: task(),
      threads: new Map([["thr_task", thread({ id: "thr_task", status: "idle" })]]),
      children: [],
      tickets: [report()],
      pullRequests: [],
    });
    expect(row.research).toEqual({ state: "blocked", label: "Report ready · waiting on Alex", threadId: "thr_task" });
    expect(row.you.report).toBe(true);
    // Questions still come first: they are the owner's to answer.
    expect(notPlanning({ task: { note: null }, questions: 2, asking: false, report: true, taskAgent: undefined })).toMatchObject({ label: "Waiting on Alex" });
    expect(notPlanning({ task: { note: null }, questions: 0, asking: false, report: true, taskAgent: undefined, followUp: "x" })).toMatchObject({
      label: "Report ready · waiting on Alex",
    });
  });
});
