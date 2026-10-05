// Jev picks the model and effort of each task, research and build agent at
// spawn: Sonnet for routine work, Haiku for a research lookup, a lower effort
// for work that needs less, the provider's default (the owner's Claude
// default) for the rest. The one thing Jev steers; its kind/tier questions
// stay watch only (jevwatch.ts). What happened next is compared on the board
// (routeoutcome.ts).
//
// The rules:
// - Sonnet only when Jev chose "sonnet" with probability >= SONNET_THRESHOLD;
//   Haiku only for research, when Jev chose "haiku" (offered to research only)
//   with probability >= HAIKU_THRESHOLD, and then no effort (its only level).
// - Effort only when Jev's choice is at least EFFORT_THRESHOLD sure and below
//   the default: research may get low or medium, task and build never below
//   medium. "high", unsure or any error passes no effort.
// - Anything else (opus, unsure, no key, timeout, error, back-off) passes no
//   model and no effort: the spawn is what it was before.
// - EFFORT_ROUTING false: effort is never passed and Haiku never chosen.
// - Patches never: her chats always keep the provider default.
// - The owner's explicit model or effort in the composer always wins: Jev is
//   not asked.
// - Only on the claude-code provider: the model id means nothing to another.
// - Only at spawn: a later message, retry or restart never carries a model or
//   effort (changing them mid-thread throws away the prompt cache).
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
/** Jev's probability for "haiku" (research only) must be at least this. */
export const HAIKU_THRESHOLD = 0.8;
/** Jev's probability for its effort choice must be at least this. */
export const EFFORT_THRESHOLD = 0.7;
/** The off switch: false, and effort is never passed and Haiku never chosen. */
export const EFFORT_ROUTING = true;
/** The model id passed to spawn when Jev picks Sonnet (in bb's claude-code model list). */
export const SONNET_MODEL = "claude-sonnet-5-5";
/** The model id passed to spawn when Jev picks Haiku for research; its only effort is low. */
export const HAIKU_MODEL = "claude-haiku-4-5-20251001";
/** The only provider the model id is for. */
export const ROUTED_PROVIDER = "claude-code";
/** The host's whole exchange; the server's host.call allows a little more. */
export const ROUTE_TIMEOUT_MS = JEV_TIMEOUT_MS;
/** The board's lines count this far back. */
export const ROUTE_WINDOW_MS = 14 * 24 * 60 * 60_000;

export const MODEL_LABELS = ["sonnet", "opus"] as const;
/** Research alone is offered Haiku. */
export const RESEARCH_MODEL_LABELS = ["haiku", "sonnet", "opus"] as const;
export const EFFORT_LABELS = ["low", "medium", "high"] as const;

const MODEL_CRITERIA = {
  haiku: "a pure lookup: find, read or quote facts, list files; no judgement",
  sonnet: "well-specified, routine or mechanical work: a clear plan to follow, a small or medium change, a lookup or summary",
  opus: "ambiguous, risky or cross-cutting work: design decisions, debugging an unclear failure, security, data or deploy safety, many files, or verifying other agents' claims",
};

export const MODEL_QUESTION = {
  type: "choice" as const,
  instructions: "An AI coding agent is about to work on this. Which model does it need?",
  criteria: { sonnet: MODEL_CRITERIA.sonnet, opus: MODEL_CRITERIA.opus },
};

export const RESEARCH_MODEL_QUESTION = {
  type: "choice" as const,
  instructions: MODEL_QUESTION.instructions,
  criteria: { haiku: MODEL_CRITERIA.haiku, sonnet: MODEL_CRITERIA.sonnet, opus: MODEL_CRITERIA.opus },
};

export const EFFORT_QUESTION = {
  type: "choice" as const,
  instructions: "An AI coding agent is about to work on this. How much reasoning effort does it need?",
  criteria: {
    low: "a mechanical lookup or one obvious step",
    medium: "routine work with a clear plan and some judgement",
    high: "anything needing careful reasoning, debugging, design, security, or verifying others' claims",
  },
};

export type RouteRole = "patches" | "task" | "research" | "build";
/** The roles Jev is asked about. */
export type AskedRole = Exclude<RouteRole, "patches">;
/** The efforts Jev may pass: only below the provider default (high). */
export type Effort = "low" | "medium";

/** The model labels offered to a role: Haiku to research only, and only with effort routing on. */
export function modelLabels(role: AskedRole, on: boolean = EFFORT_ROUTING): readonly string[] {
  return on && role === "research" ? RESEARCH_MODEL_LABELS : MODEL_LABELS;
}

/** The efforts a role may be given: research low or medium, task and build medium only. */
export function allowedEfforts(role: RouteRole): readonly Effort[] {
  if (role === "research") return ["low", "medium"];
  if (role === "task" || role === "build") return ["medium"];
  return [];
}

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

/**
 * One TypeSafe request: the model question (Haiku offered to research only)
 * and, with effort routing on, the effort question.
 */
export function routeRequest(state: string, model: string, role: AskedRole, on: boolean = EFFORT_ROUTING) {
  if (!on) return { model, state, questions: { model: MODEL_QUESTION } };
  return { model, state, questions: { model: role === "research" ? RESEARCH_MODEL_QUESTION : MODEL_QUESTION, effort: EFFORT_QUESTION } };
}

// ------------------------------------------------------------------ the host's side

/** What host.ts modelRoute returns: always a value, never a throw. */
export type RouteReply =
  | { ok: true; latencyMs: number; model: string | null; answer: Answer; effort: Answer }
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
  role: AskedRole,
  signal?: AbortSignal,
  on: boolean = EFFORT_ROUTING,
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
      body: JSON.stringify(routeRequest(state.slice(0, STATE_LIMIT), config.model, role, on)),
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
    return {
      ok: true,
      latencyMs: elapsed(),
      model: modelId(record.model),
      answer: readAnswer(answers.model, modelLabels(role, on)),
      effort: on ? readAnswer(answers.effort, EFFORT_LABELS) : { error: "not asked" },
    };
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
  | "haiku"
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

/**
 * Why an agent got the effort it got. "low"/"medium": Jev's; "floor": Jev
 * said low for a task or build, which never goes below medium; "haiku": its
 * only level; "off": EFFORT_ROUTING is false; "none": Jev was not asked, or
 * the model answer failed.
 */
export type EffortReason = "low" | "medium" | "floor" | "high" | "unsure" | "error" | "haiku" | "off" | "none";

export interface RouteRecord {
  /** The model passed to spawn; null: none, the provider default. */
  model: string | null;
  reason: RouteReason;
  /** Jev's probability for its model choice. */
  probability: number | null;
  /** The Jev version that answered. */
  jevModel: string | null;
  error: string | null;
  /** The effort passed to spawn; null: none, the provider default. */
  effort: Effort | null;
  effortReason: EffortReason;
  /** Jev's probability for its effort choice. */
  effortProbability: number | null;
}

/**
 * Whether Jev is asked at all for this spawn. Never for Patches; never when
 * the owner picked a model or effort; never off the claude-code provider. Null: ask.
 */
export function routeSkip(input: { role: RouteRole; ownerModel: boolean; providerId: string | undefined }): RouteReason | null {
  if (input.role === "patches") return "patches";
  if (input.ownerModel) return "owner";
  if (input.providerId !== ROUTED_PROVIDER) return "provider";
  return null;
}

type Source = "client-preference" | "explicit";

/**
 * The owner's composer pick wins over Jev only when its source says
 * explicit: they touched the model or effort picker. bb's composer always
 * sends both; a stored preference says "client-preference", the default
 * says nothing.
 */
export function ownerPickedModel(execution: { model?: string; executionInputSources?: { model?: Source; reasoningLevel?: Source } }): boolean {
  const sources = execution.executionInputSources;
  return sources?.model === "explicit" || sources?.reasoningLevel === "explicit";
}

/** The effort from Jev's answer: only a confident one below the default, floored for task and build. */
export function effortDecision(
  answer: Answer,
  role: AskedRole,
  on: boolean = EFFORT_ROUTING,
): { effort: Effort | null; effortReason: EffortReason; effortProbability: number | null } {
  if (!on) return { effort: null, effortReason: "off", effortProbability: null };
  if ("error" in answer) return { effort: null, effortReason: "error", effortProbability: null };
  const { choice, top } = answer;
  if (top < EFFORT_THRESHOLD) return { effort: null, effortReason: "unsure", effortProbability: top };
  if (choice === "low") {
    return role === "research"
      ? { effort: "low", effortReason: "low", effortProbability: top }
      : { effort: "medium", effortReason: "floor", effortProbability: top };
  }
  if (choice === "medium") return { effort: "medium", effortReason: "medium", effortProbability: top };
  return { effort: null, effortReason: "high", effortProbability: top };
}

const NO_EFFORT = { effort: null, effortReason: "none" as const, effortProbability: null };

/** The decision from Jev's reply: Sonnet on a confident "sonnet", Haiku on a very confident research "haiku", the effort beside it. */
export function routeDecision(reply: RouteReply, role: AskedRole, on: boolean = EFFORT_ROUTING): RouteRecord {
  if (!reply.ok) {
    if (reply.kind === "no-key") {
      return { model: null, reason: reply.problem === "open" ? "key-open" : "no-key", probability: null, jevModel: null, error: null, ...NO_EFFORT };
    }
    return { model: null, reason: reply.kind, probability: null, jevModel: null, error: reply.error.slice(0, 300), ...NO_EFFORT };
  }
  if ("error" in reply.answer) {
    return { model: null, reason: "error", probability: null, jevModel: reply.model, error: reply.answer.error.slice(0, 300), ...NO_EFFORT };
  }
  const { choice, top } = reply.answer;
  const base = { probability: top, jevModel: reply.model, error: null };
  if (choice === "haiku" && on && role === "research" && top >= HAIKU_THRESHOLD) {
    return { model: HAIKU_MODEL, reason: "haiku", ...base, effort: null, effortReason: "haiku", effortProbability: null };
  }
  const effort = effortDecision(reply.effort, role, on);
  if (choice === "sonnet" && top >= SONNET_THRESHOLD) return { model: SONNET_MODEL, reason: "sonnet", ...base, ...effort };
  return { model: null, reason: choice === "opus" ? "opus" : "unsure", ...base, ...effort };
}

/** A record for a spawn Jev was not asked about (or the call itself failed). */
export function skippedRoute(reason: RouteReason, error: string | null = null): RouteRecord {
  return { model: null, reason, probability: null, jevModel: null, error: error === null ? null : error.slice(0, 300), ...NO_EFFORT };
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
 * The board's view of the back-off: when it ends and why it started (scrubbed,
 * short); null when it does not hold.
 */
export function routePause(now: number, failure: { at: number; error: string | null } | null): { until: number; reason: string } | null {
  if (failure === null || !routeBackoff(now, failure.at)) return null;
  return { until: failure.at + JEV_BACKOFF_MS, reason: scrub(failure.error ?? "failed").slice(0, 120) };
}

/** The routing line's tail while the back-off holds; "" when it does not. `clock` formats HH:MM. */
export function pausedText(pause: { until: number } | null, now: number, clock: (ms: number) => string): string {
  return pause === null || now >= pause.until ? "" : ` · paused after a failure until ${clock(pause.until)}`;
}

/**
 * The spawn's options from the decision, re-checked here so no path can hand
 * Patches a model or effort, give a task or build less than medium, or give
 * anyone but research Haiku: `{ model }` for Sonnet or Haiku, `{ reasoningLevel }`
 * for an effort the role may have. Only ever passed to spawn.
 */
export function spawnModel(role: RouteRole, record: RouteRecord, on: boolean = EFFORT_ROUTING): { model?: string; reasoningLevel?: Effort } {
  if (role === "patches") return {};
  if (on && role === "research" && record.reason === "haiku" && record.model === HAIKU_MODEL) return { model: HAIKU_MODEL };
  const model = record.reason === "sonnet" && record.model === SONNET_MODEL ? { model: SONNET_MODEL } : {};
  const effort = on && record.effort !== null && allowedEfforts(role).includes(record.effort) ? { reasoningLevel: record.effort } : {};
  return { ...model, ...effort };
}

// ------------------------------------------------------------------ the board

/** The model's short name on the board. */
function modelName(model: string | null): string {
  if (model === null) return "Default model";
  if (model === SONNET_MODEL) return "Sonnet";
  if (model === HAIKU_MODEL) return "Haiku";
  return model;
}

/** "Sonnet · medium · Jev 0.86", "Haiku · Jev 0.91", "Default model · medium", "Default model". */
export function routeLabel(route: { model: string | null; probability: number | null; effort?: string | null }): string {
  const parts = [modelName(route.model)];
  if (route.effort) parts.push(route.effort);
  if (route.model !== null) parts.push(`Jev ${(route.probability ?? 0).toFixed(2)}`);
  return parts.join(" · ");
}

function modelTooltip(route: { reason: string; probability: number | null; jevModel: string | null }): string {
  const p = route.probability === null ? "" : ` (${route.probability.toFixed(2)})`;
  const by = route.jevModel === null ? "" : ` · ${route.jevModel}`;
  switch (route.reason) {
    case "sonnet":
      return `Jev chose Sonnet${p}${by}.`;
    case "haiku":
      return `Jev chose Haiku for a lookup${p}${by}.`;
    case "opus":
      return `Jev chose Opus${p}: the provider default${by}.`;
    case "unsure":
      return `Jev leaned to a smaller model but was unsure${p}, under ${SONNET_THRESHOLD} for Sonnet or ${HAIKU_THRESHOLD} for Haiku: the provider default${by}.`;
    case "no-key":
      return "Jev is off: no key. The provider default.";
    case "key-open":
      return "Jev is off: jev.env is readable by others. The provider default.";
    case "timeout":
      return "Jev did not answer in time: the provider default.";
    case "backoff":
      return "Jev is off for a few minutes after a failure: the provider default.";
    case "owner":
      return "The model or effort picked in the composer.";
    case "provider":
      return "Not on Claude Code: the provider default.";
    case "patches":
      return "Patches always keeps the provider default.";
    default:
      return "Jev failed: the provider default.";
  }
}

function effortTooltip(route: { effortReason?: string | null; effortProbability?: number | null }): string {
  const p = route.effortProbability == null ? "" : ` (${route.effortProbability.toFixed(2)})`;
  switch (route.effortReason) {
    case "low":
      return `Effort: Jev chose low${p}.`;
    case "medium":
      return `Effort: Jev chose medium${p}.`;
    case "floor":
      return `Effort: Jev said low${p}; a task or build never goes below medium.`;
    case "high":
      return `Effort: Jev chose high${p}, the default.`;
    case "unsure":
      return `Effort: Jev was unsure${p}, under ${EFFORT_THRESHOLD}: the default.`;
    case "error":
      return "Effort: Jev's answer was unusable: the default.";
    case "haiku":
      return "Effort: Haiku's only level.";
    case "off":
      return "Effort routing is off: the default.";
    default:
      return "Effort: the default.";
  }
}

/** The mark's tooltip: why this model, then why this effort. */
export function routeTooltip(route: {
  reason: string;
  probability: number | null;
  jevModel: string | null;
  effortReason?: string | null;
  effortProbability?: number | null;
}): string {
  return `${modelTooltip(route)} ${effortTooltip(route)}`;
}

/** The reasons of agents Jev was asked about (it answered, or the call failed). */
const ASKED: ReadonlySet<string> = new Set<RouteReason>(["sonnet", "haiku", "opus", "unsure", "error", "timeout"]);

/** Whether Jev put this agent below the default: a smaller model or a lower effort. */
export function lowered(route: { model: string | null; effort?: string | null }): boolean {
  return route.model !== null || (route.effort ?? null) !== null;
}

/**
 * The board's one line: of the agents Jev was asked about in the last 14
 * days, how many it lowered, and how (Sonnet, Haiku, a lower effort); or why
 * there is no routing. Agents it was never asked about (the owner's pick,
 * Patches, another provider, no key, the back-off) are not counted.
 */
export function routingLine(
  rows: readonly { routedAt: number; model: string | null; reason: string; effort?: string | null }[],
  now: number,
  key: { present: true } | { present: false; problem: KeyProblem },
): string {
  if (!key.present) return key.problem === "open" ? "Jev model routing: off (jev.env is readable by others)" : "Jev model routing: no key";
  const asked = rows.filter((row) => now - row.routedAt < ROUTE_WINDOW_MS && ASKED.has(row.reason));
  const sonnet = asked.filter((row) => row.reason === "sonnet" && row.model !== null).length;
  const haiku = asked.filter((row) => row.reason === "haiku" && row.model !== null).length;
  const effort = asked.filter((row) => (row.effort ?? null) !== null).length;
  const down = asked.filter(lowered).length;
  const how = [`${sonnet} Sonnet`, ...(haiku > 0 ? [`${haiku} Haiku`] : []), `${effort} lower effort`].join(", ");
  return `Jev model routing: ${down} of ${asked.length} ${asked.length === 1 ? "agent" : "agents"} lowered (${how})`;
}
