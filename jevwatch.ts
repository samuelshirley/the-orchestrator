// "Jev before Opus", WATCH ONLY. For each new task Jev is asked two typed
// questions (what kind of task, how big) in the background; its answer is
// stored next to what actually happened once the task closes, and the board
// shows how often they agree. Nothing here decides anything: there is no
// function that turns an answer into an action, and server.ts only writes the
// answer to the dossier (jevwatch.test.ts checks that). Steering is a later
// rung that the owner turns on.
//
// Jev runs on the owner's Mac for now (jev/local/, 127.0.0.1:8766, no key); the
// rented box (jev/cli.ts, https + key) is kept for later and asked only when
// there is no valid local.json.
//
// Pure: the host does the one fetch (host.ts jevAsk), the server the one write.

/** The whole exchange, body included. Past it the ask is a timeout, never a wait. */
export const JEV_TIMEOUT_MS = 2000;
/** After a failure, no call for this long. */
export const JEV_BACKOFF_MS = 5 * 60_000;
export const STATE_LIMIT = 4000;

export const KIND_LABELS = ["research", "build"] as const;
export const TIER_LABELS = ["small", "medium", "large"] as const;
export type JevKind = (typeof KIND_LABELS)[number];
export type JevTier = (typeof TIER_LABELS)[number];
export const QUESTION_KEYS = ["kind", "tier"] as const;
export type QuestionKey = (typeof QUESTION_KEYS)[number];
const LABELS: Record<QuestionKey, readonly string[]> = { kind: KIND_LABELS, tier: TIER_LABELS };

interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export const QUESTIONS: Record<QuestionKey, ChoiceQuestion> = {
  kind: {
    type: "choice",
    instructions: "A task for a software team, in its title and brief. What will finishing it take?",
    criteria: {
      research: "an answer, report or decision only; no code change",
      build: "needs a code change that is built and landed or opened as a PR",
    },
  },
  tier: {
    type: "choice",
    instructions: "A task for a software team, in its title and brief. How big is it?",
    criteria: {
      small: "a quick answer, or one clean change to a few files",
      medium: "a real change across more files, done in one build without questions",
      large: "needs several attempts, several builds or questions to the owner",
    },
  },
};

export interface SystemOneRequest {
  model: string;
  state: string;
  questions: Record<QuestionKey, ChoiceQuestion>;
}

export function jevState(task: { title: string; brief: string }): string {
  return `${task.title}\n\n${task.brief}`.slice(0, STATE_LIMIT);
}

export function buildRequest(task: { title: string; brief: string }, model: string): SystemOneRequest {
  return { model, state: jevState(task), questions: QUESTIONS };
}

// ------------------------------------------------------------------ answers

export type Answer = { choice: string; top: number; margin: number } | { error: string };

/**
 * Our reading of one answer: the choice, its probability and its lead over
 * the runner-up. The server's own `confidence` is never read. Rejected when
 * it is not a choice, names a label we did not offer, gives a probability to
 * one, or picks a label that is not the most probable.
 */
export function readAnswer(answer: unknown, labels: readonly string[]): Answer {
  if (typeof answer !== "object" || answer === null) return { error: "no answer" };
  const { type, choice, probabilities } = answer as { type?: unknown; choice?: unknown; probabilities?: unknown };
  if (type !== "choice") return { error: "not a choice" };
  if (typeof choice !== "string" || !labels.includes(choice)) return { error: "choice outside the labels" };
  if (typeof probabilities !== "object" || probabilities === null) return { error: "no probabilities" };
  const probs = probabilities as Record<string, unknown>;
  for (const [label, p] of Object.entries(probs)) {
    if (!labels.includes(label)) return { error: "probability for a label not offered" };
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) return { error: "bad probability" };
  }
  if (!(choice in probs)) return { error: "no probability for the choice" };
  const top = probs[choice] as number;
  let second = 0;
  for (const label of labels) {
    if (label === choice) continue;
    const p = (probs[label] as number | undefined) ?? 0;
    if (p > top) return { error: "choice is not the most probable" };
    second = Math.max(second, p);
  }
  return { choice, top, margin: top - second };
}

/** An echoed model name, only if it looks like one (it is stored). */
function modelId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._:/@+-]{1,80}$/.test(value) ? value : null;
}

export function parseAnswers(body: unknown): { model: string | null; answers: Record<QuestionKey, Answer> } {
  const record = typeof body === "object" && body !== null ? (body as { model?: unknown; answers?: unknown }) : {};
  const answers = typeof record.answers === "object" && record.answers !== null ? (record.answers as Record<string, unknown>) : {};
  return {
    model: modelId(record.model),
    answers: {
      kind: readAnswer(answers.kind, LABELS.kind),
      tier: readAnswer(answers.tier, LABELS.tier),
    },
  };
}

// ------------------------------------------------------------------ the host's side

/** What host.ts jevAsk returns: always a value, never a throw. */
export type JevAskReply =
  | { ok: true; latencyMs: number; model: string | null; answers: Record<QuestionKey, Answer> }
  | { ok: false; kind: "off" }
  | { ok: false; kind: "down" }
  | { ok: false; kind: "error" | "timeout"; error: string; latencyMs: number };

/** Where to ask. `key` is null for the local server: no auth, bound to loopback. */
export interface JevConfig {
  baseUrl: string;
  key: string | null;
  model: string;
}

export const LOCAL_MODEL = "typed-decisions";
/** A project's own test server may listen here. Jev never shares it. */
const RESERVED_TEST_PORT = 8765;

/**
 * The Jev server on the owner's Mac, from `~/.config/jev/local.json` (written by
 * jev/local/install.sh): null unless it is plain http on 127.0.0.1 itself
 * (not localhost, ::1, 0.0.0.0 or any other host), at an explicit
 * unprivileged port that is not 8765 (kept for a project's own test server), with no
 * credentials, path, query or fragment.
 */
export function jevLocalConfig(localText: string | null): { baseUrl: string; key: null; model: string } | null {
  if (localText === null) return null;
  let local: { baseUrl?: unknown; model?: unknown };
  try {
    local = JSON.parse(localText) as typeof local;
  } catch {
    return null;
  }
  if (typeof local !== "object" || local === null || Array.isArray(local) || typeof local.baseUrl !== "string") return null;
  let url: URL;
  try {
    url = new URL(local.baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  if (url.hostname !== "127.0.0.1") return null;
  const port = url.port === "" ? NaN : Number(url.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  if (port === RESERVED_TEST_PORT) return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return { baseUrl: url.origin, key: null, model: modelId(local.model) ?? LOCAL_MODEL };
}

/** A refused connection: nothing is listening. Node's fetch rejects with a TypeError whose cause has the code. */
function refused(error: unknown): boolean {
  const cause = error instanceof Error ? (error.cause as { code?: unknown; errors?: unknown } | undefined) : undefined;
  if (typeof cause !== "object" || cause === null) return false;
  if (cause.code === "ECONNREFUSED") return true;
  return Array.isArray(cause.errors) && cause.errors.length > 0 && cause.errors.every((e) => (e as { code?: unknown } | null)?.code === "ECONNREFUSED");
}

/**
 * Where the Orchestrator's Jev is, from `jev up`'s state.json and clients.env:
 * null (off, no call) unless the box is up at an https URL and our key is there.
 */
export function jevClientConfig(stateText: string | null, clientsText: string | null): { baseUrl: string; key: string; model: string } | null {
  if (stateText === null || clientsText === null) return null;
  let state: { status?: unknown; baseUrl?: unknown; model?: unknown };
  try {
    state = JSON.parse(stateText) as typeof state;
  } catch {
    return null;
  }
  if (state === null || state.status !== "up" || typeof state.baseUrl !== "string") return null;
  let url: URL;
  try {
    url = new URL(state.baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "") return null;
  const match = /^(?:export\s+)?JEV_KEY_ORCHESTRATOR=['"]?([0-9a-f]{64})['"]?\s*$/m.exec(clientsText);
  if (match === null) return null;
  return { baseUrl: url.origin, key: match[1], model: typeof state.model === "string" ? state.model : "jev" };
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: "error" },
) => Promise<{ status: number; text(): Promise<string> }>;

/**
 * host.ts jevAsk, with its I/O passed in so the tests can hold it: the local
 * server when local.json is valid, else the rented box, else "off" with no
 * call; one POST with the whole exchange under JEV_TIMEOUT_MS; every outcome
 * a value; no error carries the body. A local server that is not running
 * (connection refused) is "down", which writes no row.
 */
export async function askJev(
  io: {
    readLocal(): Promise<string | null>;
    readState(): Promise<string | null>;
    readClients(): Promise<string | null>;
    fetch: FetchLike;
    now(): number;
  },
  task: { title: string; brief: string },
  signal?: AbortSignal,
): Promise<JevAskReply> {
  let config: JevConfig | null;
  try {
    config = jevLocalConfig(await io.readLocal());
  } catch {
    config = null;
  }
  const local = config !== null;
  if (config === null) {
    try {
      config = jevClientConfig(await io.readState(), await io.readClients());
    } catch {
      config = null;
    }
  }
  if (config === null) return { ok: false, kind: "off" };
  const started = io.now();
  const elapsed = () => Math.max(0, Math.round(io.now() - started));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JEV_TIMEOUT_MS);
  const stop = () => controller.abort();
  signal?.addEventListener("abort", stop);
  try {
    const response = await io.fetch(`${config.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: { ...(config.key === null ? {} : { Authorization: `Bearer ${config.key}` }), "Content-Type": "application/json" },
      body: JSON.stringify(buildRequest(task, config.model)),
      signal: controller.signal,
      redirect: "error",
    });
    const text = await response.text();
    if (controller.signal.aborted) return { ok: false, kind: "timeout", error: `no answer in ${JEV_TIMEOUT_MS} ms`, latencyMs: elapsed() };
    if (response.status !== 200) return { ok: false, kind: "error", error: `HTTP ${response.status}`, latencyMs: elapsed() };
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, kind: "error", error: "not JSON", latencyMs: elapsed() };
    }
    const parsed = parseAnswers(body);
    return { ok: true, latencyMs: elapsed(), model: parsed.model, answers: parsed.answers };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, kind: "timeout", error: `no answer in ${JEV_TIMEOUT_MS} ms`, latencyMs: elapsed() };
    if (local && refused(error)) return { ok: false, kind: "down" };
    const name = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "Error";
    return { ok: false, kind: "error", error: `network (${name})`, latencyMs: elapsed() };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

// ------------------------------------------------------------------ the server's side

export function shouldCall(now: number, lastFailureAt: number | null): boolean {
  return lastFailureAt === null || now - lastFailureAt >= JEV_BACKOFF_MS;
}

/**
 * The host's gate after a "down": true while the back-off holds, so a local
 * server that is not running is tried once per JEV_BACKOFF_MS, not per task.
 */
export function downGate(now: number, lastDownAt: number | null): boolean {
  return lastDownAt !== null && now - lastDownAt < JEV_BACKOFF_MS;
}

export interface JevAskRecord {
  model: string | null;
  latencyMs: number | null;
  error: string | null;
  jevKind: string | null;
  jevKindTop: number | null;
  jevKindMargin: number | null;
  jevTier: string | null;
  jevTierTop: number | null;
  jevTierMargin: number | null;
}

/** The dossier row for one ask; null for "off" and "down", which write nothing. */
export function askRecord(reply: JevAskReply): JevAskRecord | null {
  if (!reply.ok && (reply.kind === "off" || reply.kind === "down")) return null;
  const empty = { jevKind: null, jevKindTop: null, jevKindMargin: null, jevTier: null, jevTierTop: null, jevTierMargin: null };
  if (!reply.ok) {
    return { model: null, latencyMs: reply.latencyMs, error: `${reply.kind}: ${reply.error}`.slice(0, 300), ...empty };
  }
  const { kind, tier } = reply.answers;
  const errors = QUESTION_KEYS.flatMap((key) => {
    const answer = reply.answers[key];
    return "error" in answer ? [`${key}: ${answer.error}`] : [];
  });
  return {
    model: reply.model,
    latencyMs: reply.latencyMs,
    error: errors.length > 0 ? errors.join("; ").slice(0, 300) : null,
    jevKind: "choice" in kind ? kind.choice : null,
    jevKindTop: "choice" in kind ? kind.top : null,
    jevKindMargin: "choice" in kind ? kind.margin : null,
    jevTier: "choice" in tier ? tier.choice : null,
    jevTierTop: "choice" in tier ? tier.top : null,
    jevTierMargin: "choice" in tier ? tier.margin : null,
  };
}

/** Would a failed ask start the back-off? */
export function failedAsk(record: JevAskRecord): boolean {
  return record.error !== null;
}

export interface OutcomeFacts {
  builds: number;
  buildFailures: number;
  asksToSam: number;
  filesTouched: number;
}

/** What the task turned out to be: the ground truth Jev is compared with. */
export function actualOutcome(facts: OutcomeFacts): { kind: JevKind; tier: JevTier } {
  const kind: JevKind = facts.builds > 0 ? "build" : "research";
  const tier: JevTier =
    facts.buildFailures > 0 || facts.builds >= 2 || facts.asksToSam > 0
      ? "large"
      : facts.builds === 0 || facts.filesTouched <= 3
        ? "small"
        : "medium";
  return { kind, tier };
}

// ------------------------------------------------------------------ the report

export interface JevWatchRow extends JevAskRecord {
  taskId: string;
  projectId: string;
  askedAt: number;
  actualKind: string | null;
  actualTier: string | null;
  actualAt: number | null;
}

export interface QuestionReport {
  /** Rows with both Jev's answer and the actual outcome. */
  compared: number;
  agree: number;
  rate: number | null;
  /** confusion[jev][actual] = count. */
  confusion: Record<string, Record<string, number>>;
  errors: number;
  timeouts: number;
}

export interface AgreementReport {
  rows: number;
  /** Asked, task not closed yet. */
  open: number;
  kind: QuestionReport;
  tier: QuestionReport;
  /** Jev said small, and it turned out large: the miss that would hurt once it steers. */
  riskyMiss: number;
  errors: number;
  timeouts: number;
  p50LatencyMs: number | null;
}

function questionReport(rows: readonly JevWatchRow[], key: QuestionKey): QuestionReport {
  const jevOf = (row: JevWatchRow) => (key === "kind" ? row.jevKind : row.jevTier);
  const actualOf = (row: JevWatchRow) => (key === "kind" ? row.actualKind : row.actualTier);
  const confusion: Record<string, Record<string, number>> = {};
  let compared = 0;
  let agree = 0;
  let errors = 0;
  let timeouts = 0;
  for (const row of rows) {
    const jev = jevOf(row);
    const actual = actualOf(row);
    if (jev === null) {
      if (row.error !== null) {
        errors += 1;
        if (row.error.startsWith("timeout")) timeouts += 1;
      }
      continue;
    }
    if (actual === null) continue;
    compared += 1;
    if (jev === actual) agree += 1;
    confusion[jev] ??= {};
    confusion[jev][actual] = (confusion[jev][actual] ?? 0) + 1;
  }
  return { compared, agree, rate: compared === 0 ? null : agree / compared, confusion, errors, timeouts };
}

export function agreementReport(rows: readonly JevWatchRow[]): AgreementReport {
  const latencies = rows
    .map((row) => row.latencyMs)
    .filter((ms): ms is number => ms !== null)
    .sort((a, b) => a - b);
  return {
    rows: rows.length,
    open: rows.filter((row) => row.actualAt === null).length,
    kind: questionReport(rows, "kind"),
    tier: questionReport(rows, "tier"),
    riskyMiss: rows.filter((row) => row.jevTier === "small" && row.actualTier === "large").length,
    errors: rows.filter((row) => row.error !== null).length,
    timeouts: rows.filter((row) => row.error?.startsWith("timeout") ?? false).length,
    p50LatencyMs: latencies.length === 0 ? null : latencies[Math.floor((latencies.length - 1) / 2)],
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The board's one line; null (hidden) with no rows. */
export function reportLine(report: AgreementReport): string | null {
  if (report.rows === 0) return null;
  return [
    `Jev (watch only): kind ${report.kind.agree}/${report.kind.compared} agree`,
    `tier ${report.tier.agree}/${report.tier.compared}`,
    plural(report.riskyMiss, "risky miss", "risky misses"),
    plural(report.errors, "error", "errors"),
  ].join(" · ");
}

/** The line's tooltip: the details behind it. */
export function reportDetail(report: AgreementReport): string {
  const table = (q: QuestionReport) =>
    Object.entries(q.confusion)
      .map(([jev, row]) => `${jev} → ${Object.entries(row).map(([actual, n]) => `${actual} ${n}`).join(", ")}`)
      .join("; ") || "nothing compared yet";
  return [
    `${report.rows} asked, ${report.open} still open.`,
    `Kind (Jev → actual): ${table(report.kind)}.`,
    `Tier (Jev → actual): ${table(report.tier)}.`,
    `${report.timeouts} timeouts; p50 ${report.p50LatencyMs === null ? "n/a" : `${report.p50LatencyMs} ms`}.`,
    "Watch only: nothing Jev answers changes what The Orchestrator does.",
  ].join("\n");
}
