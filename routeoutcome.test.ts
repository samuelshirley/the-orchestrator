import { describe, expect, it } from "vitest";
import { HAIKU_MODEL, ROUTE_WINDOW_MS, SONNET_MODEL } from "./modelroute";
import { staleReason } from "./release";
import {
  ERROR_SUMMARY_PREFIX,
  outcomeComparison,
  outcomeLogLine,
  outcomeOk,
  routeOutcome,
  routeOutcomes,
  staleFate,
  type RouteOutcome,
} from "./routeoutcome";
import type { Task } from "./store";

const facts = { buildFailures: 0, taskFate: null, summary: null, superseded: false, questions: 0 };

describe("routeOutcome", () => {
  it("a task: open until it closes, then landed, ok (done) or abandoned, with its failures and questions", () => {
    expect(routeOutcome({ ...facts, role: "task", questions: 2 })).toEqual({ kind: "open", buildFailures: 0, questions: 2 });
    expect(routeOutcome({ ...facts, role: "task", taskFate: "landed", buildFailures: 1, questions: 2 })).toEqual({
      kind: "landed",
      buildFailures: 1,
      questions: 2,
    });
    expect(routeOutcome({ ...facts, role: "task", taskFate: "done" }).kind).toBe("ok");
    expect(routeOutcome({ ...facts, role: "task", taskFate: "abandoned" }).kind).toBe("abandoned");
  });

  it("a build: failed once a failure is counted on it, whatever the task did after", () => {
    expect(routeOutcome({ ...facts, role: "build", buildFailures: 1, taskFate: "landed" })).toEqual({ kind: "failed", buildFailures: 1, questions: 0 });
    expect(routeOutcome({ ...facts, role: "build", taskFate: "landed" }).kind).toBe("landed");
    expect(routeOutcome({ ...facts, role: "build", taskFate: "done" }).kind).toBe("ok");
    expect(routeOutcome({ ...facts, role: "build", taskFate: "abandoned" }).kind).toBe("abandoned");
    // A later build started and this one never failed: it did its part.
    expect(routeOutcome({ ...facts, role: "build", superseded: true }).kind).toBe("ok");
    expect(routeOutcome({ ...facts, role: "build", summary: "Done." }).kind).toBe("open");
    // Questions are the task's, never a build's.
    expect(routeOutcome({ ...facts, role: "build", questions: 3 }).questions).toBe(0);
  });

  it("research: completed or errored by its report", () => {
    expect(routeOutcome({ ...facts, role: "research" }).kind).toBe("open");
    expect(routeOutcome({ ...facts, role: "research", summary: "The answer is X." }).kind).toBe("ok");
    expect(routeOutcome({ ...facts, role: "research", summary: `${ERROR_SUMMARY_PREFIX} overloaded` }).kind).toBe("errored");
    expect(routeOutcome({ ...facts, role: "research", taskFate: "landed" }).kind).toBe("abandoned");
  });

  it("another role has no outcome", () => {
    expect(routeOutcome({ ...facts, role: "patches", taskFate: "landed" }).kind).toBe("open");
  });

  it("ok means landed or done", () => {
    expect(["landed", "ok", "failed", "abandoned", "errored", "open"].filter((kind) => outcomeOk(kind as RouteOutcome["kind"]))).toEqual([
      "landed",
      "ok",
    ]);
  });
});

describe("staleFate", () => {
  const task = (over: Partial<Task>) =>
    ({ closedAt: null, buildState: "none", branch: "task/x", headSha: "abc1234def", prNumber: 7, ...over }) as Task;
  const pr = (state: string) => ({ number: 7, state, headRefName: "task/x" }) as never;

  it("reads release.ts's reasons: a closed PR was given up, a merge or a branch on main landed", () => {
    const closed = staleReason({ task: task({}), pr: pr("closed"), fate: null });
    const merged = staleReason({ task: task({}), pr: pr("merged"), fate: null });
    const onMain = staleReason({ task: task({ prNumber: null }), pr: null, fate: { local: false, remote: false, headOnBase: true } });
    expect([closed, merged, onMain].every((reason) => reason !== null)).toBe(true);
    expect(staleFate(closed!)).toBe("abandoned");
    expect(staleFate(merged!)).toBe("landed");
    expect(staleFate(onMain!)).toBe("landed");
  });
});

describe("routeOutcomes", () => {
  const route = (threadId: string, role: string, over: Partial<{ buildFailures: number; taskFate: "landed" | null; taskId: string }> = {}) => ({
    threadId,
    taskId: "task_1",
    role,
    buildFailures: 0,
    taskFate: null,
    ...over,
  });

  it("derives from the dossier: question tickets, reports and later builds", () => {
    const outcomes = routeOutcomes(
      [
        route("thr_task", "task", { buildFailures: 1 }),
        route("thr_b1", "build", { buildFailures: 1 }),
        route("thr_b2", "build"),
        route("thr_r", "research"),
        route("thr_other", "task", { taskId: "task_2" }),
      ],
      [
        { threadId: "thr_b1", taskId: "task_1", kind: "build", summary: null, createdAt: 1 },
        { threadId: "thr_b2", taskId: "task_1", kind: "build", summary: "Done", createdAt: 2 },
        { threadId: "thr_r", taskId: "task_1", kind: "research", summary: "Found it", createdAt: 3 },
      ],
      [
        { taskId: "task_1", kind: "questions", questions: ["a?", "b?"] },
        { taskId: "task_1", kind: "review", questions: ["merge?"] },
        { taskId: "task_2", kind: "questions", questions: ["c?"] },
      ],
    );
    expect(outcomes.get("thr_task")).toEqual({ kind: "open", buildFailures: 1, questions: 2 });
    expect(outcomes.get("thr_b1")).toEqual({ kind: "failed", buildFailures: 1, questions: 0 });
    expect(outcomes.get("thr_b2")?.kind).toBe("open");
    expect(outcomes.get("thr_r")?.kind).toBe("ok");
    expect(outcomes.get("thr_other")).toEqual({ kind: "open", buildFailures: 0, questions: 1 });
  });

  it("an earlier build that never failed is ok once a later one starts", () => {
    const outcomes = routeOutcomes(
      [route("thr_b1", "build"), route("thr_b2", "build")],
      [
        { threadId: "thr_b1", taskId: "task_1", kind: "build", summary: "Done", createdAt: 1 },
        { threadId: "thr_b2", taskId: "task_1", kind: "build", summary: null, createdAt: 2 },
      ],
      [],
    );
    expect(outcomes.get("thr_b1")?.kind).toBe("ok");
    expect(outcomes.get("thr_b2")?.kind).toBe("open");
  });
});

describe("outcomeComparison", () => {
  const now = ROUTE_WINDOW_MS * 2;
  const at = now - 1000;
  const done = (kind: RouteOutcome["kind"], buildFailures = 0, questions = 0): RouteOutcome => ({ kind, buildFailures, questions });
  const row = (over: Partial<Parameters<typeof outcomeComparison>[0][number]>) => ({
    routedAt: at,
    role: "build",
    reason: "opus",
    model: null,
    effort: null,
    outcome: done("ok"),
    ...over,
  });

  it("compares lowered agents with default ones: count, ok, build failures, questions", () => {
    const rows = [
      row({ model: SONNET_MODEL, reason: "sonnet", outcome: done("landed") }),
      row({ model: HAIKU_MODEL, reason: "haiku", role: "research", outcome: done("ok") }),
      row({ effort: "medium", outcome: done("failed", 1) }),
      row({ role: "task", outcome: done("landed", 2, 1) }),
      row({ reason: "backoff", outcome: done("abandoned") }),
      row({ reason: "unsure", outcome: done("ok", 0, 0) }),
    ];
    const result = outcomeComparison(rows, now);
    expect(result?.line).toBe(
      "Lowered: 3 agents, 2 ok, 1 build failure, 0 questions · Default: 3 agents, 2 ok, 2 build failures, 1 question",
    );
    expect(result?.detail).toContain("Last 14 days");
    expect(result?.detail).toContain("Lowered by role: build 2 (1 ok), research 1 (1 ok)");
  });

  it("counts only finished agents in the window, never the owner's pick, Patches or another provider", () => {
    const rows = [
      row({ model: SONNET_MODEL, reason: "sonnet", outcome: done("open") }),
      row({ model: SONNET_MODEL, reason: "sonnet", outcome: null }),
      row({ routedAt: now - ROUTE_WINDOW_MS, outcome: done("ok") }),
      row({ reason: "owner", outcome: done("ok") }),
      row({ reason: "patches", outcome: done("ok") }),
      row({ reason: "provider", outcome: done("ok") }),
    ];
    expect(outcomeComparison(rows, now)).toBeNull();
    expect(outcomeComparison([...rows, row({})], now)?.line).toBe(
      "Lowered: 0 agents, 0 ok, 0 build failures, 0 questions · Default: 1 agent, 1 ok, 0 build failures, 0 questions",
    );
  });
});

describe("outcomeLogLine", () => {
  it("names the agent, its model and effort, and what it came to", () => {
    expect(outcomeLogLine({ role: "build", threadId: "thr_b", model: SONNET_MODEL, effort: "medium" }, { kind: "failed", buildFailures: 2, questions: 0 })).toBe(
      `build thr_b on ${SONNET_MODEL}, effort medium: failed, 2 build failures`,
    );
    expect(outcomeLogLine({ role: "task", threadId: "thr_t", model: null, effort: null }, { kind: "landed", buildFailures: 0, questions: 1 })).toBe(
      "task thr_t on the provider default, effort default: landed, 0 build failures, 1 question",
    );
    expect(outcomeLogLine({ role: "research", threadId: "thr_r", model: HAIKU_MODEL, effort: null }, { kind: "ok", buildFailures: 0, questions: 0 })).toBe(
      `research thr_r on ${HAIKU_MODEL}, effort default: ok`,
    );
  });
});
