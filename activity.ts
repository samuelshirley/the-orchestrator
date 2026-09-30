// The Live box: what a task's agents are doing, as terminal lines. A thread's
// raw item events become one line per item (a command with the tail of its
// output, a file read or edit, a tool call, a message), secrets masked before
// anything leaves the server, and the panes are the task's working threads.
// Looked at only: nothing here sends, stops or changes a thread. Pure;
// activity.test.ts pins it.

/** Lines a pane keeps, newest last. */
export const MAX_LINES = 60;
/** A command's output: its last lines, and at most this many characters of them. */
export const OUTPUT_TAIL_LINES = 40;
export const OUTPUT_TAIL_CHARS = 4000;
export const COMMAND_CHARS = 2000;
export const MESSAGE_CHARS = 300;
export const MAX_PANES = 6;

/** The item events a pane is built from; text and reasoning deltas are never read. */
export const ACTIVITY_EVENT_TYPES = ["item/started", "item/completed", "item/backgroundTask/completed"] as const;
/** Newest rows read per pane: two per item. 100 is the most bb gives in one read. */
export const ACTIVITY_EVENT_ROWS = 100;

/** How often the box asks while something works, and while nothing does. */
export const ACTIVITY_POLL_MS = 2_000;
export const ACTIVITY_IDLE_POLL_MS = 10_000;

export function activityPollMs(working: number): number {
  return working > 0 ? ACTIVITY_POLL_MS : ACTIVITY_IDLE_POLL_MS;
}

export const NOTHING_RUNNING = "Nothing running. The last activity stays here.";

export interface ActivityEvent {
  seq: number;
  type: string;
  createdAt: number;
  data?: unknown;
}

export interface ActivityLine {
  /** The item's id: one line per item. */
  id: string;
  at: number;
  kind: "command" | "read" | "edit" | "tool" | "message" | "other";
  text: string;
  /** A completed command's output tail; null for everything else. */
  output: string | null;
  running: boolean;
}

// ------------------------------------------------------------------ secrets

const MASK = "•••";
const SECRET_KEY = /\b(\w*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|DATABASE_URL|AUTH)\w*=)(?!=)("[^"\n]*"|'[^'\n]*'|[^\s"']+)/gi;
const BEARER = /\b(Bearer\s+)[\w.~+/=-]{8,}/gi;
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi;
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const KNOWN_TOKEN = /\b(?:sk-|ghp_|gho_|github_pat_|xox[bap]-)[\w-]{10,}|\bAKIA[A-Z0-9]{12,}/g;

/** Mask obvious secrets: `KEY=value` for secret-looking keys, Bearer tokens, URL passwords, known token prefixes. */
export function redact(text: string): string {
  return text
    .replace(PRIVATE_KEY_BLOCK, MASK)
    .replace(SECRET_KEY, `$1${MASK}`)
    .replace(BEARER, `$1${MASK}`)
    .replace(URL_PASSWORD, `$1${MASK}@`)
    .replace(KNOWN_TOKEN, MASK);
}

// -------------------------------------------------------------------- lines

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The end of a command's output: at most OUTPUT_TAIL_LINES lines and OUTPUT_TAIL_CHARS characters, saying what was cut. */
export function outputTail(output: string): string {
  const all = output.replace(ANSI, "").replace(/\s+$/, "").split("\n");
  // Whole lines are cut before masking and single lines after it, so a cut never splits a secret.
  let kept = all.slice(-OUTPUT_TAIL_LINES).map(redact);
  while (kept.length > 1 && kept.join("\n").length > OUTPUT_TAIL_CHARS) kept = kept.slice(1);
  if (kept[0].length > OUTPUT_TAIL_CHARS) kept = [`…${kept[0].slice(-OUTPUT_TAIL_CHARS)}`];
  const cut = all.length - kept.length;
  const body = kept.join("\n");
  return cut > 0 ? `… ${cut} earlier line${cut === 1 ? "" : "s"}\n${body}` : body;
}

/** A path relative to the worktree or repo when it is inside it, else as it is. */
export function relativePath(path: string, root: string | null): string {
  if (root === null || root === "") return path;
  const base = root.replace(/\/+$/, "");
  if (path === base) return ".";
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

type Item = Record<string, unknown>;

const text = (value: unknown): string => (typeof value === "string" ? value : "");

function itemOf(event: ActivityEvent): Item | null {
  const data = event.data;
  if (typeof data !== "object" || data === null) return null;
  const item = (data as { item?: unknown }).item;
  if (typeof item !== "object" || item === null) return null;
  return typeof (item as Item).id === "string" ? (item as Item) : null;
}

function presentationOf(item: Item): { label: string; title: string; suppress: boolean } {
  const raw = item.presentation;
  if (typeof raw !== "object" || raw === null) return { label: "", title: "", suppress: false };
  const { label, title, suppress } = raw as Item;
  // A label is one string, or one per status.
  const byStatus = typeof label === "object" && label !== null ? (label as Item) : null;
  const named = byStatus === null ? text(label) : text(byStatus[item.status === "completed" ? "completed" : "pending"]);
  return { label: named, title: text(title), suppress: suppress === true };
}

/** A tool's own name, without the server it came through. */
function toolName(tool: string): string {
  return tool.replace(/^mcp__.*?__/, "");
}

const CHANGE_VERB: Record<string, string> = { add: "write", create: "write", delete: "delete" };

function changeLines(item: Item, root: string | null): string[] {
  if (!Array.isArray(item.changes)) return [];
  return item.changes.flatMap((change: unknown) => {
    if (typeof change !== "object" || change === null) return [];
    const { path, kind } = change as Item;
    if (typeof path !== "string" || path === "") return [];
    return [`${CHANGE_VERB[text(kind)] ?? "edit"} ${relativePath(path, root)}`];
  });
}

type Shown = Pick<ActivityLine, "kind" | "text" | "output">;

/** What one item shows; null for what is left out (reasoning, suppressed items, a message with no text yet). */
function shown(item: Item, completed: boolean, root: string | null): Shown | null {
  const presentation = presentationOf(item);
  if (presentation.suppress || item.type === "reasoning") return null;
  const fallback = (kind: ActivityLine["kind"]): Shown => ({
    kind,
    text: [presentation.label, presentation.title].filter((part) => part !== "").join(" ") || text(item.type) || "activity",
    output: null,
  });
  switch (item.type) {
    case "commandExecution": {
      if (typeof item.command !== "string") return fallback("command");
      let output: string | null = null;
      if (completed) {
        const failed = typeof item.exitCode === "number" && item.exitCode !== 0 ? `exit ${item.exitCode}` : "";
        const tail = outputTail(text(item.aggregatedOutput));
        output = [tail, failed].filter((part) => part !== "").join("\n") || null;
      }
      return { kind: "command", text: `$ ${cap(redact(item.command), COMMAND_CHARS)}`, output };
    }
    case "fileRead":
      return typeof item.path === "string" ? { kind: "read", text: `read ${relativePath(item.path, root)}`, output: null } : fallback("read");
    case "fileChange": {
      const lines = changeLines(item, root);
      return lines.length > 0 ? { kind: "edit", text: lines.join("\n"), output: null } : fallback("edit");
    }
    case "toolCall": {
      const name = toolName(text(item.tool));
      return name === "" ? fallback("tool") : { kind: "tool", text: [name, presentation.title].filter((part) => part !== "").join(" "), output: null };
    }
    case "agentMessage": {
      const said = text(item.text).trim();
      return said === "" ? null : { kind: "message", text: cap(said, MESSAGE_CHARS), output: null };
    }
    default:
      return fallback("other");
  }
}

/**
 * A thread's raw events (any order) as its lines: one per item, a later event
 * superseding the item's earlier one, in the order the items started, the
 * newest MAX_LINES. Nothing is running in a thread that is not working.
 */
export function activityLines(
  events: readonly ActivityEvent[],
  { root, working = true }: { root: string | null; working?: boolean },
): ActivityLine[] {
  const items = new Map<string, { first: number; last: ActivityEvent; item: Item }>();
  for (const event of events) {
    if (!(ACTIVITY_EVENT_TYPES as readonly string[]).includes(event.type)) continue;
    const item = itemOf(event);
    if (item === null) continue;
    const id = item.id as string;
    const seen = items.get(id);
    if (seen === undefined) items.set(id, { first: event.seq, last: event, item });
    else if (event.seq > seen.last.seq) items.set(id, { first: Math.min(seen.first, event.seq), last: event, item });
    else seen.first = Math.min(seen.first, event.seq);
  }
  const lines: ActivityLine[] = [];
  for (const [id, { last, item }] of [...items].sort((a, b) => a[1].first - b[1].first)) {
    const completed = last.type !== "item/started";
    const line = shown(item, completed, root);
    if (line === null) continue;
    lines.push({ id, at: last.createdAt, ...line, text: redact(line.text), running: working && !completed });
  }
  return lines.slice(-MAX_LINES);
}

/** The one line of a pane whose thread could not be read. */
export function unreadableLine(now: number): ActivityLine {
  return { id: "unreadable", at: now, kind: "other", text: "This thread's activity could not be read.", output: null, running: false };
}

// -------------------------------------------------------------------- panes

/**
 * The panes: every working thread of the task, in its Threads order, at most
 * MAX_PANES; with none working, the one most recently active, so finished
 * work can still be looked over.
 */
export function whichThreads<T extends { working: boolean; lastActiveAt: number | null }>(threads: readonly T[]): T[] {
  const working = threads.filter((thread) => thread.working);
  if (working.length > 0) return working.slice(0, MAX_PANES);
  let latest: T | null = null;
  for (const thread of threads) {
    if (latest === null || (thread.lastActiveAt ?? -1) > (latest.lastActiveAt ?? -1)) latest = thread;
  }
  return latest === null ? [] : [latest];
}
