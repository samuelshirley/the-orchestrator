// The Jev box's rules, pure: which machine a model needs, the $20 cap, the
// idle and lifetime watchdog, what the Verda API's bodies mean, the spend
// ledger and the env files. cli.ts does the I/O; jev/box/watchdog.sh repeats
// watchdogDecision in bash (watchdog.test.ts holds the two together).
//
// Node runs cli.ts straight from source, so this file is erasable TypeScript
// only: no enums, namespaces or parameter properties.

export interface ModelProfile {
  instanceType: string;
  /** The list price we checked (public GET /instance-types); refuse above +10%. */
  expectedUsdH: number;
  gpu: boolean;
  /** Which server jev/box/setup.sh installs. */
  server: "laya" | "anyjev";
}

export const MODEL_PROFILES: Readonly<Record<string, ModelProfile>> = {
  "laya-421m": { instanceType: "CPU.4V.16G", expectedUsdH: 0.048, gpu: false, server: "laya" },
  "anyjev-qwen3-8b": { instanceType: "1A6000.10V", expectedUsdH: 0.64, gpu: true, server: "anyjev" },
};

export const NO_MODEL = "The owner hasn't picked the Jev model yet (open question)";

/** The model from ~/.config/jev/config.json, never a default. */
export function modelFromConfig(raw: string | null): { ok: true; model: string; profile: ModelProfile } | { ok: false; reason: string } {
  if (raw === null) return { ok: false, reason: `${NO_MODEL}: no config.json.` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `${NO_MODEL}: config.json is not JSON.` };
  }
  const model = typeof parsed === "object" && parsed !== null ? (parsed as { model?: unknown }).model : undefined;
  if (typeof model !== "string" || model === "") return { ok: false, reason: `${NO_MODEL}: config.json names no model.` };
  const profile = Object.hasOwn(MODEL_PROFILES, model) ? MODEL_PROFILES[model] : undefined;
  if (profile === undefined) {
    return { ok: false, reason: `${NO_MODEL}: "${model}" is not one of ${Object.keys(MODEL_PROFILES).join(", ")}.` };
  }
  return { ok: true, model, profile };
}

// ------------------------------------------------------------------ money

/** The prepaid balance the owner put in: everything the ledger records counts against it. */
export const CAP_USD = 20;
export const IDLE_MINUTES = 15;
export const MAX_LIFETIME_HOURS = 4;
/** A session can run at most this long (the box deletes itself), so the cap reserves it whole. */
export const MAX_SESSION_HOURS = MAX_LIFETIME_HOURS;
/** Refuse when Verda's price is more than this over the one we checked. */
export const PRICE_TOLERANCE = 1.1;

export type CapResult = { ok: true } | { ok: false; reason: string };

export function capCheck(input: {
  ledgerUsd: number;
  priceUsdH: number;
  expectedUsdH: number;
  maxSessionHours: number;
  balanceUsd: number | null;
}): CapResult {
  const { ledgerUsd, priceUsdH, expectedUsdH, maxSessionHours, balanceUsd } = input;
  if (!Number.isFinite(priceUsdH) || priceUsdH <= 0) return { ok: false, reason: "Verda gave no usable price." };
  if (priceUsdH > expectedUsdH * PRICE_TOLERANCE) {
    return {
      ok: false,
      reason: `Verda's price $${usd(priceUsdH)}/h is more than 10% over the $${usd(expectedUsdH)}/h we checked.`,
    };
  }
  const session = maxSessionHours * priceUsdH;
  if (ledgerUsd + session > CAP_USD) {
    return {
      ok: false,
      reason: `The $${CAP_USD} cap: $${usd(ledgerUsd)} spent plus up to $${usd(session)} for this session (${maxSessionHours} h) is over it.`,
    };
  }
  if (balanceUsd !== null && balanceUsd < session) {
    return {
      ok: false,
      reason: `The Verda balance $${usd(balanceUsd)} does not cover a full session ($${usd(session)}).`,
    };
  }
  return { ok: true };
}

/** Verda bills prepaid 10-minute blocks; we assume no refund of the unused part. */
export function sessionCostUsd(minutes: number, priceUsdH: number): number {
  const blocks = Math.ceil(Math.max(0, minutes) / 10);
  return round4((blocks * 10 * priceUsdH) / 60);
}

/**
 * Minutes to bill for a box we did not see go: at most its lifetime, since
 * the watchdog deletes it by then.
 */
export function settleMinutes(startedAtMs: number, nowMs: number): number {
  const elapsed = Math.ceil(Math.max(0, nowMs - startedAtMs) / 60_000);
  return Math.min(elapsed, MAX_LIFETIME_HOURS * 60);
}

// --------------------------------------------------------------- watchdog

export type WatchdogDecision = "keep" | "delete-idle" | "delete-lifetime";

/**
 * The box's own rule, run every minute on it. Lifetime counts from boot and
 * wins over idle. Idle counts from the last authenticated request, or with
 * none yet from boot (or from when setup finished, `readyS`, when known: a
 * GPU box spends a while installing before anyone can call it).
 */
export function watchdogDecision(input: {
  nowS: number;
  bootS: number;
  lastRequestS: number | null;
  readyS?: number | null;
}): WatchdogDecision {
  const { nowS, bootS, lastRequestS } = input;
  if (nowS - bootS >= MAX_LIFETIME_HOURS * 3600) return "delete-lifetime";
  const since = Math.max(bootS, input.readyS ?? bootS, lastRequestS ?? bootS);
  if (nowS - since >= IDLE_MINUTES * 60) return "delete-idle";
  return "keep";
}

// ---------------------------------------------------------- Verda bodies

/** Create and ssh-key calls answer with the id as a JSON string, or as {id}. */
export function idFromBody(body: unknown): string | null {
  if (typeof body === "string" && body !== "") return body;
  if (typeof body === "object" && body !== null) {
    const id = (body as { id?: unknown }).id;
    if (typeof id === "string" && id !== "") return id;
  }
  return null;
}

const GONE_STATUSES = new Set(["discontinued", "notfound", "deleted"]);

export function isGone(status: string | null, httpStatus: number): boolean {
  return httpStatus === 404 || (status !== null && GONE_STATUSES.has(status));
}

/** The statuses that mean the box will never come up. */
export const FAILED_STATUSES = new Set(["error", "no_capacity", "installation_failed", "discontinued", "notfound"]);

/** Helsinki only. */
export const LOCATIONS = ["FIN-01", "FIN-02", "FIN-03"] as const;

export function pickLocation(availability: unknown, instanceType: string): string | null {
  if (!Array.isArray(availability)) return null;
  for (const location of LOCATIONS) {
    const entry = availability.find(
      (row) => typeof row === "object" && row !== null && (row as { location_code?: unknown }).location_code === location,
    ) as { availabilities?: unknown } | undefined;
    if (entry !== undefined && Array.isArray(entry.availabilities) && entry.availabilities.includes(instanceType)) {
      return location;
    }
  }
  return null;
}

export const GPU_IMAGES = ["24.04.cuda12.9", "24.04.cuda13.0", "ubuntu-24.04-cuda-12.6"] as const;

export function pickImage(images: unknown, gpu: boolean): string | null {
  if (!Array.isArray(images)) return null;
  const types = images
    .map((image) => (typeof image === "object" && image !== null ? (image as { image_type?: unknown }).image_type : null))
    .filter((type): type is string => typeof type === "string");
  if (gpu) return GPU_IMAGES.find((pref) => types.includes(pref)) ?? null;
  const ubuntu = types.filter((type) => /ubuntu|^\d\d\.\d\d/i.test(type) && !/cuda/i.test(type));
  return ubuntu.find((type) => type.includes("24.04")) ?? ubuntu[0] ?? null;
}

/** price_per_hour of one type from the public GET /instance-types. */
export function priceOf(types: unknown, instanceType: string): number | null {
  if (!Array.isArray(types)) return null;
  const row = types.find(
    (entry) => typeof entry === "object" && entry !== null && (entry as { instance_type?: unknown }).instance_type === instanceType,
  ) as { price_per_hour?: unknown } | undefined;
  const price = Number(row?.price_per_hour);
  return Number.isFinite(price) && price > 0 ? price : null;
}

export function baseUrlFor(ip: string): string {
  return `https://${ip.replace(/\./g, "-")}.sslip.io`;
}

export function hostnameFor(at: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `jev-${two(at.getUTCMonth() + 1)}${two(at.getUTCDate())}-${two(at.getUTCHours())}${two(at.getUTCMinutes())}`;
}

// ------------------------------------------------------------------ ledger

export interface LedgerRow {
  at: string;
  instanceId: string;
  type: string;
  minutes: number;
  usd: number;
  note: string;
}

export function parseLedger(text: string | null): LedgerRow[] {
  if (text === null) return [];
  const rows: LedgerRow[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row = JSON.parse(line) as LedgerRow;
      if (typeof row.usd === "number" && Number.isFinite(row.usd)) rows.push(row);
    } catch {
      // A torn line is skipped, never guessed at; the next up still counts every whole row.
    }
  }
  return rows;
}

export function ledgerTotal(rows: readonly LedgerRow[]): number {
  return round4(rows.reduce((sum, row) => sum + row.usd, 0));
}

export function ledgerLine(row: LedgerRow): string {
  return `${JSON.stringify(row)}\n`;
}

// ------------------------------------------------------------ env and keys

export const CLIENTS = ["orchestrator", "app"] as const;
export type Client = (typeof CLIENTS)[number];
export const clientKeyVar = (client: Client) => `JEV_KEY_${client.toUpperCase()}`;
export const VERDA_VARS = ["VERDA_CLIENT_ID", "VERDA_CLIENT_SECRET"] as const;

/** KEY=value lines; quotes around a value are dropped. Comments and blanks are skipped. */
export function parseEnv(text: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (text === null) return out;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match === null) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

/** An env file bash can source: every value single-quoted; refuses values it cannot quote safely. */
export function renderEnv(vars: Readonly<Record<string, string>>): string {
  return Object.entries(vars)
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Bad env name ${key}.`);
      if (/['\n\r\0]/.test(value)) throw new Error(`${key} holds a character the env file cannot carry.`);
      return `${key}='${value}'\n`;
    })
    .join("");
}

export function missingVars(env: Readonly<Record<string, string>>, names: readonly string[]): string[] {
  return names.filter((name) => (env[name] ?? "") === "");
}

/** A client key: 32 random bytes as hex. */
export const isClientKey = (value: string | undefined) => value !== undefined && /^[0-9a-f]{64}$/.test(value);

// ------------------------------------------------------------------ helpers

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

export function usd(n: number): string {
  return n.toFixed(2);
}
