import { describe, expect, it } from "vitest";
import {
  CLOSED_PAGE_MAX,
  CLOSED_PAGE_SIZE,
  closedChatThread,
  closedCounts,
  closedPath,
  closedTaskPage,
  closedTaskSummary,
  parseClosedPath,
} from "./archive";
import type { Child, Release, Task, Ticket, Withdrawal } from "./store";

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  projectId: "p_a",
  title: `Task ${id}`,
  brief: "",
  stage: "done",
  threadId: `thr_${id}`,
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
  closedAt: 100,
  ...over,
});

const tasks: Task[] = [
  task("t_tiers", { title: "Pricing Tiers", brief: "Three plans on the paywall", closedAt: 300 }),
  task("t_login", { title: "Fix login", note: "Landed on main at abcdef0: fix login", closedAt: 500 }),
  task("t_pr", { title: "Export", prNumber: 12, note: "PR #12 merged.", closedAt: 400 }),
  task("t_pr123", { title: "Import", prNumber: 123, closedAt: 200 }),
  task("t_open", { title: "Pricing open", closedAt: null }),
  task("t_other", { projectId: "p_b", title: "Pricing elsewhere", closedAt: 900 }),
];

const ids = (query?: string) => closedTaskPage({ tasks, projectId: "p_a", query }).rows.map((row) => row.id);

describe("closedTaskPage", () => {
  it("lists only that project's closed tasks, newest first", () => {
    expect(closedTaskPage({ tasks, projectId: "p_a" })).toEqual({
      rows: [tasks[1], tasks[2], tasks[0], tasks[3]],
      total: 4,
    });
    expect(closedTaskPage({ tasks, projectId: "p_b" }).rows.map((row) => row.id)).toEqual(["t_other"]);
    expect(closedTaskPage({ tasks, projectId: "p_none" })).toEqual({ rows: [], total: 0 });
  });

  it("leaves open tasks and other projects out of a search too", () => {
    expect(ids("pricing")).toEqual(["t_tiers"]);
  });

  it("treats an empty or blank query as no search", () => {
    expect(ids("")).toEqual(["t_login", "t_pr", "t_tiers", "t_pr123"]);
    expect(ids("   \n ")).toEqual(["t_login", "t_pr", "t_tiers", "t_pr123"]);
  });

  it("searches the title, case-insensitively", () => {
    expect(ids("TIERS")).toEqual(["t_tiers"]);
  });

  it("searches the brief", () => {
    expect(ids("paywall")).toEqual(["t_tiers"]);
  });

  it("searches the note", () => {
    expect(ids("abcdef0")).toEqual(["t_login"]);
  });

  it("searches the id", () => {
    expect(ids("t_pr123")).toEqual(["t_pr123"]);
  });

  it("searches the PR number, with or without the #", () => {
    expect(ids("#123")).toEqual(["t_pr123"]);
    expect(ids("123")).toEqual(["t_pr123"]);
    expect(ids("#12")).toEqual(["t_pr", "t_pr123"]);
    expect(closedTaskPage({ tasks: [task("t_x", { prNumber: 77 })], projectId: "p_a", query: "77" }).total).toBe(1);
    expect(closedTaskPage({ tasks: [task("t_x", { prNumber: 77 })], projectId: "p_a", query: "#77" }).total).toBe(1);
  });

  it("needs every term to match, each anywhere", () => {
    expect(ids("plans pricing")).toEqual(["t_tiers"]);
    expect(ids("pricing login")).toEqual([]);
    expect(ids("  fix   abcdef0 ")).toEqual(["t_login"]);
  });

  it("does not match a term across two fields", () => {
    expect(closedTaskPage({ tasks: [task("t_x", { title: "foo", brief: "bar" })], projectId: "p_a", query: "foobar" }).total).toBe(0);
  });

  it("breaks a closedAt tie by id, whatever the input order", () => {
    const tied = [task("t_c"), task("t_a"), task("t_b"), task("t_new", { closedAt: 101 })];
    const expected = ["t_new", "t_a", "t_b", "t_c"];
    expect(closedTaskPage({ tasks: tied, projectId: "p_a" }).rows.map((row) => row.id)).toEqual(expected);
    expect(closedTaskPage({ tasks: [...tied].reverse(), projectId: "p_a" }).rows.map((row) => row.id)).toEqual(expected);
  });

  it("does not reorder the caller's list", () => {
    const before = tasks.map((entry) => entry.id);
    closedTaskPage({ tasks, projectId: "p_a" });
    expect(tasks.map((entry) => entry.id)).toEqual(before);
  });

  const many = Array.from({ length: 130 }, (_, index) => task(`t_${String(index).padStart(3, "0")}`, { closedAt: 1000 - index }));
  const page = (offset?: number, limit?: number) => closedTaskPage({ tasks: many, projectId: "p_a", offset, limit });

  it("pages, with the total counted before paging", () => {
    const first = page();
    expect(first.total).toBe(130);
    expect(first.rows).toHaveLength(CLOSED_PAGE_SIZE);
    expect(first.rows[0]?.id).toBe("t_000");
    expect(page(25, 25).rows.map((row) => row.id)).toEqual(many.slice(25, 50).map((row) => row.id));
    expect(page(120, 25).rows).toHaveLength(10);
    expect(page(130, 25)).toEqual({ rows: [], total: 130 });
    expect(page(500, 25)).toEqual({ rows: [], total: 130 });
  });

  it("counts the total after the search", () => {
    const found = closedTaskPage({ tasks: many, projectId: "p_a", query: "t_01", limit: 3 });
    expect(found.total).toBe(10);
    expect(found.rows.map((row) => row.id)).toEqual(["t_010", "t_011", "t_012"]);
  });

  it("starts at 0 for a negative or NaN offset", () => {
    expect(page(-5, 2).rows.map((row) => row.id)).toEqual(["t_000", "t_001"]);
    expect(page(Number.NaN, 2).rows.map((row) => row.id)).toEqual(["t_000", "t_001"]);
    expect(page(Number.NEGATIVE_INFINITY, 2).rows.map((row) => row.id)).toEqual(["t_000", "t_001"]);
  });

  it("clamps the limit to 1..CLOSED_PAGE_MAX and defaults a NaN one", () => {
    expect(page(0, 0).rows).toHaveLength(1);
    expect(page(0, -10).rows).toHaveLength(1);
    expect(page(0, 1000).rows).toHaveLength(CLOSED_PAGE_MAX);
    expect(page(0, CLOSED_PAGE_MAX + 1).rows).toHaveLength(CLOSED_PAGE_MAX);
    expect(page(0, Number.NaN).rows).toHaveLength(CLOSED_PAGE_SIZE);
    expect(page(0, 2.9).rows).toHaveLength(2);
  });

  it("keeps the caller's row shape", () => {
    const rows = closedTaskPage({ tasks: [{ ...task("t_x"), extra: "kept" }], projectId: "p_a" }).rows;
    expect(rows[0]?.extra).toBe("kept");
  });

  it("has the page sizes the board asks for", () => {
    expect(CLOSED_PAGE_SIZE).toBe(25);
    expect(CLOSED_PAGE_MAX).toBe(100);
  });
});

describe("closedCounts", () => {
  it("counts closed tasks per project, open ones left out", () => {
    expect(closedCounts(tasks)).toEqual({ p_a: 4, p_b: 1 });
  });

  it("has no key for a project with nothing closed", () => {
    expect(closedCounts([task("t_x", { projectId: "p_c", closedAt: null })])).toEqual({});
    expect(closedCounts([])).toEqual({});
  });
});

describe("closedTaskSummary", () => {
  const ticket = (id: string, over: Partial<Ticket> = {}): Ticket => ({
    id,
    taskId: "t1",
    kind: "questions",
    questions: [],
    asks: [],
    answers: null,
    status: "closed",
    createdAt: 10,
    closedAt: 20,
    ...over,
  });
  const landed = task("t1", {
    title: "Tiers",
    brief: "Three plans",
    branch: "task/tiers",
    prNumber: 7,
    prUrl: "https://example.test/pr/7",
    note: "Landed on main at abc1234: tiers",
    decisions: [{ question: "Monthly or yearly?", decision: "Both" }],
    createdAt: 5,
    closedAt: 90,
  });
  const tickets: Ticket[] = [
    ticket("tkt_late", { questions: ["Ship it?"], answers: null, createdAt: 30 }),
    ticket("tkt_early", { questions: ["Which price?", "Which name?"], answers: ["$5"], createdAt: 10 }),
    ticket("tkt_review", { kind: "review", questions: ["Test and merge"], createdAt: 15 }),
    ticket("tkt_foreign", { taskId: "t2", questions: ["Not mine?"], answers: ["no"], createdAt: 12 }),
  ];
  const withdrawals: Withdrawal[] = [
    { ticketId: "tkt_w", taskId: "t1", questions: ["Dark mode?"], reason: "Decided it myself", by: "task", at: 40 },
    { ticketId: "tkt_w2", taskId: "t2", questions: ["Foreign?"], reason: "no", by: "patches", at: 41 },
  ];
  const releases: Release[] = [{ paths: ["app.tsx"], reason: "Done with it", by: "patches", closed: false, at: 50 }];
  const children: Child[] = [
    { threadId: "thr_b1", taskId: "t1", kind: "build", label: "task/tiers", summary: null, createdAt: 30 },
    { threadId: "thr_x", taskId: "t2", kind: "research", label: "not mine", summary: "foreign", createdAt: 1 },
    { threadId: "thr_r1", taskId: "t1", kind: "research", label: "prices", summary: "Competitors charge $5", createdAt: 20 },
  ];
  const summary = closedTaskSummary({ task: landed, tickets, withdrawals, releases, children });

  it("says what the task was and how it finished", () => {
    expect(summary).toMatchObject({
      id: "t1",
      projectId: "p_a",
      title: "Tiers",
      brief: "Three plans",
      note: "Landed on main at abc1234: tiers",
      branch: "task/tiers",
      prNumber: 7,
      prUrl: "https://example.test/pr/7",
      createdAt: 5,
      closedAt: 90,
      how: "Landed on main · abc1234",
      sha: "abc1234",
      decisions: [{ question: "Monthly or yearly?", decision: "Both" }],
    });
  });

  it("has no Report link when the task had no report", () => {
    expect(summary.report).toBeNull();
  });

  it("links the task's newest report, reviewed or not, so it can be read after archiving", () => {
    const rep = (id: string, title: string, createdAt: number, taskId = "t1") =>
      ticket(id, { taskId, kind: "report", createdAt, report: { path: `/r/t1/${title}.md`, title, summary: null } });
    const withReports = closedTaskSummary({
      task: landed,
      tickets: [...tickets, rep("tkt_rep1", "first", 40), rep("tkt_rep2", "second", 60), rep("tkt_foreign_rep", "theirs", 99, "t2")],
      withdrawals,
      releases,
      children,
    });
    expect(withReports.report).toEqual({ ticketId: "tkt_rep2", title: "second", path: "/r/t1/second.md" });
    // A report is not a question.
    expect(withReports.questions).toEqual(summary.questions);
  });

  it("has a sha only when it landed", () => {
    const merged = closedTaskSummary({
      task: task("t1", { note: "PR #12 merged." }),
      tickets: [],
      withdrawals: [],
      releases: [],
      children: [],
    });
    expect(merged.how).toBe("Merged PR #12");
    expect(merged.sha).toBeNull();
    const archived = closedTaskSummary({
      task: task("t1", { note: "Task thread archived." }),
      tickets: [],
      withdrawals: [],
      releases: [],
      children: [],
    });
    expect(archived.how).toBe("Archived");
    expect(archived.sha).toBeNull();
  });

  it("flattens its question tickets in the order asked, review and foreign tickets left out", () => {
    expect(summary.questions).toEqual([
      { question: "Which price?", answer: "$5", askedAt: 10 },
      { question: "Which name?", answer: null, askedAt: 10 },
      { question: "Ship it?", answer: null, askedAt: 30 },
    ]);
  });

  it("keeps only its own withdrawals, without ticket or task ids", () => {
    expect(summary.withdrawals).toEqual([{ questions: ["Dark mode?"], reason: "Decided it myself", by: "task", at: 40 }]);
  });

  it("carries the releases it was handed", () => {
    expect(summary.releases).toEqual(releases);
  });

  it("lists the task thread first, then its own children oldest first with their summaries", () => {
    expect(summary.threads).toEqual([
      { threadId: "thr_t1", kind: "task", label: "Tiers", summary: null },
      { threadId: "thr_r1", kind: "research", label: "prices", summary: "Competitors charge $5" },
      { threadId: "thr_b1", kind: "build", label: "task/tiers", summary: null },
    ]);
  });

  it("has no task thread entry when the task never had one", () => {
    const threadless = closedTaskSummary({ task: { ...landed, threadId: null }, tickets, withdrawals, releases, children });
    expect(threadless.threads.map((entry) => entry.threadId)).toEqual(["thr_r1", "thr_b1"]);
  });

  it("is plain data that survives serialising, sharing nothing with the dossier", () => {
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
    expect(summary.decisions).not.toBe(landed.decisions);
    expect(summary.releases[0]?.paths).not.toBe(releases[0]?.paths);
    expect(summary.withdrawals[0]?.questions).not.toBe(withdrawals[0]?.questions);
  });
});

describe("closedChatThread", () => {
  const threads = [
    { threadId: "thr_t1", kind: "task" as const, state: "archived" as const },
    { threadId: "thr_r1", kind: "research" as const, state: "live" as const },
    { threadId: "thr_b1", kind: "build" as const, state: "gone" as const },
  ];

  it("shows the task thread when the route names none", () => {
    expect(closedChatThread(threads, null)?.threadId).toBe("thr_t1");
  });

  it("shows the thread the route names, archived or live", () => {
    expect(closedChatThread(threads, "thr_r1")?.threadId).toBe("thr_r1");
    expect(closedChatThread(threads, "thr_t1")?.threadId).toBe("thr_t1");
  });

  it("shows no chat for a gone thread, named or the task's own", () => {
    expect(closedChatThread(threads, "thr_b1")).toBeNull();
    expect(closedChatThread([{ ...threads[0]!, state: "gone" as const }, threads[1]!], null)).toBeNull();
  });

  it("never shows a thread that is not this task's, nor falls back to a child when there is no task thread", () => {
    expect(closedChatThread(threads, "thr_foreign")).toBeNull();
    expect(closedChatThread(threads.slice(1), null)).toBeNull();
    expect(closedChatThread([], null)).toBeNull();
  });
});

describe("closedPath", () => {
  it("names the task, and the thread when one is open", () => {
    expect(closedPath("task_1")).toBe("closed:task_1");
    expect(closedPath("task_1", null)).toBe("closed:task_1");
    expect(closedPath("task_1", "thr_9")).toBe("closed:task_1:thr_9");
  });

  it("round-trips through parseClosedPath", () => {
    expect(parseClosedPath(closedPath("task_1"))).toEqual({ taskId: "task_1", threadId: null });
    expect(parseClosedPath(closedPath("task_1", "thr_9"))).toEqual({ taskId: "task_1", threadId: "thr_9" });
  });

  it("parses nothing else", () => {
    for (const path of [
      "",
      "new",
      "thr_9",
      "closed",
      "closed:",
      "closed::thr_9",
      "closed:task_1:",
      "closed:task_1:thr_9:more",
      "Closed:task_1",
      "xclosed:task_1",
      "closedtask_1",
      "task_1:closed",
    ]) {
      expect(parseClosedPath(path)).toBeNull();
    }
  });
});
