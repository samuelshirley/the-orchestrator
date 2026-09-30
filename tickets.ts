// The owner's tickets as open work, and how one is withdrawn. An open questions
// ticket holds every automatic close (land's reload-live and no-reload close,
// a merged/closed PR or a gone branch): the task gives its claims back but
// stays open until the owner answers or the ticket is withdrawn with a reason
// (task_uf5p8wat0b's two questions vanished with its close on 2026-09-29).
// Review tickets hold nothing: a merged or closed PR voids the hand-off.
// Pure; tickets.test.ts pins it.
import { owner } from "./owner";
import type { Ask } from "./attention";
import type { Task, Ticket } from "./store";

/** The shortest reason a withdrawal is recorded with. */
export const WITHDRAW_REASON_MIN = 10;

type Holding = Pick<Ticket, "id" | "kind" | "questions">;

/** The open questions ticket that holds an automatic close, or null when none does. */
export function closeHold(openTickets: readonly Holding[]): { ticketId: string; questions: number } | null {
  const ticket = openTickets.find((open) => open.kind === "questions");
  return ticket === undefined ? null : { ticketId: ticket.id, questions: ticket.questions.length };
}

const count = (n: number) => `${n} open question${n === 1 ? "" : "s"}`;

/** Told to the task thread when an automatic close is held: `what` is why it would have closed. */
export function heldCloseMessage(taskId: string, hold: { ticketId: string; questions: number }, what: string): string {
  return `${what} ${taskId} stays open: its ticket ${hold.ticketId} has ${count(hold.questions)} to ${owner()}. Its claims are released. It closes on its own once they are answered or withdrawn (ask_sam withdraw, with a reason).`;
}

/** The meta key that remembers which ticket a held close was told about, so it is told once. */
export const closeHeldKey = (taskId: string) => `close_held:${taskId}`;

/** release_task close: true refuses while a questions ticket is open. */
export function releaseCloseRefusal(openTickets: readonly Holding[]): string | null {
  const hold = closeHold(openTickets);
  if (hold === null) return null;
  return `${hold.ticketId} has ${count(hold.questions)} to ${owner()}: withdraw ${hold.ticketId} with a reason first (ask_sam withdraw), or let ${owner()} answer it.`;
}

export type WithdrawCaller = { kind: "orchestrator"; projectId: string } | { kind: "task"; taskId: string } | null;

export type WithdrawPlan =
  | { kind: "ticket" }
  | { kind: "questions"; remaining: string[]; remainingAsks: Ask[]; removed: number[] };

/** A withdrawal's plan, or why it is refused. */
export function withdrawDecision({
  caller,
  ticket,
  ticketTask,
  questions,
  reason,
}: {
  caller: WithdrawCaller;
  ticket: Pick<Ticket, "id" | "taskId" | "kind" | "status" | "questions" | "asks"> | null;
  ticketTask: Pick<Task, "id" | "projectId"> | null;
  /** 1-based question numbers; none means the whole ticket. */
  questions?: readonly number[];
  reason: string;
}): string | WithdrawPlan {
  if (caller === null) return "Only Patches and task threads withdraw tickets.";
  if (ticket === null) return "No such ticket.";
  if (ticket.status !== "open") return `${ticket.id} is already closed.`;
  if (caller.kind === "task") {
    if (ticket.taskId !== caller.taskId) return `${ticket.id} belongs to ${ticket.taskId}; you can withdraw only your own task's tickets.`;
    if (ticket.kind !== "questions") return `${ticket.id} is a review hand-off: only Patches withdraws it.`;
  } else if (ticketTask === null || ticketTask.projectId !== caller.projectId) {
    return `${ticket.id} is not in this chat's project: ask in its own Patches chat.`;
  }
  if (reason.trim().length < WITHDRAW_REASON_MIN) {
    return `Give the reason (at least ${WITHDRAW_REASON_MIN} characters): it goes in the dossier.`;
  }
  if (questions === undefined || questions.length === 0) return { kind: "ticket" };
  if (ticket.kind !== "questions") return `${ticket.id} is a review hand-off: withdraw it whole, without questions.`;
  const total = ticket.questions.length;
  for (const n of questions) {
    if (!Number.isInteger(n) || n < 1 || n > total) return `${ticket.id} has questions 1-${total}; there is no question ${n}.`;
  }
  if (new Set(questions).size !== questions.length) return "Name each question once.";
  if (questions.length === total) return { kind: "ticket" };
  const removed = [...questions].sort((a, b) => a - b);
  const keep = (_: unknown, index: number) => !removed.includes(index + 1);
  return {
    kind: "questions",
    remaining: ticket.questions.filter(keep),
    // Old tickets have no structured asks: nothing to keep in step.
    remainingAsks: ticket.asks.length === total ? ticket.asks.filter(keep) : [],
    removed,
  };
}

/** Which part of a ticket went: "question 2", "questions 1, 3" or "the whole ticket". */
export function withdrawnWhat(plan: WithdrawPlan): string {
  if (plan.kind === "ticket") return "the whole ticket";
  return `question${plan.removed.length === 1 ? "" : "s"} ${plan.removed.join(", ")}`;
}

/** Told to a task's thread when Patches withdraws its ticket. */
export function withdrawnByPatchesMessage(ticketId: string, plan: WithdrawPlan, reason: string): string {
  return `[The Orchestrator] Patches withdrew ${ticketId} (${withdrawnWhat(plan)}): ${reason.trim()}`;
}
