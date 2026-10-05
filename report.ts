// Review reports: a task started for a check, report or investigation leaves
// its full findings in a markdown file under bb's thread storage, submits it
// (submit_report), and the owner reviews it from Needs you. The open report
// ticket holds every automatic close like an open questions ticket
// (tickets.ts); Mark reviewed closes the task. On 4 Oct the Jev/Headroom check
// gave its findings only in Patches' chat, was closed and archived, and left
// nothing to review.
//
// Where a report may live, and what the board may read: an absolute path to
// an existing, non-empty `.md` file under `<thread-storage root>/<taskId>/`,
// no `..`, its real path (symlinks resolved) still under the real task dir,
// at most REPORT_MAX_BYTES. The host gathers the facts (realpath, stat) and
// these functions decide, for submit_report and the board's read alike.
// Pure; report.test.ts pins it.
import { owner } from "./owner";

/** The biggest report file submit_report accepts and the board reads. */
export const REPORT_MAX_BYTES = 2 * 1024 * 1024;

/** The longest report title. */
export const REPORT_TITLE_MAX = 120;

/** The summary is 1–3 lines. */
export const REPORT_SUMMARY_MAX_LINES = 3;

/** The longest summary, all lines together. */
export const REPORT_SUMMARY_MAX = 600;

/** The file a task writes its findings to, by convention. */
export const REPORT_FILE = "report.md";

/** A task id as the dossier makes them (store.ts randomId): nothing that can walk a path. */
const TASK_ID = /^task_[a-z0-9]{1,40}$/;

/**
 * bb's thread-storage root: under bb's configured data dir when the plugin can
 * read one, else ~/.bb/thread-storage.
 */
export function threadStorageRoot(home: string, dataDir: string | null = null): string {
  const base = dataDir !== null && dataDir.trim() !== "" ? trimSlash(dataDir.trim()) : `${trimSlash(home)}/.bb`;
  return `${base}/thread-storage`;
}

/**
 * bb's data dir from a thread's own BB_THREAD_STORAGE (`<data dir>/thread-storage/<threadId>`),
 * or null when it does not have that shape.
 */
export function dataDirFromThreadStorage(value: string | undefined): string | null {
  if (value === undefined) return null;
  const match = /^(\/.+)\/thread-storage\/[^/]+\/?$/.exec(value.trim());
  return match === null ? null : match[1]!;
}

const trimSlash = (value: string) => (value.length > 1 ? value.replace(/\/+$/, "") : value);

/** The directory a task's report must sit in. */
export function reportDir(root: string, taskId: string): string {
  return `${trimSlash(root)}/${taskId}`;
}

/** Where the task writes its report: `<root>/<taskId>/report.md`. */
export function reportPathFor(root: string, taskId: string): string {
  return `${reportDir(root, taskId)}/${REPORT_FILE}`;
}

/** Why the path as given is refused before touching the disk, or null. */
export function reportPathRefusal({ path, taskId, root }: { path: string; taskId: string; root: string }): string | null {
  if (!TASK_ID.test(taskId)) return `${taskId} is not a task id.`;
  if (path.includes("\0")) return "The path has a NUL byte.";
  if (!path.startsWith("/")) return `Give an absolute path, under ${reportDir(root, taskId)}/.`;
  if (path.split("/").some((part) => part === ".." || part === ".")) return "The path may not contain . or .. segments.";
  if (!/\.md$/.test(path)) return "The report must be a .md file.";
  if (!within(path, reportDir(root, taskId))) return `The report must be under ${reportDir(root, taskId)}/.`;
  return null;
}

/** What the host found on disk for a path that passed reportPathRefusal. */
export type ReportFacts =
  | { exists: false }
  | {
      exists: true;
      /** realpath of the file. */
      realPath: string;
      /** realpath of the thread-storage root. */
      realRoot: string;
      isFile: boolean;
      size: number;
    };

/** Why the file is refused once its facts are known, or null when it is a report. */
export function reportFactsRefusal({ taskId, facts }: { taskId: string; facts: ReportFacts }): string | null {
  if (!facts.exists) return "There is no file at that path: write the report first.";
  // The task dir itself as a symlink, or the file as one, resolves elsewhere.
  if (!within(facts.realPath, reportDir(facts.realRoot, taskId))) {
    return "The path resolves outside this task's thread-storage folder (a symlink): write the report there itself.";
  }
  if (!/\.md$/.test(facts.realPath)) return "The path resolves to a file that is not .md.";
  if (!facts.isFile) return "That is not a regular file.";
  if (facts.size <= 0) return "The report is empty.";
  if (facts.size > REPORT_MAX_BYTES) return `The report is ${facts.size} bytes; the limit is ${REPORT_MAX_BYTES} (2 MB).`;
  return null;
}

/** `path` is strictly inside `dir` (never `dir` itself, never a sibling sharing its prefix). */
function within(path: string, dir: string): boolean {
  const prefix = `${trimSlash(dir)}/`;
  return path.startsWith(prefix) && path.length > prefix.length;
}

/** Why the title is refused, or null. */
export function reportTitleRefusal(title: string): string | null {
  const trimmed = title.trim();
  if (trimmed === "") return "Give the report a title.";
  if (trimmed.length > REPORT_TITLE_MAX) return `The title is ${trimmed.length} characters; at most ${REPORT_TITLE_MAX}.`;
  if (/[\r\n]/.test(trimmed)) return "The title is one line.";
  return null;
}

/** The summary as stored: its non-empty lines trimmed, or why it is refused. */
export function reportSummary(summary: string | undefined | null): { ok: true; summary: string | null } | { ok: false; reason: string } {
  if (summary === undefined || summary === null) return { ok: true, summary: null };
  const lines = summary
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return { ok: true, summary: null };
  if (lines.length > REPORT_SUMMARY_MAX_LINES) {
    return { ok: false, reason: `The summary is ${lines.length} lines; at most ${REPORT_SUMMARY_MAX_LINES}.` };
  }
  const joined = lines.join("\n");
  if (joined.length > REPORT_SUMMARY_MAX) return { ok: false, reason: `The summary is ${joined.length} characters; at most ${REPORT_SUMMARY_MAX}.` };
  return { ok: true, summary: joined };
}

/** What a report ticket stores. */
export interface ReportRef {
  path: string;
  title: string;
  summary: string | null;
}

/** The task's last line once it has submitted. */
export function reportDoneLine(): string {
  return `Done: report submitted, waiting on ${owner()} to review`;
}

/** submit_report's reply to the task. */
export function reportSubmittedReply(ticketId: string, replaced: boolean): string {
  return `${replaced ? "Updated" : "Opened"} report ticket ${ticketId}: ${owner()} sees "Review report" in Needs you. The task stays open until they mark it reviewed. End your turn with: ${reportDoneLine()}`;
}

/** Told to the task's Patches chat when a report is submitted. */
export function reportToldMessage(task: { id: string; title: string }, report: ReportRef, replaced: boolean): string {
  return `[The Orchestrator] ${task.id} ("${task.title}") ${replaced ? "updated its" : "submitted a"} report for ${owner()}: "${report.title}".${report.summary !== null ? `\n${report.summary}` : ""}\nFile: ${report.path}\nIt is in ${owner()}'s Needs you as "Review report: ${report.title}". Relay a short summary and point to that item; do not paste the report.`;
}

/** The Needs you item's title. */
export function reportItemTitle(title: string): string {
  return `Review report: ${title}`;
}

/** The board's status for a task whose report waits on the owner. */
export function reportStatusLabel(): string {
  return `Report ready · waiting on ${owner()}`;
}

/** The close note when the owner marks a report reviewed; completionOf reads it as Done. */
export function reportReviewedNote(): string {
  return `Done: Report reviewed by ${owner()}`;
}

/** Told to the task thread when the owner marks its report reviewed. */
export function reportReviewedMessage(taskId: string): string {
  return `[The Orchestrator] ${owner()} marked your report reviewed; ${taskId} is closed. Nothing more to do.`;
}

/** The owner's Follow up, sent to the task thread; the ticket stays open. */
export function reportFollowUpMessage(ticketId: string, note: string): string {
  return `${owner()} read your report (ticket ${ticketId}) and follows up:\n\n${note.trim()}\n\nThe report ticket stays open. Do what they ask; if the findings change, update the report file and call submit_report again (it replaces the one on the ticket).`;
}

/** The longest Follow up note. */
export const REPORT_FOLLOW_UP_MAX = 4000;

/** Why a Follow up note is refused, or null. */
export function followUpRefusal(note: string): string | null {
  if (note.trim() === "") return "Write what you want the task to do.";
  if (note.length > REPORT_FOLLOW_UP_MAX) return `At most ${REPORT_FOLLOW_UP_MAX} characters.`;
  return null;
}
