// Claude usage against the subscription windows, and coming back after a
// limit. Pure; usage.test.ts pins it. server.ts reads usage on the liveness
// beat and acts on what this decides.
//
// Where the facts come from (checked on the host, not guessed):
// - Usage: provider-claude-code's `provider-usage.v1.getResource` RPC, one
//   resource per host: windows with usedPercent and resetsAt. `refresh: false`
//   returns the cached reading; `observedAt` says how old it is.
// - Resuming: bb's provider-retry plugin. On a turn that failed on a
//   subscription-window limit with a reset time it queues a retry row
//   (payload.kind "retry", reason "Rate limited") for 15-45 s after the reset;
//   the thread sits in `error` until then. It declines when the reset is past
//   its "Maximum automatic wait" (6 hours by default, so a weekly limit gets
//   none) and after 5 attempts. Those are the gaps The Orchestrator fills: it
//   records every limit hit of its own agents and, after the reset, re-queues
//   one that nothing brought back, once.

/** At or above this share of a window: warn, and start no new builds or research. */
export const USAGE_WARN_PERCENT = 90;
/** Ask for a fresh reading (refresh: true) when the cached one is older than this, at most this often. */
export const USAGE_REFRESH_MS = 5 * 60_000;
/** After a reset, how long provider-retry (15-45 s) and a dispatch hold get before a hit counts as not resumed. */
export const RESUME_GRACE_MS = 3 * 60_000;
/** A hit with no known reset is looked at again after this long (the session window's length). */
export const UNKNOWN_RESET_MS = 5 * 60 * 60_000;

export const CLAUDE_USAGE_PLUGIN = "provider-claude-code";
export const USAGE_LIST_METHOD = "provider-usage.v1.listResources";
export const USAGE_GET_METHOD = "provider-usage.v1.getResource";

export interface UsageWindow {
  label: string;
  usedPercent: number;
  /** Epoch ms; null when the provider gave none. */
  resetsAt: number | null;
}

export interface UsageReading {
  windows: UsageWindow[];
  /** When the provider last measured it; null when never. */
  observedAt: number | null;
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * The windows that limit every agent, from a getResource answer; null when it
 * has no usable reading (not signed in, an error). A model-scoped window
 * ("Fable") limits only that model, which no agent here runs on.
 */
export function parseUsage(raw: unknown): UsageReading | null {
  const answer = record(raw);
  const usage = record(answer?.usage);
  if (usage === null || usage.status !== "ok" || !Array.isArray(usage.windows)) return null;
  const windows: UsageWindow[] = [];
  for (const entry of usage.windows) {
    const window = record(entry);
    if (window === null || typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) continue;
    if (typeof window.model === "string" && window.model !== "") continue;
    const parsed = typeof window.resetsAt === "string" ? Date.parse(window.resetsAt) : NaN;
    windows.push({
      label: typeof window.label === "string" && window.label !== "" ? window.label : "Usage",
      usedPercent: window.usedPercent,
      resetsAt: Number.isNaN(parsed) ? null : parsed,
    });
  }
  if (windows.length === 0) return null;
  return { windows, observedAt: typeof answer?.observedAt === "number" ? answer.observedAt : null };
}

/** Whether to ask the provider for a fresh reading rather than take the cached one. */
export function wantsRefresh(args: { observedAt: number | null; lastRefreshAt: number | null; now: number }): boolean {
  const { observedAt, lastRefreshAt, now } = args;
  if (lastRefreshAt !== null && now - lastRefreshAt < USAGE_REFRESH_MS) return false;
  return observedAt === null || now - observedAt >= USAGE_REFRESH_MS;
}

export type UsageLevel = "ok" | "near" | "limit";

export interface UsageView {
  level: UsageLevel;
  /** The fullest window's share, 0-100 (rounded). */
  percent: number;
  /** Its label ("Current session", "Weekly limit"). */
  label: string;
  /** When it resets, epoch ms; null when unknown. */
  resetsAt: number | null;
  observedAt: number | null;
}

/**
 * The fullest window now. A window whose reset has passed counts as empty:
 * the limit lifts at the reset even before the next reading says so.
 */
export function usageView(reading: UsageReading | null, now: number): UsageView | null {
  if (reading === null) return null;
  let top: { window: UsageWindow; used: number } | null = null;
  for (const window of reading.windows) {
    const used = window.resetsAt !== null && window.resetsAt <= now ? 0 : window.usedPercent;
    if (top === null || used > top.used || (used === top.used && (window.resetsAt ?? Infinity) > (top.window.resetsAt ?? Infinity))) {
      top = { window, used };
    }
  }
  if (top === null) return null;
  const level: UsageLevel = top.used >= 100 ? "limit" : top.used >= USAGE_WARN_PERCENT ? "near" : "ok";
  return {
    level,
    percent: Math.round(top.used),
    label: top.window.label,
    resetsAt: top.used === 0 && top.window.resetsAt !== null && top.window.resetsAt <= now ? null : top.window.resetsAt,
    observedAt: reading.observedAt,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "18:00" within the day, "Mon 07:00" further out; local time. */
export function clock(at: number, now: number): string {
  const date = new Date(at);
  const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return at - now < 20 * 60 * 60_000 ? hhmm : `${DAYS[date.getDay()]} ${hhmm}`;
}

/** The board header's words. */
export function usageLabel(view: UsageView, now: number): string {
  const when = view.resetsAt === null ? null : clock(view.resetsAt, now);
  if (view.level === "limit") return when === null ? "Usage limit reached" : `Usage limit reached · agents resume ${when}`;
  const base = `Usage ${view.percent}%`;
  return when === null ? base : `${base} · resets ${when}`;
}

/** The warning under the header near or at the limit; null below the threshold. */
export function usageWarning(view: UsageView | null, now: number): string | null {
  if (view === null || view.level === "ok") return null;
  const until = view.resetsAt === null ? "until it resets" : `until ${clock(view.resetsAt, now)}`;
  if (view.level === "limit") {
    return `${view.label} limit reached: every agent that was mid-turn resumes after the reset (${until.replace(/^until /, "")}). New builds and research wait ${until}.`;
  }
  return `${view.label} at ${view.percent}%: new builds and research wait ${until}, so the window isn't spent on work the limit would cut off. Work in flight carries on.`;
}

/** task_status's line for Patches and the tasks. */
export function usageStatusLine(view: UsageView | null, now: number): string {
  if (view === null) return "Claude usage: not read yet.";
  const line = `Claude usage: ${usageLabel(view, now)} (${view.label})`;
  const warning = usageWarning(view, now);
  return warning === null ? line : `${line}. ${warning}`;
}

export type StartKind = "build" | "research";

/**
 * Why a new build or research must not start now; null when it may. Work
 * already running is never touched: this only gates starts.
 */
export function startRefusal(view: UsageView | null, kind: StartKind, now: number): string | null {
  if (view === null || view.level === "ok") return null;
  const what = kind === "build" ? "No new build" : "No new research";
  const until = view.resetsAt === null ? "until the window resets" : `until ${clock(view.resetsAt, now)}`;
  return `${what}: Claude usage is at ${view.percent}% of the ${view.label} window (the pause starts at ${USAGE_WARN_PERCENT}%), so new work waits ${until} rather than be cut off by the limit. Work in flight carries on. You will be told when the window resets; end your pass saying what waits.`;
}

/** A start refused for usage, woken once the window has room again. */
export interface PausedStart {
  taskId: string;
  threadId: string;
  kind: StartKind;
  at: number;
}

/** Add a refused start; one per task and kind. */
export function addPaused(paused: readonly PausedStart[], next: PausedStart): PausedStart[] {
  return [...paused.filter((entry) => !(entry.taskId === next.taskId && entry.kind === next.kind)), next];
}

/** Whether the paused starts may be woken: the window has room again. */
export function mayWake(view: UsageView | null): boolean {
  return view !== null && view.level === "ok";
}

/** What a paused task hears when the window has room again. */
export function wakeMessage(entries: readonly PausedStart[], view: UsageView): string {
  const kinds = [...new Set(entries.map((entry) => entry.kind))].join(" and ");
  return `[The Orchestrator] ${entries[0]?.taskId ?? "task"}: Claude usage is back to ${view.percent}% of the ${view.label} window. The ${kinds} that was paused for usage may start now: carry on with it.`;
}

// ------------------------------------------------------------ limit hits

export type HitRole = "task" | "research" | "build" | "chat";

/** One of our agents whose turn failed on a usage limit. Kept in the dossier until it is back. */
export interface LimitHit {
  threadId: string;
  role: HitRole;
  taskId: string | null;
  /** The failed turn's request id: what threads.retry takes. */
  requestId: string;
  /** When the blocking window resets, epoch ms; null when the provider did not say. */
  resetsAt: number | null;
  since: number;
  /** When The Orchestrator re-queued it itself; null until then. At most once. */
  requeuedAt: number | null;
}

/** The part of bb's turn.failed event this reads. */
export interface TurnFailure {
  errorInfo: { category?: string | null } | null;
  rateLimits: {
    kind: string;
    status: string;
    windows: readonly { status: string; resetsAtMs: number | null }[];
  } | null;
}

/**
 * Whether a failed turn hit a usage limit, and when it lifts. The reset is
 * provider-retry's: the latest reset among the blocked windows, else among all.
 * Credits and spend controls do not reset on a clock: not a hit.
 */
export function limitHitOf(failure: TurnFailure): { resetsAt: number | null } | null {
  if (failure.errorInfo?.category !== "rate-limit") return null;
  const limits = failure.rateLimits;
  if (limits !== null && limits.kind !== "subscription-window" && limits.kind !== "unknown") return null;
  if (limits === null) return { resetsAt: null };
  const blocked = limits.windows.filter((window) => window.status === "blocked");
  const resets = (blocked.length > 0 ? blocked : limits.windows).flatMap((window) => (window.resetsAtMs === null ? [] : [window.resetsAtMs]));
  return { resetsAt: resets.length === 0 ? null : Math.max(...resets) };
}

/** Record a hit; a thread hit again keeps its first `since` and its one re-queue. */
export function recordHit(hits: readonly LimitHit[], hit: Omit<LimitHit, "since" | "requeuedAt">, now: number): LimitHit[] {
  const previous = hits.find((entry) => entry.threadId === hit.threadId);
  const next: LimitHit = { ...hit, since: previous?.since ?? now, requeuedAt: previous?.requeuedAt ?? null };
  return [...hits.filter((entry) => entry.threadId !== hit.threadId), next];
}

/** When a hit is due to be back: its reset, else the usage reading's, else a session window after it. */
export function hitDueAt(hit: LimitHit, fallbackResetAt: number | null): number {
  return (hit.resetsAt ?? fallbackResetAt ?? hit.since + UNKNOWN_RESET_MS) + RESUME_GRACE_MS;
}

export type ResumeStep =
  /** Not yet: before the reset, or a retry is queued (maybe held by the memory guard). */
  | { kind: "wait" }
  /** It ran again (or is gone): forget the hit. */
  | { kind: "resumed" }
  /** Past the reset, nothing queued, still failed: re-queue its turn, once. */
  | { kind: "requeue" }
  /** The one re-queue did not bring it back either: its task is told (a builder's build fails). */
  | { kind: "give-up" };

/**
 * One hit's next step. `status` is the thread's host status now; `retryQueued`
 * whether bb holds a retry row for it (provider-retry's or ours). Never
 * re-queues while a row exists, and never twice: no duplicate turns.
 */
export function resumeStep(args: {
  hit: LimitHit;
  status: "starting" | "active" | "stopping" | "pending" | "idle" | "error" | "gone";
  retryQueued: boolean;
  fallbackResetAt: number | null;
  now: number;
}): ResumeStep {
  const { hit, status, retryQueued, now } = args;
  if (status === "gone") return { kind: "resumed" };
  if (retryQueued || status === "pending") return { kind: "wait" };
  if (status !== "error") return { kind: "resumed" };
  if (now < hitDueAt(hit, args.fallbackResetAt)) return { kind: "wait" };
  if (hit.requeuedAt === null) return { kind: "requeue" };
  return now - hit.requeuedAt < RESUME_GRACE_MS ? { kind: "wait" } : { kind: "give-up" };
}

/** What the task hears when one of its agents did not come back after the limit. */
export function notResumedMessage(hit: LimitHit, why: string): string {
  const who = hit.role === "research" ? "Research" : hit.role === "build" ? "The builder" : "The agent";
  return `[The Orchestrator] ${hit.taskId ?? "task"}: ${who} ${hit.threadId} stopped at the usage limit and did not resume after the reset (${why}). It is yours to fix: read its last output, then run it again or carry on without it.`;
}

/** Why Restart must not run: a retry is already queued, and a second would duplicate the turn. */
export function restartRefusal(queuedRetryAt: number | null | undefined, now: number): string | null {
  if (queuedRetryAt === undefined) return null;
  const when = queuedRetryAt === null ? "" : ` for ${clock(queuedRetryAt, now)}`;
  return `Its turn is already queued to retry${when}, after the usage limit resets. Restart would run it twice; it comes back on its own.`;
}
