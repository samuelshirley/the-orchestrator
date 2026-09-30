// land() on a profile with afterLand builds, then starts a detached
// `bb plugin reload` that restarts this plugin. The task stays open until the
// reload is confirmed: land records a pending reload in the dossier's meta,
// the host's reload writes its exit code and output to files, and every
// instance (the old one until it dies, the new one once it starts) checks
// every RELOAD_CHECK_MS. Exit 0 seen by an instance started after the land
// closes the task (or keeps it open with its steps left, steps.ts, when the
// land named `more`) and keeps its dist/ as last-good; a non-zero exit, or
// nothing within RELOAD_TIMEOUT_MS, is a failed build of the task's
// (failBuildFor), with bb's own reason. bb keeps the old instance running
// when a reload fails, and that instance rolls dist/ back to last-good
// (recovery.ts), so a restart of bb still loads a working build.
// Pure; reload.test.ts pins it.

/** Meta key prefix of a pending reload, one row per task. */
export const RELOAD_PREFIX = "reload_pending:";

export function reloadKey(taskId: string): string {
  return `${RELOAD_PREFIX}${taskId}`;
}

/** How often every instance checks pending reloads. */
export const RELOAD_CHECK_MS = 2_000;

/** How long a reload may take before it counts as failed. */
export const RELOAD_TIMEOUT_MS = 3 * 60_000;

/** How much of the reload's output a failure keeps. */
const OUTPUT_TAIL = 1_500;

/** A land waiting for its reload, as stored under reloadKey(taskId). */
export interface PendingReload {
  taskId: string;
  /** The task's own thread, told once the reload is live. */
  threadId: string | null;
  projectId: string;
  /** main's head after the land. */
  sha: string;
  /** The branch it landed on. */
  target: string;
  summary: string;
  /** When the reload was started, ms. */
  startedAt: number;
  /** Steps left after this land (steps.ts): once live, the task stays open. Absent: it closes. */
  more?: string[];
}

/** A stored row, or null when it is not one (the caller drops it). */
export function parsePendingReload(json: string): PendingReload | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const str = (key: string) => typeof row[key] === "string" && (row[key] as string) !== "";
  if (!str("taskId") || !str("projectId") || !str("sha") || !str("target") || typeof row.summary !== "string") return null;
  if (row.threadId !== null && typeof row.threadId !== "string") return null;
  if (typeof row.startedAt !== "number" || !Number.isFinite(row.startedAt)) return null;
  return {
    taskId: row.taskId as string,
    threadId: (row.threadId as string | null) ?? null,
    projectId: row.projectId as string,
    sha: row.sha as string,
    target: row.target as string,
    summary: row.summary,
    startedAt: row.startedAt,
    // A malformed or empty one is dropped: the land then closes as it always did.
    ...(Array.isArray(row.more) && row.more.length > 0 && row.more.every((step) => typeof step === "string" && step !== "")
      ? { more: row.more as string[] }
      : {}),
  };
}

/** What the host read of the reload: exitCode null while it has not finished. */
export interface ReloadOutcome {
  exitCode: number | null;
  output: string;
}

export type ReloadDecision = { kind: "wait" } | { kind: "live" } | { kind: "failed"; reason: string };

function tail(output: string): string {
  const trimmed = output.trim();
  return trimmed.length > OUTPUT_TAIL ? `…${trimmed.slice(-OUTPUT_TAIL)}` : trimmed;
}

/**
 * What to do about a pending reload now. Only an instance started after the
 * land can say it is live: the old one saw exit 0 only because bb said so.
 */
export function decideReload({
  pending,
  outcome,
  instanceStartedAt,
  now,
}: {
  pending: PendingReload;
  /** null when the host could not be asked. */
  outcome: ReloadOutcome | null;
  /** When this plugin instance started, ms. */
  instanceStartedAt: number;
  now: number;
}): ReloadDecision {
  const timedOut = now - pending.startedAt >= RELOAD_TIMEOUT_MS;
  const exitCode = outcome?.exitCode ?? null;
  if (exitCode === 0) {
    if (instanceStartedAt > pending.startedAt) return { kind: "live" };
    if (timedOut) return { kind: "failed", reason: "reload reported success but no new instance started within 3 minutes" };
    return { kind: "wait" };
  }
  if (exitCode !== null) {
    const output = tail(outcome?.output ?? "");
    return { kind: "failed", reason: `reload exited ${exitCode}${output === "" ? "" : `: ${output}`}` };
  }
  if (timedOut) return { kind: "failed", reason: "no reload outcome after 3 minutes" };
  return { kind: "wait" };
}

/** bb's view of the plugin (bb plugin list --json), null when unknown. */
export interface PluginStatus {
  status: string | null;
  detail: string | null;
}

/**
 * One plugin's status in `bb plugin list --json` ({ plugins: [{ id, status,
 * statusDetail }] }; a bare array too). Null fields when it is absent.
 */
export function pluginStatusOf(json: string, pluginId: string): PluginStatus {
  const none = { status: null, detail: null };
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return none;
  }
  const list = Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null && Array.isArray((value as { plugins?: unknown }).plugins)
      ? (value as { plugins: unknown[] }).plugins
      : [];
  const entry = list.find(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && (item as { id?: unknown }).id === pluginId,
  );
  if (entry === undefined) return none;
  const field = (key: string, max: number) => (typeof entry[key] === "string" ? (entry[key] as string).slice(0, max) : null);
  return { status: field("status", 100), detail: field("statusDetail", 2000) };
}

/** The failure told to the task: ours, then bb's own reason when it has one. */
export function reloadFailureReason(reason: string, plugin: PluginStatus | null): string {
  const status = plugin?.status?.trim() || null;
  const detail = plugin?.detail?.trim() || null;
  if (status === null && detail === null) return `Reload failed: ${reason}.`;
  const says = status !== null && detail !== null ? `${status}: ${detail}` : (status ?? detail)!;
  return `Reload failed: ${reason}. bb says: ${says}`;
}

/** The close note; completionOf (model.ts) reads it back as "Landed on <target> · sha". */
export function reloadedNote(pending: PendingReload): string {
  return `Landed on ${pending.target} at ${pending.sha.slice(0, 7)}: ${pending.summary}`;
}

/** Told to the task's thread once the reload is live. */
export function reloadedMessage(pending: PendingReload): string {
  return `Reloaded: ${pending.sha.slice(0, 7)} is live. ${pending.taskId} is closed.`;
}
