import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Ask } from "./attention";
import { landCandidate, landedClose, taskTrailer } from "./landed";
import { Store, type SqlDb, type Ticket } from "./store";
import {
  closeHold,
  heldCloseMessage,
  holdWhat,
  releaseCloseRefusal,
  withdrawDecision,
  withdrawnByPatchesMessage,
  withdrawnWhat,
} from "./tickets";
import { setOwner } from "./owner";

// The name is whoever runs it (owner.ts): a neutral one here, the fallback after.
beforeEach(() => setOwner("Alex"));
afterEach(() => setOwner(null));

const ask = (question: string): Ask => ({ kind: "decision", question, options: ["yes", "no"], recommended: 0 });

const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: "tkt_zyvdrk0sab",
  taskId: "task_uf5p8wat0b",
  kind: "questions",
  questions: ["Q1", "Q2", "Q3"],
  asks: [ask("Q1"), ask("Q2"), ask("Q3")],
  answers: null,
  status: "open",
  createdAt: 1,
  closedAt: null,
  ...overrides,
});

const review = ticket({ id: "tkt_review", kind: "review", questions: [], asks: [] });
const report = ticket({
  id: "tkt_report",
  kind: "report",
  questions: [],
  asks: [],
  report: { path: "/Users/a/.bb/thread-storage/task_uf5p8wat0b/report.md", title: "Jev check", summary: null },
});
const own = { kind: "task" as const, taskId: "task_uf5p8wat0b" };
const patches = { kind: "orchestrator" as const, projectId: "proj_orc" };
const ticketTask = { id: "task_uf5p8wat0b", projectId: "proj_orc" };
const reason = "Answered by Patches' decision on task_4yqs06t885.";

describe("closeHold", () => {
  it("holds a close on an open questions ticket", () => {
    expect(closeHold([ticket({ questions: ["a", "b"] })])).toEqual({ ticketId: "tkt_zyvdrk0sab", kind: "questions", questions: 2 });
  });

  it("does not hold on a review ticket or on nothing", () => {
    expect(closeHold([review])).toBeNull();
    expect(closeHold([])).toBeNull();
  });

  it("finds the questions ticket beside a review one", () => {
    expect(closeHold([review, ticket()])?.ticketId).toBe("tkt_zyvdrk0sab");
  });

  it("says why the task stays open and how it closes", () => {
    const message = heldCloseMessage("task_uf5p8wat0b", { ticketId: "tkt_zyvdrk0sab", kind: "questions", questions: 2 }, "Reloaded: abc1234 is live.");
    expect(message).toBe(
      "Reloaded: abc1234 is live. task_uf5p8wat0b stays open: its ticket tkt_zyvdrk0sab has 2 open questions to Alex. Its claims are released. It closes on its own once they are answered or withdrawn (ask_sam withdraw, with a reason).",
    );
  });
});

describe("closeHold with a report waiting on the owner", () => {
  it("holds a close on an open report ticket, exactly like questions", () => {
    expect(closeHold([report])).toEqual({ ticketId: "tkt_report", kind: "report", questions: 0 });
    expect(closeHold([review, report])?.ticketId).toBe("tkt_report");
  });

  it("names the questions first when both are open", () => {
    expect(closeHold([report, ticket()])).toMatchObject({ ticketId: "tkt_zyvdrk0sab", kind: "questions" });
  });

  it("says the report waits on the owner's review, and how the task closes", () => {
    const hold = closeHold([report])!;
    expect(holdWhat(hold)).toBe("has a report waiting on Alex to review");
    expect(heldCloseMessage("task_uf5p8wat0b", hold, "Landed.")).toBe(
      "Landed. task_uf5p8wat0b stays open: its ticket tkt_report has a report waiting on Alex to review. Its claims are released. It closes on its own once Alex marks the report reviewed, or the ticket is withdrawn (ask_sam withdraw, with a reason).",
    );
  });

  it("refuses release_task close while the report is open", () => {
    expect(releaseCloseRefusal([report])).toBe(
      "tkt_report has a report waiting on Alex to review: withdraw tkt_report with a reason first (ask_sam withdraw), or let Alex mark the report reviewed.",
    );
    expect(releaseCloseRefusal([{ ...report, status: "closed" }].filter((t) => t.status === "open"))).toBeNull();
  });

  it("lets the task or Patches withdraw a report, whole and with a reason", () => {
    const base = { ticket: report, ticketTask, reason };
    expect(withdrawDecision({ ...base, caller: own })).toEqual({ kind: "ticket" });
    expect(withdrawDecision({ ...base, caller: patches })).toEqual({ kind: "ticket" });
    expect(withdrawDecision({ ...base, caller: { kind: "task", taskId: "task_4yqs06t885" } })).toMatch(/belongs to task_uf5p8wat0b/);
    expect(withdrawDecision({ ...base, caller: own, reason: "too short" })).toMatch(/at least 10 characters/);
    expect(withdrawDecision({ ...base, caller: own, questions: [1] })).toBe("tkt_report is a report: withdraw it whole, without questions.");
  });
});

describe("releaseCloseRefusal", () => {
  it("refuses a close while a questions ticket is open, naming how to withdraw", () => {
    expect(releaseCloseRefusal([ticket({ questions: ["a"] })])).toBe(
      "tkt_zyvdrk0sab has 1 open question to Alex: withdraw tkt_zyvdrk0sab with a reason first (ask_sam withdraw), or let Alex answer it.",
    );
  });

  it("lets a close through with no ticket or only a review one", () => {
    expect(releaseCloseRefusal([])).toBeNull();
    expect(releaseCloseRefusal([review])).toBeNull();
  });
});

describe("withdrawDecision", () => {
  const base = { caller: own, ticket: ticket(), ticketTask, reason };

  it("lets a task withdraw its own whole ticket", () => {
    expect(withdrawDecision(base)).toEqual({ kind: "ticket" });
  });

  it("refuses a task withdrawing another task's ticket", () => {
    expect(withdrawDecision({ ...base, caller: { kind: "task", taskId: "task_4yqs06t885" } })).toMatch(
      /belongs to task_uf5p8wat0b; you can withdraw only your own/,
    );
  });

  it("refuses children and unknown callers", () => {
    expect(withdrawDecision({ ...base, caller: null })).toMatch(/Only Patches and task threads/);
  });

  it("lets Patches withdraw any ticket in her chat's project, and nothing outside it", () => {
    expect(withdrawDecision({ ...base, caller: patches })).toEqual({ kind: "ticket" });
    expect(withdrawDecision({ ...base, caller: { kind: "orchestrator", projectId: "proj_other" } })).toMatch(
      /not in this chat's project/,
    );
    expect(withdrawDecision({ ...base, caller: patches, ticketTask: null })).toMatch(/not in this chat's project/);
  });

  it("refuses a missing or closed ticket", () => {
    expect(withdrawDecision({ ...base, ticket: null })).toBe("No such ticket.");
    expect(withdrawDecision({ ...base, ticket: ticket({ status: "closed" }) })).toMatch(/already closed/);
  });

  it("requires a reason of at least 10 characters", () => {
    expect(withdrawDecision({ ...base, reason: "   stale  " })).toMatch(/at least 10 characters/);
    expect(withdrawDecision({ ...base, reason: "0123456789" })).toEqual({ kind: "ticket" });
  });

  it("withdraws single questions, keeping the rest and their asks in step", () => {
    expect(withdrawDecision({ ...base, questions: [3, 1] })).toEqual({
      kind: "questions",
      remaining: ["Q2"],
      remainingAsks: [ask("Q2")],
      removed: [1, 3],
    });
  });

  it("keeps no asks for an old ticket that never had them", () => {
    const plan = withdrawDecision({ ...base, ticket: ticket({ asks: [] }), questions: [2] });
    expect(plan).toEqual({ kind: "questions", remaining: ["Q1", "Q3"], remainingAsks: [], removed: [2] });
  });

  it("treats withdrawing every question as the whole ticket", () => {
    expect(withdrawDecision({ ...base, questions: [1, 2, 3] })).toEqual({ kind: "ticket" });
  });

  it("refuses question numbers out of range, not whole, or repeated", () => {
    expect(withdrawDecision({ ...base, questions: [0] })).toMatch(/no question 0/);
    expect(withdrawDecision({ ...base, questions: [4] })).toMatch(/questions 1-3; there is no question 4/);
    expect(withdrawDecision({ ...base, questions: [1.5] })).toMatch(/no question 1.5/);
    expect(withdrawDecision({ ...base, questions: [2, 2] })).toBe("Name each question once.");
  });

  it("lets only Patches withdraw a review hand-off, and only whole", () => {
    expect(withdrawDecision({ ...base, ticket: review })).toMatch(/only Patches withdraws it/);
    expect(withdrawDecision({ ...base, caller: patches, ticket: review })).toEqual({ kind: "ticket" });
    expect(withdrawDecision({ ...base, caller: patches, ticket: review, questions: [1] })).toMatch(/withdraw it whole/);
  });

  it("words what went and what the task hears from Patches", () => {
    expect(withdrawnWhat({ kind: "ticket" })).toBe("the whole ticket");
    expect(withdrawnWhat({ kind: "questions", remaining: [], remainingAsks: [], removed: [2] })).toBe("question 2");
    expect(withdrawnByPatchesMessage("tkt_0zkqikk84n", { kind: "questions", remaining: [], remainingAsks: [], removed: [1, 3] }, ` ${reason} `)).toBe(
      `[The Orchestrator] Patches withdrew tkt_0zkqikk84n (questions 1, 3): ${reason}`,
    );
  });
});

// task_uf5p8wat0b, 2026-09-29: landed, its reload went live, and the close took
// tkt_zyvdrk0sab (2 open questions to the owner) off Needs you with it.
describe("an automatic close with an open questions ticket (the uf5p case)", () => {
  function landedTask() {
    const db = new DatabaseSync(":memory:");
    Store.migrateInPlace(db as unknown as SqlDb);
    let clock = 1000;
    const store = new Store(db as unknown as SqlDb, () => (clock += 1));
    const task = store.createTask({ projectId: "proj_orc", title: "Prod env keys", brief: "b" });
    store.updateTask(task.id, { stage: "build", buildState: "none", verifiedSha: "abc1234def" });
    store.addClaims(task.id, "proj_orc", ["server.ts"]);
    const questions = store.addQuestions(task.id, [ask("Which key for prod?"), ask("Rotate the old one?")], 3);
    return { store, taskId: task.id, ticketId: questions.id };
  }

  /** What server.ts does when a reload goes live: hold the close, or close. */
  function reloadLive(store: Store, taskId: string): "held" | "closed" {
    const hold = closeHold(store.tickets({ status: "open" }).filter((open) => open.taskId === taskId));
    if (hold === null) {
      store.closeTask(taskId, "Landed on main at abc1234: env keys");
      return "closed";
    }
    if (store.claimsFor(taskId).length > 0) store.releaseTask(taskId, { reason: "held", by: "auto", close: false });
    return "held";
  }

  /** landed.ts's later check, as closeLanded in server.ts runs it. */
  function landedCheck(store: Store, taskId: string): string | null {
    const task = store.task(taskId)!;
    return landedClose({
      task,
      ownShas: [task.verifiedSha!],
      commits: [{ sha: "abc1234def0", committedAt: task.createdAt + 10, message: `env keys\n\n${taskTrailer(taskId)}` }],
      base: "main",
      openTickets: store.tickets({ status: "open" }).filter((open) => open.taskId === taskId).length,
      running: false,
      reloadPending: false,
    });
  }

  it("keeps the task and its ticket open, gives its claims back, and closes once the ticket is withdrawn", () => {
    const { store, taskId, ticketId } = landedTask();
    expect(reloadLive(store, taskId)).toBe("held");
    const task = store.task(taskId)!;
    expect(task.closedAt).toBeNull();
    // land() leaves the stage alone, so landed.ts still looks at it.
    expect(landCandidate(task)).toBe(true);
    expect(store.claimsFor(taskId)).toEqual([]);
    expect(store.ticket(ticketId)).toMatchObject({ status: "open", questions: [expect.any(String), expect.any(String)] });
    expect(landedCheck(store, taskId)).toBeNull();

    store.withdrawTicket(ticketId, { reason, by: "patches" });
    const note = landedCheck(store, taskId);
    expect(note).not.toBeNull();
    store.closeTask(taskId, note!);
    expect(store.task(taskId)?.closedAt).not.toBeNull();
  });

  it("closes once the owner answers the ticket", () => {
    const { store, taskId, ticketId } = landedTask();
    expect(reloadLive(store, taskId)).toBe("held");
    store.closeTicket(ticketId, ["Use the new key", "Yes"]);
    expect(landedCheck(store, taskId)).not.toBeNull();
    expect(reloadLive(store, taskId)).toBe("closed");
  });

  it("records one release when it holds, not one per check", () => {
    const { store, taskId } = landedTask();
    reloadLive(store, taskId);
    reloadLive(store, taskId);
    expect(store.releases(taskId)).toHaveLength(1);
  });
});

// task "Critical validation of jev and headroom", 2026-10-04: its findings were
// relayed in chat only; it was closed and archived with nothing to review.
describe("a research task with its report open", () => {
  function reportTask() {
    const db = new DatabaseSync(":memory:");
    Store.migrateInPlace(db as unknown as SqlDb);
    let clock = 1000;
    const store = new Store(db as unknown as SqlDb, () => (clock += 1));
    const task = store.createTask({ projectId: "proj_orc", title: "Validate Jev", brief: "b" });
    store.updateTask(task.id, { stage: "build", buildState: "none", verifiedSha: "abc1234def" });
    const { ticket: opened } = store.submitReport(task.id, { path: `/r/${task.id}/report.md`, title: "Jev check", summary: "Two findings." });
    return { store, taskId: task.id, ticketId: opened.id };
  }

  it("holds landed.ts's close until the owner marks it reviewed", () => {
    const { store, taskId, ticketId } = reportTask();
    const check = () =>
      landedClose({
        task: store.task(taskId)!,
        ownShas: ["abc1234def"],
        commits: [{ sha: "abc1234def0", committedAt: 2000, message: `x\n\n${taskTrailer(taskId)}` }],
        base: "main",
        openTickets: store.tickets({ status: "open" }).filter((open) => open.taskId === taskId).length,
        running: false,
        reloadPending: false,
      });
    expect(closeHold(store.tickets({ status: "open" }))).toMatchObject({ ticketId, kind: "report" });
    expect(check()).toBeNull();
    store.closeTicket(ticketId, null);
    expect(check()).not.toBeNull();
  });
});
