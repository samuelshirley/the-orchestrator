// When a task with no commit and no PR is finished: a research or check task
// whose own report says done. An open report ticket (report.ts) is an open
// ticket: it closes when the owner marks it reviewed. Its word is the only evidence, so it closes
// only when the dossier agrees nothing of it is open (no PR, branch,
// worktree, build, claim, ticket or running thread) and its thread has sat
// idle for DONE_IDLE_MS since. A done report that still names work left (a
// `Left:` line, "open item", "after approval", "follow-up", …) is not closed:
// it goes to Patches once as a follow-up (followUpItem, followUpMessage).
// Leaving a task open beats closing it with work left, so detection leans to
// "work left". A task with steps left (steps.ts) is never closed on its word:
// it says so itself, so Patches gets no follow-up for it. Also: when a closed
// task's chats are archived.
// Pure; done.test.ts pins it.
import { owner } from "./owner";
import { openWork } from "./landed";
import type { Task } from "./store";

/** How long a task thread that said done must stay idle before it closes. */
export const DONE_IDLE_MS = 30 * 60_000;

/** How long after a task closes its chats are archived (when the setting is on). */
export const ARCHIVE_CLOSED_AFTER_MS = 10 * 60_000;

/** Meta key: when the task thread last went idle. */
export function idleKey(taskId: string): string {
  return `task_idle_at:${taskId}`;
}

/** Meta key: the closed task's threads are archived; never again. */
export function threadsArchivedKey(taskId: string): string {
  return `threads_archived:${taskId}`;
}

/** Meta key for "Archive chats of done tasks after 10 min": "on" or "off". */
export const ARCHIVE_CLOSED_KEY = "archive_closed_chats";

/** The setting is on unless the owner turned it off. */
export function archiveEnabled(value: string | null): boolean {
  return value !== "off";
}

/** The report's status line: its last non-empty line. */
export function statusLine(report: string | null): string | null {
  if (report === null) return null;
  return (
    report
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .pop() ?? null
  );
}

/**
 * The status line leads with done: "Status: Done. …", "**Status for Patches:**
 * task complete; …", "Done: …". A done that is not first ("Step 1 DONE"), a
 * "not done", or a done that still waits on someone is not done.
 */
export function reportSaysDone(report: string | null): boolean {
  const line = statusLine(report);
  if (line === null) return false;
  const rest = line
    .replace(/^[\s>#*_`-]*/, "")
    .replace(/^status(?:\s+for\s+patches)?\s*[*_]*\s*[:–—-]\s*/i, "")
    .replace(/^[\s*_`]*/, "");
  if (!/^(?:task\s+)?(?:done|complete)\b/i.test(rest)) return false;
  return !/\b(?:waiting|blocked|pending)\b/i.test(rest);
}

const NEGATED =
  /\b(?:no|nothing|none|zero|without)\b[^.;,:]{0,30}?\b(?:open items?|left(?: to do)?|remain(?:ing|s)?|follow[- ]?ups?|todos?|to-?do)\b/gi;

const REMAINING = [
  /\bopen items?\b/i,
  /\bstill (?:to do|needs|to be)\b/i,
  /\bleft to do\b/i,
  /\bafter (?:\S+\s+){0,3}(?:approv|merg|releas|review|launch|deploy|ship)\w*/i,
  /\bfollow[- ]?ups?\b/i,
  /\btodos?\b|\bto-do\b/i,
  /\bremain(?:ing|s)\b/i,
  /\bonce\b[^,]+,\s*(?:then\s+)?(?:unset|set|run|remove|revert|delete|turn|flip|switch|enable|re-enable|disable|update|rotate|merge|ship|release|submit|tell|ask|check|do)\b/i,
];

/** The value of a `Left:` line, or null when the line is not one. */
function leftValue(line: string): string | null {
  const match = /^[\s>#*_-]*left[*_]*\s*:[*_]*\s*(.*)$/i.exec(line);
  return match === null ? null : (match[1] ?? "").replace(/[*_`.\s]+$/, "").trim();
}

/**
 * The first line of a report that names work still to do (trimmed, bold
 * dropped, at most 300 chars), or null. Code fences are skipped; negations
 * ("nothing left", "no open items", "Left: none") do not count.
 */
export function followUpItem(report: string | null): string | null {
  if (report === null) return null;
  let fenced = false;
  for (const raw of report.split("\n")) {
    if (/^\s*```/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const line = raw.trim();
    if (line === "") continue;
    const left = leftValue(line);
    const found =
      left !== null
        ? left !== "" && !/^(?:none|nothing|n\/a|-)$/i.test(left)
        : REMAINING.some((pattern) => pattern.test(line.replace(NEGATED, "")));
    if (found) return line.replace(/\*\*/g, "").trim().slice(0, 300);
  }
  return null;
}

/** The follow-up of a report that says done, for the board; null otherwise. */
export function followUpOf(report: string | null): string | null {
  return reportSaysDone(report) ? followUpItem(report) : null;
}

/** doneBlocker's reason when the task would close but names work left. */
export const FOLLOW_UP_PREFIX = "follow-up: ";

/** The remaining item of a follow-up blocker, or null for any other reason. */
export function followUpOfBlocker(reason: string | null): string | null {
  return reason !== null && reason.startsWith(FOLLOW_UP_PREFIX) ? reason.slice(FOLLOW_UP_PREFIX.length) : null;
}

/** Meta key: the follow-up item Patches was last told about for this task. */
export function followUpToldKey(taskId: string): string {
  return `followup_told:${taskId}`;
}

/** Tell Patches once per item. */
export function followUpDue({ item, told }: { item: string | null; told: string | null }): boolean {
  return item !== null && told !== item;
}

/** To Patches: a task said done but names work left, so it stays open. */
export function followUpMessage(task: { id: string; title: string }, item: string): string {
  return `[The Orchestrator] ${task.id} ("${task.title}") reported done but names work left: "${item}". It stays open (not auto-closed). Start a follow-up task for it or ask ${owner()}, then close ${task.id} with release_task close: true.`;
}

/** To Patches: a task landed and closed, but its report names work left. */
export function landedFollowUpMessage(task: { id: string; title: string }, item: string): string {
  return `[The Orchestrator] ${task.id} ("${task.title}") landed on main and closed, but its report names work left: "${item}". Start a follow-up task for it or ask ${owner()}.`;
}

export interface DoneArgs {
  task: Pick<Task, "closedAt" | "stage" | "buildState" | "prNumber" | "branch" | "worktreePath">;
  /** The task thread's last full report. */
  report: string | null;
  /** The task's open tickets (questions, review or report): any one keeps it open. */
  openTickets: number;
  /** The task thread or one of its children is mid-turn or queued. */
  running: boolean;
  /** Paths the task still claims. */
  claims: number;
  /** When the task thread last went idle; null when unknown. */
  idleSince: number | null;
  now: number;
  /** Steps the task recorded as left at its last land (steps.ts stepsLeftCount). */
  stepsLeft: number;
}

/** Why the task stays open, or null when it closes as done. */
export function doneBlocker(args: DoneArgs): string | null {
  const { task } = args;
  if (task.closedAt !== null) return "already closed";
  if (task.stage !== "research") return `at stage ${task.stage}`;
  // Any buildState but "none" is open work here, and so are steps left: a
  // "Done:" report alone never closes a task between its steps.
  const open = openWork(args);
  if (open !== null) return open;
  if (task.prNumber !== null) return "has a PR";
  if (task.branch !== null) return "has a branch";
  if (task.worktreePath !== null) return "has a worktree";
  if (args.claims > 0) return "has claims";
  if (!reportSaysDone(args.report)) return "report does not say done";
  if (args.idleSince === null) return "idle time unknown";
  const idle = args.now - args.idleSince;
  if (idle < DONE_IDLE_MS) return `idle only ${Math.floor(Math.max(0, idle) / 60_000)} min`;
  const item = followUpItem(args.report);
  if (item !== null) return `${FOLLOW_UP_PREFIX}${item}`;
  return null;
}

/** The close note; completionOf (model.ts) reads it back as "Done". */
export function doneNote(report: string | null): string {
  const line = (statusLine(report) ?? "").replace(/\*\*/g, "").trim().slice(0, 200);
  return `Done: ${line} (idle 30 min with nothing open; closed by The Orchestrator)`;
}

/** Close the task (the note), or null while it is kept. */
export function doneClose(args: DoneArgs): string | null {
  return doneBlocker(args) === null ? doneNote(args.report) : null;
}

/** A closed task's chats are archived once, 10 min after it closed, if the owner wants that. */
export function archiveDue({
  closedAt,
  now,
  enabled,
  alreadyArchived,
}: {
  closedAt: number | null;
  now: number;
  enabled: boolean;
  alreadyArchived: boolean;
}): boolean {
  return enabled && !alreadyArchived && closedAt !== null && now - closedAt >= ARCHIVE_CLOSED_AFTER_MS;
}
