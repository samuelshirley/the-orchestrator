// What happened to each agent Jev routed (modelroute.ts), so a cutoff that is
// too low shows on the board within days: agents Jev lowered (Sonnet, Haiku,
// a lower effort) against agents on the default.
//
// Derived from the dossier where it already is (children's reports, the
// owner's question tickets, later builds); only what is otherwise lost is
// kept on the route row: each failure counted on the build that failed and
// on its task (build_failures; a task's own count resets per build), and how
// the task closed (task_fate). Pure: server.ts reads and writes.
import { ROUTE_WINDOW_MS, lowered } from "./modelroute";

/** How a task closed: landed on main or a merged PR, closed done (a finding, a report), or given up. */
export type TaskFate = "landed" | "done" | "abandoned";
export const TASK_FATES: readonly TaskFate[] = ["landed", "done", "abandoned"];

/** What a routed agent came to; "open" has no outcome yet and is not compared. */
export type OutcomeKind = "landed" | "ok" | "failed" | "abandoned" | "errored" | "open";

export interface RouteOutcome {
  kind: OutcomeKind;
  /** Build failures on this agent: a build's own, a task's every one. */
  buildFailures: number;
  /** Questions the task asked the owner (task agents only). */
  questions: number;
}

/** A child thread's summary when it stopped with an error (server.ts threadFailed writes it). */
export const ERROR_SUMMARY_PREFIX = "Stopped with an error:";

/** The fate of a task closed because its PR or branch is done (release.ts staleReason). */
export function staleFate(reason: string): TaskFate {
  return /^PR #\d+ closed\.$/.test(reason) ? "abandoned" : "landed";
}

/** One agent's outcome from its facts. */
export function routeOutcome(input: {
  role: string;
  buildFailures: number;
  taskFate: TaskFate | null;
  /** The research or build thread's last report; null while it has none. */
  summary: string | null;
  /** A build: a later build of the same task started. */
  superseded: boolean;
  questions: number;
}): RouteOutcome {
  const failures = Math.max(0, input.buildFailures);
  const fateKind = (fate: TaskFate): OutcomeKind => (fate === "done" ? "ok" : fate);
  if (input.role === "task") {
    return { kind: input.taskFate === null ? "open" : fateKind(input.taskFate), buildFailures: failures, questions: input.questions };
  }
  if (input.role === "build") {
    const kind: OutcomeKind =
      failures > 0 ? "failed" : input.taskFate !== null ? fateKind(input.taskFate) : input.superseded ? "ok" : "open";
    return { kind, buildFailures: failures, questions: 0 };
  }
  if (input.role === "research") {
    const kind: OutcomeKind =
      input.summary === null
        ? input.taskFate === null
          ? "open"
          : "abandoned"
        : input.summary.startsWith(ERROR_SUMMARY_PREFIX)
          ? "errored"
          : "ok";
    return { kind, buildFailures: 0, questions: 0 };
  }
  return { kind: "open", buildFailures: 0, questions: 0 };
}

/** Every route's outcome, from the dossier's children and tickets. */
export function routeOutcomes(
  routes: readonly { threadId: string; taskId: string; role: string; buildFailures: number; taskFate: TaskFate | null }[],
  children: readonly { threadId: string; taskId: string; kind: string; summary: string | null; createdAt: number }[],
  tickets: readonly { taskId: string; kind: string; questions: readonly string[] }[],
): Map<string, RouteOutcome> {
  const childOf = new Map(children.map((child) => [child.threadId, child] as const));
  const questions = new Map<string, number>();
  for (const ticket of tickets) {
    if (ticket.kind === "questions") questions.set(ticket.taskId, (questions.get(ticket.taskId) ?? 0) + ticket.questions.length);
  }
  const out = new Map<string, RouteOutcome>();
  for (const route of routes) {
    const child = childOf.get(route.threadId) ?? null;
    const superseded =
      route.role === "build" &&
      child !== null &&
      children.some((other) => other.taskId === route.taskId && other.kind === "build" && other.createdAt > child.createdAt);
    out.set(
      route.threadId,
      routeOutcome({
        role: route.role,
        buildFailures: route.buildFailures,
        taskFate: route.taskFate,
        summary: child?.summary ?? null,
        superseded,
        questions: route.role === "task" ? (questions.get(route.taskId) ?? 0) : 0,
      }),
    );
  }
  return out;
}

/** Landed, or closed done, or research that answered. */
export function outcomeOk(kind: OutcomeKind): boolean {
  return kind === "landed" || kind === "ok";
}

/** Not on Jev's default at all: the owner's pick, Patches, another provider. */
const NOT_COMPARED: ReadonlySet<string> = new Set(["owner", "patches", "provider"]);

interface Group {
  agents: number;
  ok: number;
  buildFailures: number;
  questions: number;
  byRole: Map<string, { agents: number; ok: number }>;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function groupText(name: string, group: Group): string {
  return `${name}: ${plural(group.agents, "agent", "agents")}, ${group.ok} ok, ${plural(group.buildFailures, "build failure", "build failures")}, ${plural(group.questions, "question", "questions")}`;
}

function roleText(group: Group): string {
  const roles = [...group.byRole.entries()].map(([role, n]) => `${role} ${n.agents} (${n.ok} ok)`);
  return roles.length === 0 ? "none" : roles.join(", ");
}

/**
 * The board's comparison over the last 14 days: agents Jev lowered against
 * agents on the default, counting only agents with a finished outcome. Null
 * when none has finished.
 */
export function outcomeComparison(
  rows: readonly {
    routedAt: number;
    role: string;
    reason: string;
    model: string | null;
    effort: string | null;
    outcome: RouteOutcome | null;
  }[],
  now: number,
): { line: string; detail: string } | null {
  const empty = (): Group => ({ agents: 0, ok: 0, buildFailures: 0, questions: 0, byRole: new Map() });
  const groups = { lowered: empty(), default: empty() };
  for (const row of rows) {
    if (now - row.routedAt >= ROUTE_WINDOW_MS || NOT_COMPARED.has(row.reason)) continue;
    if (row.outcome === null || row.outcome.kind === "open") continue;
    const group = lowered(row) ? groups.lowered : groups.default;
    const ok = outcomeOk(row.outcome.kind) ? 1 : 0;
    group.agents += 1;
    group.ok += ok;
    group.buildFailures += row.outcome.buildFailures;
    group.questions += row.outcome.questions;
    const role = group.byRole.get(row.role) ?? { agents: 0, ok: 0 };
    group.byRole.set(row.role, { agents: role.agents + 1, ok: role.ok + ok });
  }
  if (groups.lowered.agents + groups.default.agents === 0) return null;
  return {
    line: `${groupText("Lowered", groups.lowered)} · ${groupText("Default", groups.default)}`,
    detail: [
      "Last 14 days, agents with a finished outcome only.",
      "Lowered: Jev put them on Sonnet or Haiku, or a lower effort. Default: no model or effort from Jev.",
      "ok: a task or build that landed or closed done, research that answered.",
      "Build failures count on the build that failed and on its task; questions are the task's to the owner.",
      `Lowered by role: ${roleText(groups.lowered)}. Default by role: ${roleText(groups.default)}.`,
    ].join(" "),
  };
}

/** The log line for one agent's outcome, next to its route. */
export function outcomeLogLine(
  route: { role: string; threadId: string; model: string | null; effort: string | null },
  outcome: RouteOutcome,
): string {
  const counts = route.role === "research" ? "" : `, ${plural(outcome.buildFailures, "build failure", "build failures")}`;
  const asks = route.role === "task" ? `, ${plural(outcome.questions, "question", "questions")}` : "";
  return `${route.role} ${route.threadId} on ${route.model ?? "the provider default"}, effort ${route.effort ?? "default"}: ${outcome.kind}${counts}${asks}`;
}
