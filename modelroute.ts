// Jev picks the model of each task, research and build agent: Sonnet for
// routine work, the provider's default (the owner's Claude default) for the
// rest. The one thing Jev steers; its kind/tier questions stay watch only
// (jevwatch.ts).
//
// The rules:
// - Sonnet only when Jev chose "sonnet" with probability >= SONNET_THRESHOLD.
//   Anything else (opus, unsure, no key, timeout, error, back-off) passes no
//   model: the spawn is what it was before. Never a model Jev did not choose.
// - Patches never: her chats always keep the provider default.
// - The owner's explicit model in the composer always wins.
// - Only on the claude-code provider: the model id means nothing to another.
// - What goes to TypeSafe is scrubbed first (scrub): emails, secrets, env
//   values, connection strings, signed URLs and phone numbers become
//   placeholders.
//
// Pure: host.ts does the one fetch (askRoute with real I/O), server.ts the
// spawn and the one write.
import { JEV_BACKOFF_MS, JEV_TIMEOUT_MS, STATE_LIMIT, readAnswer, type Answer } from "./jevwatch";
import type { KeyProblem, TypesafeConfig } from "./typesafe";

/** Jev's probability for "sonnet" must be at least this. */
export const SONNET_THRESHOLD = 0.7;
/** The model id passed to spawn when Jev picks Sonnet (in bb's claude-code model list). */
export const SONNET_MODEL = "claude-sonnet-5-5";
/** The only provider the model id is for. */
export const ROUTED_PROVIDER = "claude-code";
/** The host's whole exchange; the server's host.call allows a little more. */
export const ROUTE_TIMEOUT_MS = JEV_TIMEOUT_MS;
/** The board's line counts this far back. */
export const ROUTE_WINDOW_MS = 7 * 24 * 60 * 60_000;

export const MODEL_LABELS = ["sonnet", "opus"] as const;

export const MODEL_QUESTION = {
  type: "choice" as const,
  instructions: "An AI coding agent is about to work on this. Which model does it need?",
  criteria: {
    sonnet: "well-specified, routine or mechanical work: a clear plan to follow, a small or medium change, a lookup or summary",
    opus: "ambiguous, risky or cross-cutting work: design decisions, debugging an unclear failure, security, data or deploy safety, many files, or verifying other agents' claims",
  },
};

export type RouteRole = "patches" | "task" | "research" | "build";

// ------------------------------------------------------------------ scrub

type Rule = { name: string; pattern: RegExp; replace: (match: string, ...groups: string[]) => string };

const digits = (text: string) => text.replace(/\D/g, "").length;
/** A name that looks like an env var: UPPER_SNAKE (2+ chars), or one naming a credential or address. */
const isEnvName = (name: string) => /^[A-Z][A-Z0-9_]+$/.test(name) || /key|token|secret|pass|auth|dsn|url/i.test(name);
const URL_TAIL = String.raw`[^\s<>"'\`)\]]+`;

/**
 * In order: addresses first (a password in a URL is not left for the email
 * rule to half-eat), then env lines, then tokens, emails and phone numbers.
 * Each rule is tested alone (modelroute.test.ts), so turning one off fails a test.
 */
export const SCRUB_RULES: readonly Rule[] = [
  {
    name: "url-credentials",
    pattern: new RegExp(String.raw`\bhttps?:\/\/[^\s\/@:<>"'\`]+:[^\s\/@<>"'\`]*@${URL_TAIL}`, "gi"),
    replace: () => "<url>",
  },
  {
    name: "db-url",
    pattern: new RegExp(String.raw`\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/${URL_TAIL}`, "gi"),
    replace: () => "<db-url>",
  },
  {
    name: "scheme-credentials",
    pattern: new RegExp(String.raw`\b[a-z][a-z0-9+.\-]*:\/\/[^\s\/@:<>"'\`]+:[^\s\/@<>"'\`]*@${URL_TAIL}`, "gi"),
    replace: () => "<db-url>",
  },
  {
    name: "signed-url",
    pattern: new RegExp(
      String.raw`\bhttps?:\/\/[^\s?<>"'\`]*\?[^\s<>"'\`]*?(?<=[?&])[A-Za-z0-9_\-]*(?:token|key|secret|sig|code)[A-Za-z0-9_\-]*=[^\s<>"'\`)\]]*`,
      "gi",
    ),
    replace: () => "<url>",
  },
  {
    name: "env-line",
    pattern: /^([ \t]*(?:export[ \t]+|[-*][ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)([ \t]*[:=][ \t]*)(\S.*)$/gm,
    replace: (match, lead, name, sep) => (isEnvName(name) ? `${lead}${name}${sep}<value>` : match),
  },
  {
    name: "env-inline",
    pattern: /\b([A-Za-z_][A-Za-z0-9_]*)=("[^"\n]*"|'[^'\n]*'|[^\s"']+)/g,
    replace: (match, name) => (isEnvName(name) ? `${name}=<value>` : match),
  },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]{4,}(?:\.[A-Za-z0-9_\-]*)?/g, replace: () => "<secret>" },
  { name: "sk", pattern: /(?<![A-Za-z0-9_\-])sk-[A-Za-z0-9_\-]{6,}/g, replace: () => "<secret>" },
  { name: "github", pattern: /\b(?:gh[pousr]_[A-Za-z0-9_]{6,}|github_pat_[A-Za-z0-9_]{6,})/g, replace: () => "<secret>" },
  { name: "slack", pattern: /\bxox[a-z]-[A-Za-z0-9\-]{6,}/g, replace: () => "<secret>" },
  { name: "aws", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{12,}\b/g, replace: () => "<secret>" },
  {
    name: "long-token",
    pattern: /(?<![A-Za-z0-9_\-])[A-Za-z0-9_\-]{20,}(?![A-Za-z0-9_\-])/g,
    replace: (match) => (/[A-Za-z]/.test(match) && /\d/.test(match) ? "<secret>" : match),
  },
  { name: "email", pattern: /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, replace: () => "<email>" },
  {
    name: "phone-international",
    pattern: /(?<![\w+])\+\d{1,3}(?:[ .\-]?\(?\d{1,4}\)?){2,6}(?![\w])/g,
    replace: (match) => (digits(match) >= 8 ? "<phone>" : match),
  },
  {
    name: "phone",
    pattern: /(?<![\w.\-\/#])\(?\d{2,5}\)?(?:[ .\-]?\(?\d{2,5}\)?){1,5}(?![\w.\-\/]*\w)/g,
    replace: (match) => (digits(match) >= 10 ? "<phone>" : match),
  },
];

export function applyRule(rule: Rule, text: string): string {
  return text.replace(rule.pattern, rule.replace as (match: string, ...rest: unknown[]) => string);
}

/** The text with every rule applied, in order. */
export function scrub(text: string): string {
  return SCRUB_RULES.reduce((out, rule) => applyRule(rule, out), text);
}

// ------------------------------------------------------------------ what is asked

/** What Jev reads for one agent: scrubbed, then cut to STATE_LIMIT. */
export function routeState(
  input:
    | { role: "task"; title: string; brief: string }
    | { role: "research"; taskTitle: string; question: string }
    | { role: "build"; taskTitle: string; instructions: string },
): string {
  const text =
    input.role === "task"
      ? `Task: ${input.title}\n\n${input.brief}`
      : input.role === "research"
        ? `Research for the task "${input.taskTitle}":\n\n${input.question}`
        : `Build for the task "${input.taskTitle}":\n\n${input.instructions}`;
  return scrub(text).slice(0, STATE_LIMIT);
}

export function routeRequest(state: string, model: string) {
  return { model, state, questions: { model: MODEL_QUESTION } };
}

// ------------------------------------------------------------------ the host's side

/** What host.ts modelRoute returns: always a value, never a throw. */
export type RouteReply =
  | { ok: true; latencyMs: number; model: string | null; answer: Answer }
  | { ok: false; kind: "no-key"; problem: KeyProblem }
  | { ok: false; kind: "error" | "timeout"; error: string; latencyMs: number };

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: "error" },
) => Promise<{ status: number; text(): Promise<string> }>;

/** An echoed model name, only if it looks like one (it is stored). */
function modelId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._:/@+-]{1,80}$/.test(value) ? value : null;
}

/**
 * host.ts modelRoute with its I/O passed in: TypeSafe only, "no-key" with no
 * call when there is no usable key; else one POST with the whole exchange
 * under JEV_TIMEOUT_MS, no retry. No error carries the body or the key.
 */
export async function askRoute(
  io: { key: { ok: true; config: TypesafeConfig } | { ok: false; problem: KeyProblem }; fetch: FetchLike; now(): number },
  state: string,
  signal?: AbortSignal,
): Promise<RouteReply> {
  if (!io.key.ok) return { ok: false, kind: "no-key", problem: io.key.problem };
  const config = io.key.config;
  const started = io.now();
  const elapsed = () => Math.max(0, Math.round(io.now() - started));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JEV_TIMEOUT_MS);
  const stop = () => controller.abort();
  signal?.addEventListener("abort", stop);
  const timeout = () => ({ ok: false as const, kind: "timeout" as const, error: `no answer in ${JEV_TIMEOUT_MS} ms`, latencyMs: elapsed() });
  try {
    const response = await io.fetch(`${config.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(routeRequest(state.slice(0, STATE_LIMIT), config.model)),
      signal: controller.signal,
      redirect: "error",
    });
    const text = await response.text();
    if (controller.signal.aborted) return timeout();
    if (response.status !== 200) return { ok: false, kind: "error", error: `HTTP ${response.status}`, latencyMs: elapsed() };
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, kind: "error", error: "not JSON", latencyMs: elapsed() };
    }
    const record = typeof body === "object" && body !== null ? (body as { model?: unknown; answers?: unknown }) : {};
    const answers = typeof record.answers === "object" && record.answers !== null ? (record.answers as Record<string, unknown>) : {};
    return { ok: true, latencyMs: elapsed(), model: modelId(record.model), answer: readAnswer(answers.model, MODEL_LABELS) };
  } catch (error) {
    if (controller.signal.aborted) return timeout();
    const name = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "Error";
    return { ok: false, kind: "error", error: `network (${name})`, latencyMs: elapsed() };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

// ------------------------------------------------------------------ the server's side

/** Why an agent got the model it got. */
export type RouteReason =
  | "sonnet"
  | "opus"
  | "unsure"
  | "no-key"
  | "key-open"
  | "timeout"
  | "error"
  | "backoff"
  | "owner"
  | "provider"
  | "patches";

export interface RouteRecord {
  /** The model passed to spawn; null: none, the provider default. */
  model: string | null;
  reason: RouteReason;
  /** Jev's probability for its choice. */
  probability: number | null;
  /** The Jev version that answered. */
  jevModel: string | null;
  error: string | null;
}

/**
 * Whether Jev is asked at all for this spawn. Never for Patches; never when
 * the owner picked a model; never off the claude-code provider. Null: ask.
 */
export function routeSkip(input: { role: RouteRole; ownerModel: boolean; providerId: string | undefined }): RouteReason | null {
  if (input.role === "patches") return "patches";
  if (input.ownerModel) return "owner";
  if (input.providerId !== ROUTED_PROVIDER) return "provider";
  return null;
}

/**
 * The owner's composer model wins over Jev: when its source says explicit,
 * or a model came with no source to say otherwise.
 */
export function ownerPickedModel(execution: { model?: string; executionInputSources?: { model?: "client-preference" | "explicit" } }): boolean {
  if (execution.executionInputSources?.model === "explicit") return true;
  return execution.model !== undefined && execution.executionInputSources?.model === undefined;
}

/** The decision from Jev's reply: Sonnet only on a confident "sonnet". */
export function routeDecision(reply: RouteReply): RouteRecord {
  if (!reply.ok) {
    if (reply.kind === "no-key") {
      return { model: null, reason: reply.problem === "open" ? "key-open" : "no-key", probability: null, jevModel: null, error: null };
    }
    return { model: null, reason: reply.kind, probability: null, jevModel: null, error: reply.error.slice(0, 300) };
  }
  if ("error" in reply.answer) {
    return { model: null, reason: "error", probability: null, jevModel: reply.model, error: reply.answer.error.slice(0, 300) };
  }
  const { choice, top } = reply.answer;
  if (choice === "sonnet" && top >= SONNET_THRESHOLD) {
    return { model: SONNET_MODEL, reason: "sonnet", probability: top, jevModel: reply.model, error: null };
  }
  return { model: null, reason: choice === "sonnet" ? "unsure" : "opus", probability: top, jevModel: reply.model, error: null };
}

/** A record for a spawn Jev was not asked about (or the call itself failed). */
export function skippedRoute(reason: RouteReason, error: string | null = null): RouteRecord {
  return { model: null, reason, probability: null, jevModel: null, error: error === null ? null : error.slice(0, 300) };
}

/** True while the back-off after a failed route holds: Jev is not asked. */
export function routeBackoff(now: number, failedAt: number | null): boolean {
  return failedAt !== null && now - failedAt < JEV_BACKOFF_MS;
}

/** Whether this decision starts the back-off. */
export function routeFailed(record: RouteRecord): boolean {
  return record.reason === "timeout" || record.reason === "error";
}

/**
 * The spawn's options from the decision: `{ model }` only for Sonnet on a
 * non-Patches agent. The role is checked again here so no path can hand
 * Patches a model.
 */
export function spawnModel(role: RouteRole, record: RouteRecord): { model?: string } {
  if (role === "patches") return {};
  return record.reason === "sonnet" && record.model === SONNET_MODEL ? { model: SONNET_MODEL } : {};
}

// ------------------------------------------------------------------ the board

export function routeLabel(route: { model: string | null; probability: number | null }): string {
  return route.model !== null ? `Sonnet · Jev ${(route.probability ?? 0).toFixed(2)}` : "Default model";
}

export function routeTooltip(route: { reason: string; probability: number | null; jevModel: string | null }): string {
  const p = route.probability === null ? "" : ` (${route.probability.toFixed(2)})`;
  const by = route.jevModel === null ? "" : ` · ${route.jevModel}`;
  switch (route.reason) {
    case "sonnet":
      return `Jev chose Sonnet${p}${by}.`;
    case "opus":
      return `Jev chose Opus${p}: the provider default${by}.`;
    case "unsure":
      return `Jev leaned Sonnet but was unsure${p}, under ${SONNET_THRESHOLD}: the provider default${by}.`;
    case "no-key":
      return "Jev is off: no key. The provider default.";
    case "key-open":
      return "Jev is off: jev.env is readable by others. The provider default.";
    case "timeout":
      return "Jev did not answer in time: the provider default.";
    case "backoff":
      return "Jev is off for a few minutes after a failure: the provider default.";
    case "owner":
      return "The model picked in the composer.";
    case "provider":
      return "Not on Claude Code: the provider default.";
    case "patches":
      return "Patches always keeps the provider default.";
    default:
      return "Jev failed: the provider default.";
  }
}

/** The board's one line: routed agents of the last 7 days, or why there is no routing. */
export function routingLine(
  rows: readonly { routedAt: number; model: string | null }[],
  now: number,
  key: { present: true } | { present: false; problem: KeyProblem },
): string {
  if (!key.present) return key.problem === "open" ? "Jev model routing: off (jev.env is readable by others)" : "Jev model routing: no key";
  const recent = rows.filter((row) => now - row.routedAt < ROUTE_WINDOW_MS);
  const sonnet = recent.filter((row) => row.model !== null).length;
  return `Jev model routing: ${sonnet} of ${recent.length} ${recent.length === 1 ? "agent" : "agents"} on Sonnet`;
}
