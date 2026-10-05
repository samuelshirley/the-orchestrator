import { DatabaseSync } from "node:sqlite";
import { reportKey } from "./landed";
import { describe, expect, it } from "vitest";
import type { Ask } from "./attention";
import { Store, type SqlDb } from "./store";

const q = (question: string): Ask => ({ kind: "decision", question, options: ["yes", "no"], recommended: 0 });
const line = (question: string) => `${question} Options: yes (recommended) / no`;

function fresh() {
  const db = new DatabaseSync(":memory:");
  Store.migrateInPlace(db as unknown as SqlDb);
  let clock = 1000;
  return new Store(db as unknown as SqlDb, () => (clock += 1));
}

describe("Store", () => {
  it("round-trips a task through its stages", () => {
    const store = fresh();
    const task = store.createTask({ projectId: "proj_f", title: "Tiers", brief: "Add a tier" });
    expect(task.stage).toBe("research");
    const updated = store.updateTask(task.id, {
      stage: "build",
      buildState: "preparing",
      decisions: [{ question: "Which ids?", decision: "Reuse the RC ones" }],
      threadId: "thr_t",
    });
    expect(updated).toMatchObject({ stage: "build", buildState: "preparing", threadId: "thr_t" });
    expect(updated.decisions).toHaveLength(1);
    expect(store.taskByThread("thr_t")?.id).toBe(task.id);
    const failed = store.updateTask(task.id, {
      buildState: "failed",
      buildFailures: 2,
      buildRequest: { touches: ["a.ts"], branch: null, instructions: "Do it" },
    });
    expect(failed.buildFailures).toBe(2);
    expect(failed.buildRequest).toEqual({ touches: ["a.ts"], branch: null, instructions: "Do it" });
  });

  it("records the sidebar switch once and keeps it", () => {
    const store = fresh();
    expect(store.sidebarAdopted()).toBe(false);
    store.markSidebarAdopted();
    const first = store.getMeta("sidebar_adopted_at");
    expect(store.sidebarAdopted()).toBe(true);
    store.markSidebarAdopted();
    expect(store.getMeta("sidebar_adopted_at")).toBe(first);
  });

  it("keeps ONE open questions ticket per task and refuses past the limit", () => {
    const store = fresh();
    const task = store.createTask({ projectId: "p", title: "T", brief: "b" });
    const first = store.addQuestions(task.id, [q("One?"), q("Two?")], 3);
    const second = store.addQuestions(task.id, [q("Two?"), q("Three?")], 3);
    expect(second.id).toBe(first.id);
    expect(second.questions).toEqual([line("One?"), line("Two?"), line("Three?")]);
    expect(second.asks.map((ask) => ask.question)).toEqual(["One?", "Two?", "Three?"]);
    expect(() => store.addQuestions(task.id, [q("Four?")], 3)).toThrow(/limit is 3/);
    expect(store.tickets({ status: "open" })).toHaveLength(1);
    store.closeTicket(first.id, ["a", "b", "c"]);
    expect(store.tickets({ status: "open" })).toHaveLength(0);
    expect(store.addQuestions(task.id, [q("Five?")], 3).id).not.toBe(first.id);
  });

  it("replaces the open ticket's questions on the same ticket when asked to", () => {
    const store = fresh();
    const task = store.createTask({ projectId: "p", title: "T", brief: "b" });
    const first = store.addQuestions(task.id, [q("One?"), q("Two?")], 3);
    const replaced = store.addQuestions(task.id, [q("Three?")], 3, true);
    expect(replaced.id).toBe(first.id);
    expect(replaced.questions).toEqual([line("Three?")]);
    expect(replaced.asks.map((ask) => ask.question)).toEqual(["Three?"]);
    expect(store.tickets({ status: "open" })).toHaveLength(1);
    expect(store.addQuestions(task.id, [q("Four?")], 3).questions).toEqual([line("Three?"), line("Four?")]);
    expect(() => store.addQuestions(task.id, [q("A?"), q("B?"), q("C?"), q("D?")], 3, true)).toThrow(/limit is 3/);
    expect(store.ticket(first.id)?.questions).toEqual([line("Three?"), line("Four?")]);
    const other = store.addQuestions(store.createTask({ projectId: "p", title: "U", brief: "b" }).id, [q("X?")], 3, true);
    expect(other.questions).toEqual([line("X?")]);
  });

  it("voids only the open review hand-off, once, and a new one opens fresh", () => {
    const store = fresh();
    const task = store.createTask({ projectId: "p", title: "T", brief: "b" });
    const questions = store.addQuestions(task.id, [q("Q?")], 3);
    const review = store.openReview(task.id);
    expect(store.closeReview(task.id)?.id).toBe(review.id);
    expect(store.closeReview(task.id)).toBeNull();
    expect(store.tickets({ status: "open" }).map((ticket) => ticket.id)).toEqual([questions.id]);
    expect(store.openReview(task.id).id).not.toBe(review.id);
  });

  it("closing a task releases its claims and its tickets", () => {
    const store = fresh();
    const task = store.createTask({ projectId: "p", title: "T", brief: "b" });
    store.addClaims(task.id, "p", ["src/a.ts", "docs/**"]);
    store.addQuestions(task.id, [q("Q?")], 3);
    expect(store.claims()).toHaveLength(2);
    store.closeTask(task.id, "PR merged");
    expect(store.claims()).toHaveLength(0);
    expect(store.tickets({ status: "open" })).toHaveLength(0);
    expect(store.tasks({ includeClosed: false })).toHaveLength(0);
    expect(store.task(task.id)?.stage).toBe("done");
  });

  it("closing a task drops its kept report; releasing without close keeps it", () => {
    const store = fresh();
    const task = store.createTask({ projectId: "p", title: "T", brief: "b" });
    store.setMeta(reportKey(task.id), "landed on main as a94a2f1");
    store.releaseTask(task.id, { reason: "slot back", by: "patches", close: false });
    expect(store.getMeta(reportKey(task.id))).toBe("landed on main as a94a2f1");
    store.closeTask(task.id, "Landed on main at a94a2f1: x");
    expect(store.getMeta(reportKey(task.id))).toBeNull();
  });

  it("closeTask gives the build slot back and records the release", () => {
    const store = fresh();
    const task = store.createTask({ projectId: "p", title: "T", brief: "b" });
    store.updateTask(task.id, { stage: "build", buildState: "running" });
    store.addClaims(task.id, "p", ["CLAUDE.md", "src/a.ts"]);
    store.closeTask(task.id, "PR #61 merged.");
    expect(store.task(task.id)?.buildState).toBe("none");
    expect(store.releases(task.id)).toEqual([
      { paths: ["CLAUDE.md", "src/a.ts"], reason: "PR #61 merged.", by: "auto", closed: true, at: expect.any(Number) },
    ]);
  });

  it("releaseTask without close empties claims and the build slot but keeps the task open", () => {
    const store = fresh();
    const task = store.createTask({ projectId: "p", title: "T", brief: "b" });
    const other = store.createTask({ projectId: "p", title: "U", brief: "b" });
    store.updateTask(task.id, { stage: "build", buildState: "preparing" });
    store.addClaims(task.id, "p", ["src/a.ts", "docs/**"]);
    store.addClaims(other.id, "p", ["src/b.ts"]);
    store.addQuestions(task.id, [q("Q?")], 3);
    const released = store.releaseTask(task.id, { reason: "Merged via another PR.", by: "patches", close: false });
    expect(released).toEqual(["docs/**", "src/a.ts"]);
    expect(store.claimsFor(task.id)).toEqual([]);
    expect(store.claimsFor(other.id)).toEqual(["src/b.ts"]);
    const after = store.task(task.id);
    expect(after).toMatchObject({ buildState: "none", stage: "build", closedAt: null });
    expect(store.tickets({ status: "open" })).toHaveLength(1);
    expect(store.releases(task.id)).toEqual([
      { paths: ["docs/**", "src/a.ts"], reason: "Merged via another PR.", by: "patches", closed: false, at: expect.any(Number) },
    ]);
  });

  it("releaseTask keeps a failed build's state", () => {
    const store = fresh();
    const task = store.createTask({ projectId: "p", title: "T", brief: "b" });
    store.updateTask(task.id, { stage: "build", buildState: "failed" });
    store.releaseTask(task.id, { reason: "Re-scoping it.", by: "patches", close: false });
    expect(store.task(task.id)?.buildState).toBe("failed");
  });

  it("releaseTask with close closes the task and its tickets", () => {
    const store = fresh();
    const task = store.createTask({ projectId: "p", title: "T", brief: "b" });
    store.updateTask(task.id, { stage: "build", buildState: "running" });
    store.addClaims(task.id, "p", ["src/a.ts"]);
    store.addQuestions(task.id, [q("Q?")], 3);
    store.releaseTask(task.id, { reason: "Abandoned: superseded by task_2.", by: "patches", close: true });
    expect(store.task(task.id)).toMatchObject({
      stage: "done",
      buildState: "none",
      note: "Abandoned: superseded by task_2.",
      closedAt: expect.any(Number),
    });
    expect(store.tickets({ status: "open" })).toHaveLength(0);
    expect(store.claims()).toHaveLength(0);
    expect(store.releases(task.id)[0]).toMatchObject({ by: "patches", closed: true, paths: ["src/a.ts"] });
  });

  it("withdraws a whole ticket: closed, no answers, its questions and reason recorded", () => {
    const store = fresh();
    const task = store.createTask({ projectId: "p", title: "T", brief: "b" });
    const ticket = store.addQuestions(task.id, [q("One?"), q("Two?")], 3);
    const closed = store.withdrawTicket(ticket.id, { reason: "Settled by a decision.", by: "patches" });
    expect(closed).toMatchObject({ status: "closed", answers: null, closedAt: expect.any(Number) });
    expect(store.tickets({ status: "open" })).toHaveLength(0);
    expect(store.withdrawals(task.id)).toEqual([
      {
        ticketId: ticket.id,
        taskId: task.id,
        questions: [line("One?"), line("Two?")],
        reason: "Settled by a decision.",
        by: "patches",
        at: expect.any(Number),
      },
    ]);
    expect(() => store.withdrawTicket(ticket.id, { reason: "again, again", by: "task" })).toThrow(/not an open ticket/);
    expect(store.withdrawals(task.id)).toHaveLength(1);
  });

  it("withdraws single questions with their asks; the last one closes the ticket", () => {
    const store = fresh();
    const task = store.createTask({ projectId: "p", title: "T", brief: "b" });
    const ticket = store.addQuestions(task.id, [q("One?"), q("Two?"), q("Three?")], 3);
    const left = store.withdrawQuestions(ticket.id, [1, 3], { reason: "Decided in the repo.", by: "task" });
    expect(left).toMatchObject({ status: "open", questions: [line("Two?")] });
    expect(left.asks.map((ask) => ask.question)).toEqual(["Two?"]);
    const last = store.withdrawQuestions(ticket.id, [1], { reason: "No longer needed.", by: "task" });
    expect(last).toMatchObject({ status: "closed", answers: null, questions: [] });
    expect(store.withdrawals(task.id).map((w) => [w.questions, w.by])).toEqual([
      [[line("One?"), line("Three?")], "task"],
      [[line("Two?")], "task"],
    ]);
  });

  it("withdraws no question it does not have, and records nothing then", () => {
    const store = fresh();
    const task = store.createTask({ projectId: "p", title: "T", brief: "b" });
    const ticket = store.addQuestions(task.id, [q("One?")], 3);
    expect(() => store.withdrawQuestions(ticket.id, [2], { reason: "Out of range.", by: "task" })).toThrow(/no question 2/);
    expect(store.ticket(ticket.id)).toMatchObject({ status: "open", questions: [line("One?")] });
    expect(store.withdrawals(task.id)).toEqual([]);
  });

  it("stores the head sha", () => {
    const store = fresh();
    const task = store.createTask({ projectId: "p", title: "T", brief: "b" });
    expect(task.headSha).toBeNull();
    expect(store.updateTask(task.id, { headSha: "abc1234" }).headSha).toBe("abc1234");
  });

  it("stores the head the ai-tests label went on", () => {
    const store = fresh();
    const task = store.createTask({ projectId: "p", title: "T", brief: "b" });
    expect(task.labelledSha).toBeNull();
    expect(store.updateTask(task.id, { labelledSha: "cc65f6a" }).labelledSha).toBe("cc65f6a");
    expect(store.task(task.id)?.labelledSha).toBe("cc65f6a");
  });

  it("rolls a failed transaction back", () => {
    const store = fresh();
    const task = store.createTask({ projectId: "p", title: "T", brief: "b" });
    expect(() =>
      store.transaction(() => {
        store.addClaims(task.id, "p", ["src/a.ts"]);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.claims()).toHaveLength(0);
  });

  it("runs a store method that opens its own transaction inside a transaction", () => {
    const store = fresh();
    const task = store.createTask({ projectId: "p", title: "T", brief: "b" });
    store.addClaims(task.id, "p", ["src/a.ts"]);
    store.updateTask(task.id, { stage: "build", buildState: "running", branch: "task/t" });
    // The keep-open path after a step lands: release, then reset the stage.
    store.transaction(() => {
      store.releaseTask(task.id, { reason: "Step landed", by: "auto", close: false });
      store.updateTask(task.id, { stage: "research", buildState: "none", branch: null });
    });
    expect(store.claims()).toHaveLength(0);
    expect(store.releases(task.id)).toMatchObject([{ paths: ["src/a.ts"], reason: "Step landed", closed: false }]);
    expect(store.task(task.id)).toMatchObject({ stage: "research", buildState: "none", branch: null, closedAt: null });
  });

  it("rolls an inner transaction's work back when the outer one fails after it", () => {
    const store = fresh();
    const task = store.createTask({ projectId: "p", title: "T", brief: "b" });
    store.addClaims(task.id, "p", ["src/a.ts"]);
    expect(() =>
      store.transaction(() => {
        store.releaseTask(task.id, { reason: "Step landed", by: "auto", close: false });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.claimsFor(task.id)).toEqual(["src/a.ts"]);
    expect(store.releases(task.id)).toEqual([]);
  });

  it("starts a fresh transaction after a nested one failed", () => {
    const store = fresh();
    const task = store.createTask({ projectId: "p", title: "T", brief: "b" });
    // The inner transaction is the one that throws: no such task.
    expect(() =>
      store.transaction(() => {
        store.addClaims(task.id, "p", ["src/a.ts"]);
        store.releaseTask("task_missing", { reason: "r", by: "auto", close: false });
      }),
    ).toThrow(/No task task_missing/);
    expect(store.claims()).toHaveLength(0);
    // The depth is back to zero: this one begins and commits for real...
    store.transaction(() => store.addClaims(task.id, "p", ["src/b.ts"]));
    expect(store.claimsFor(task.id)).toEqual(["src/b.ts"]);
    // ...and a later failure rolls back only its own work.
    expect(() =>
      store.transaction(() => {
        store.addClaims(task.id, "p", ["src/c.ts"]);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.claimsFor(task.id)).toEqual(["src/b.ts"]);
  });

  it("stores project prefs and meta", () => {
    const store = fresh();
    store.setProjectPrefs("p", { color: "teal" });
    store.setProjectPrefs("p", { hidden: true });
    expect(store.projectPrefs()).toEqual([{ projectId: "p", color: "teal", hidden: true }]);
    store.setMeta("orchestrator_thread_id", "thr_p");
    expect(store.getMeta("orchestrator_thread_id")).toBe("thr_p");
    store.setMeta("orchestrator_thread_id", null);
    expect(store.getMeta("orchestrator_thread_id")).toBeNull();
  });

  it("lists meta rows by key prefix, and only those", () => {
    const store = fresh();
    store.setMeta("claim_wait:task_b", "b");
    store.setMeta("claim_wait:task_a", "a");
    store.setMeta("claim_waiting", "not one");
    store.setMeta("claim_wait%", "not one either");
    store.setMeta("orchestrator_thread_id", "thr_p");
    expect(store.metaWithPrefix("claim_wait:")).toEqual([
      { key: "claim_wait:task_a", value: "a" },
      { key: "claim_wait:task_b", value: "b" },
    ]);
    expect(store.metaWithPrefix("nothing:")).toEqual([]);
  });

  it("records children and their summaries", () => {
    const store = fresh();
    store.addChild({ threadId: "thr_r", taskId: "task_1", kind: "research", label: "Where is X?" });
    store.setChildSummary("thr_r", "In src/x.ts:12");
    expect(store.child("thr_r")).toMatchObject({ kind: "research", summary: "In src/x.ts:12" });
  });
});

describe("browser lease", () => {
  it("holds one holder at a time, renews without moving since, and releases only for its holder", () => {
    const store = fresh();
    expect(store.browserLease()).toBeNull();
    const first = store.acquireBrowserLease("thr_a", "task_1");
    expect(first).toMatchObject({ holderThreadId: "thr_a", taskId: "task_1" });
    const renewed = store.acquireBrowserLease("thr_a", "task_1");
    expect(renewed.since).toBe(first.since);
    expect(renewed.renewedAt).toBeGreaterThan(first.renewedAt);
    expect(store.releaseBrowserLease("thr_b")).toBe(false);
    expect(store.browserLease()?.holderThreadId).toBe("thr_a");
    expect(store.releaseBrowserLease("thr_a")).toBe(true);
    expect(store.browserLease()).toBeNull();
  });
  it("hands a stale lease to a new holder with a fresh since", () => {
    const store = fresh();
    const old = store.acquireBrowserLease("thr_a", "task_1");
    const next = store.acquireBrowserLease("thr_b", null);
    expect(next).toMatchObject({ holderThreadId: "thr_b", taskId: null });
    expect(next.since).toBeGreaterThan(old.since);
  });

  describe("jev watch", () => {
    const ask = {
      model: "anyjev-qwen3-8b",
      latencyMs: 400,
      error: null,
      jevKind: "build",
      jevKindTop: 0.8,
      jevKindMargin: 0.6,
      jevTier: "small",
      jevTierTop: 0.7,
      jevTierMargin: 0.5,
    };

    it("records an ask and, when the task closes, what it turned out to be", () => {
      const store = fresh();
      const task = store.createTask({ projectId: "p", title: "T", brief: "b" });
      store.recordJevAsk({ taskId: task.id, projectId: "p", askedAt: 5, ...ask });
      store.addChild({ threadId: "thr_b1", taskId: task.id, kind: "build", label: "Build" });
      store.addClaims(task.id, "p", ["a.ts", "b.ts"]);
      expect(store.listJevWatch("p")[0]).toMatchObject({ jevKind: "build", actualKind: null, actualAt: null });
      store.closeTask(task.id, "Landed on main at abc: x");
      expect(store.listJevWatch("p")[0]).toMatchObject({ actualKind: "build", actualTier: "small" });
      expect(store.listJevWatch("p")[0].actualAt).not.toBeNull();
      expect(store.listJevWatch("other")).toEqual([]);
      expect(store.listJevWatch()).toHaveLength(1);
    });

    it("counts files released before the close, questions to the owner and builds", () => {
      const store = fresh();
      const task = store.createTask({ projectId: "p", title: "T", brief: "b" });
      store.addClaims(task.id, "p", ["a.ts", "b.ts", "c.ts"]);
      store.releaseTask(task.id, { reason: "PR merged", by: "auto", close: false });
      store.addClaims(task.id, "p", ["c.ts", "d.ts"]);
      store.addChild({ threadId: "thr_b1", taskId: task.id, kind: "build", label: "Build" });
      store.addChild({ threadId: "thr_r1", taskId: task.id, kind: "research", label: "Research" });
      expect(store.jevFacts(task.id)).toEqual({ builds: 1, buildFailures: 0, asksToSam: 0, filesTouched: 4 });
      store.addQuestions(task.id, [q("One?"), q("Two?")], 3);
      expect(store.jevFacts(task.id).asksToSam).toBe(2);
    });

    it("closing a task Jev was never asked about writes nothing", () => {
      const store = fresh();
      const task = store.createTask({ projectId: "p", title: "T", brief: "b" });
      store.closeTask(task.id, "done");
      expect(store.listJevWatch()).toEqual([]);
      expect(store.task(task.id)?.closedAt).not.toBeNull();
    });
  });

  describe("model routes", () => {
    const record = { model: "claude-sonnet-5-5", reason: "sonnet", probability: 0.86, jevModel: "jev-1.13.0", error: null } as const;

    it("records one row per thread and reads it back", () => {
      const store = fresh();
      store.recordModelRoute({ threadId: "thr_a", taskId: "task_1", projectId: "p", role: "build", routedAt: 10, ...record });
      store.recordModelRoute({
        threadId: "thr_b",
        taskId: "task_1",
        projectId: "p",
        role: "research",
        routedAt: 20,
        model: null,
        reason: "timeout",
        probability: null,
        jevModel: null,
        error: "no answer in 2000 ms",
      });
      expect(store.modelRoutes()).toEqual([
        { threadId: "thr_a", taskId: "task_1", projectId: "p", role: "build", routedAt: 10, ...record },
        {
          threadId: "thr_b",
          taskId: "task_1",
          projectId: "p",
          role: "research",
          routedAt: 20,
          model: null,
          reason: "timeout",
          probability: null,
          jevModel: null,
          error: "no answer in 2000 ms",
        },
      ]);
      expect(store.modelRoutes(15).map((row) => row.threadId)).toEqual(["thr_b"]);
    });

    it("a second record for the same thread replaces the first", () => {
      const store = fresh();
      store.recordModelRoute({ threadId: "thr_a", taskId: "task_1", projectId: "p", role: "task", routedAt: 10, ...record });
      store.recordModelRoute({ threadId: "thr_a", taskId: "task_1", projectId: "p", role: "task", routedAt: 11, ...record, model: null, reason: "opus" });
      expect(store.modelRoutes()).toHaveLength(1);
      expect(store.modelRoutes()[0]).toMatchObject({ model: null, reason: "opus", routedAt: 11 });
    });
  });
});

describe("report tickets", () => {
  const report = (title: string) => ({ path: `/r/task/${title}.md`, title, summary: null });

  it("keeps at most one open per task: submitting again replaces it, never stacks", () => {
    const store = fresh();
    const task = store.createTask({ projectId: "proj_f", title: "Check", brief: "b" });
    const first = store.submitReport(task.id, { path: "/r/a.md", title: "First", summary: "One line." });
    expect(first.replaced).toBe(false);
    expect(first.ticket).toMatchObject({ kind: "report", status: "open", questions: [], report: { path: "/r/a.md", title: "First", summary: "One line." } });
    const second = store.submitReport(task.id, { path: "/r/b.md", title: "Second", summary: null });
    expect(second).toMatchObject({ replaced: true, ticket: { id: first.ticket.id, report: { path: "/r/b.md", title: "Second", summary: null } } });
    expect(store.tickets({ status: "open" }).filter((t) => t.kind === "report")).toHaveLength(1);
    expect(store.latestReport(task.id)?.report?.title).toBe("Second");
  });

  it("opens a new one after the last was reviewed, and Completed still finds the newest", () => {
    const store = fresh();
    const task = store.createTask({ projectId: "proj_f", title: "Check", brief: "b" });
    const first = store.submitReport(task.id, report("first")).ticket;
    store.closeTicket(first.id, null);
    const next = store.submitReport(task.id, report("second"));
    expect(next.replaced).toBe(false);
    expect(next.ticket.id).not.toBe(first.id);
    expect(store.latestReport(task.id)?.id).toBe(next.ticket.id);
    expect(store.latestReport("task_none")).toBeNull();
  });

  it("is a ticket of its own: questions and a report live side by side", () => {
    const store = fresh();
    const task = store.createTask({ projectId: "proj_f", title: "Check", brief: "b" });
    store.addQuestions(task.id, [q("Which?")], 3);
    store.submitReport(task.id, report("r"));
    expect(store.openTicket(task.id, "questions")?.questions).toEqual([line("Which?")]);
    expect(store.openTicket(task.id, "report")?.report?.title).toBe("r");
    expect(store.ticket(store.openTicket(task.id, "questions")!.id)?.report).toBeNull();
  });

  it("closes with its task, and a withdrawal records which report went", () => {
    const store = fresh();
    const task = store.createTask({ projectId: "proj_f", title: "Check", brief: "b" });
    const { ticket } = store.submitReport(task.id, report("Jev check"));
    store.withdrawTicket(ticket.id, { reason: "Superseded by the successor task.", by: "patches" });
    expect(store.withdrawals(task.id)).toMatchObject([{ ticketId: ticket.id, questions: ["Report: Jev check"], by: "patches" }]);
    const again = store.submitReport(task.id, report("Again")).ticket;
    store.closeTask(task.id, "Done: Report reviewed by Alex");
    expect(store.ticket(again.id)?.status).toBe("closed");
  });
});
