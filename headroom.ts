// Headroom (https://github.com/headroomlabs-ai/headroom, Apache-2.0, PyPI
// headroom-ai): a local proxy that compresses what Claude Code sends, put in
// front of every agent The Orchestrator runs. Pure; headroom.test.ts pins it.
// host.ts does the IO: install, start, health and stats, the settings files.
//
// The rules:
//   - Fail open. Agents reach the proxy through ANTHROPIC_BASE_URL in each
//     managed checkout's .claude/settings.local.json, and that key is there
//     only while the proxy is healthy. Down, not installed or stopped: the key
//     is gone and agents go straight to Anthropic. An ANTHROPIC_BASE_URL the
//     owner set is never changed or removed.
//   - Its upload of anonymous session summaries (the beacon) and telemetry
//     are always off, and it listens on 127.0.0.1 only.
//   - A pinned version, installed with uv on Python 3.12 (the Mac's python3
//     may be older), [proxy] only: [all] pulls in torch and models.
//   - It runs detached in its own process group with a pid file, so a plugin
//     reload (every land) does not stop it; a new host adopts it.
//   - The liveness beat runs headroomStep: install (at most once an hour
//     after a failure), start, restart after two unhealthy beats or over
//     MAX_RSS_BYTES, at most MAX_STARTS starts per START_WINDOW_MS. Past
//     that it stays down, and after OWNER_AFTER_MS down it is one Needs you
//     item with the log path.
//   - Cache mode keeps earlier turns byte-identical, so Claude's prompt
//     cache still hits.

const join = (...parts: string[]) => parts.join("/").replace(/\/+/g, "/");

export const HEADROOM_VERSION = "0.39.1";
export const HEADROOM_PACKAGE = `headroom-ai[proxy]==${HEADROOM_VERSION}`;
export const HEADROOM_PYTHON = "3.12";
export const HEADROOM_HOST = "127.0.0.1";
export const HEADROOM_PORT = 8791;
export const HEADROOM_URL = `http://${HEADROOM_HOST}:${HEADROOM_PORT}`;
export const BASE_URL_KEY = "ANTHROPIC_BASE_URL";

/** Off whatever the rest of the environment says: no beacon, no telemetry. */
export const PRIVACY_ENV: Readonly<Record<string, string>> = {
  HEADROOM_BEACON: "off",
  HEADROOM_TELEMETRY: "off",
  DO_NOT_TRACK: "1",
};

/** Unhealthy beats in a row before a restart. */
export const UNHEALTHY_BEATS = 2;
/** A proxy started this recently is still coming up: not unhealthy yet. */
export const STARTUP_GRACE_MS = 90_000;
/** Starts (first and restarts) allowed in START_WINDOW_MS; then it stays down. */
export const MAX_STARTS = 4;
export const START_WINDOW_MS = 15 * 60_000;
/** After a failed install, the next try waits this long. */
export const INSTALL_RETRY_MS = 60 * 60_000;
/** The install (uv, Python, the package) is given this long. */
export const INSTALL_TIMEOUT_MS = 15 * 60_000;
/** Restart the proxy when it holds more than this. */
export const MAX_RSS_BYTES = 1.5 * 1024 ** 3;
/** Down past the start cap this long: one Needs you item. */
export const OWNER_AFTER_MS = 30 * 60_000;
/** /health and /stats answer within this or count as no answer. */
export const PROBE_TIMEOUT_MS = 3_000;

export type HeadroomPaths = {
  dir: string;
  /** pip --target for uv itself. */
  uvTarget: string;
  uv: string;
  uvCache: string;
  pythonInstallDir: string;
  venv: string;
  python: string;
  bin: string;
  log: string;
  installLog: string;
  pidFile: string;
  stateFile: string;
  /** Holds HEADROOM_VERSION once that version installed: a new pin reinstalls. */
  marker: string;
};

/** Everything lives under ~/.local/share/the-orchestrator/headroom: outside every repo, kept across reloads. */
export function headroomPaths(home: string): HeadroomPaths {
  const dir = join(home, ".local", "share", "the-orchestrator", "headroom");
  const venv = join(dir, "venv");
  return {
    dir,
    uvTarget: join(dir, "uv"),
    uv: join(dir, "uv", "bin", "uv"),
    uvCache: join(dir, "uv-cache"),
    pythonInstallDir: join(dir, "python"),
    venv,
    python: join(venv, "bin", "python"),
    bin: join(venv, "bin", "headroom"),
    log: join(dir, "proxy.log"),
    installLog: join(dir, "install.log"),
    pidFile: join(dir, "proxy.pid"),
    stateFile: join(dir, "state.json"),
    marker: join(dir, "installed-version"),
  };
}

export type CommandStep = { argv: string[]; env: Record<string, string>; /** Skipped when this exists. */ creates: string | null };

/** The install, in order: uv into its own folder, a Python 3.12 venv, the pinned package. */
export function installSteps(paths: HeadroomPaths, systemPython = "python3"): CommandStep[] {
  const uvEnv = { UV_PYTHON_INSTALL_DIR: paths.pythonInstallDir, UV_CACHE_DIR: paths.uvCache, ...PRIVACY_ENV };
  return [
    { argv: [systemPython, "-m", "pip", "install", "--disable-pip-version-check", "--target", paths.uvTarget, "uv"], env: { ...PRIVACY_ENV }, creates: paths.uv },
    { argv: [paths.uv, "venv", "-p", HEADROOM_PYTHON, paths.venv], env: uvEnv, creates: paths.python },
    { argv: [paths.uv, "pip", "install", "-p", paths.python, HEADROOM_PACKAGE], env: uvEnv, creates: null },
  ];
}

export function runArgv(paths: HeadroomPaths): string[] {
  return [paths.bin, "proxy", "--host", HEADROOM_HOST, "--port", String(HEADROOM_PORT), "--mode", "cache"];
}

/**
 * The proxy's environment: the host's, minus a base URL pointing at the
 * proxy itself (it would call itself), with the privacy keys last so nothing
 * turns them back on.
 */
export function runEnv(base: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
  if (sameUrl(env[BASE_URL_KEY])) delete env[BASE_URL_KEY];
  return { ...env, ...PRIVACY_ENV };
}

/** Our proxy in a ps command line: the headroom script in our venv, running `proxy`. */
export function isHeadroomProxy(command: string): boolean {
  return /\/the-orchestrator\/headroom\/venv\/bin\/headroom\s+proxy(\s|$)/.test(command);
}

// ------------------------------------------------------------------ probes

export type Health = { healthy: true; pid: number } | { healthy: false; reason: string; pid: number | null };

const obj = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * GET /health: healthy is HTTP 200, checks.startup.ready true and a pid.
 * Upstream readiness is not required: Anthropic being slow is not the proxy's
 * fault, and the agents would see it either way.
 */
export function parseHealth(status: number | null, body: unknown): Health {
  if (status === null) return { healthy: false, reason: "not answering", pid: null };
  const root = obj(body);
  const pidValue = obj(root?.config)?.pid;
  const pid = typeof pidValue === "number" && Number.isInteger(pidValue) && pidValue > 1 ? pidValue : null;
  if (status !== 200) return { healthy: false, reason: `health check answered HTTP ${status}`, pid };
  if (obj(obj(root?.checks)?.startup)?.ready !== true) return { healthy: false, reason: "still starting", pid };
  if (pid === null) return { healthy: false, reason: "health check carries no pid", pid };
  return { healthy: true, pid };
}

export type Stats = { tokensRemoved: number; tokensBefore: number | null; requests: number | null };

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

/**
 * GET /stats: tokens compression actually removed since the proxy started
 * (summary.compression.total_tokens_removed). Never tool_schema_tokens_saved:
 * that is Headroom's estimate, not a measurement. Before-tokens and requests
 * are read where present and null otherwise.
 */
export function parseStats(body: unknown): Stats | null {
  const summary = obj(obj(body)?.summary);
  const compression = obj(summary?.compression);
  const tokensRemoved = count(compression?.total_tokens_removed);
  if (tokensRemoved === null) return null;
  const tokensBefore =
    count(compression?.total_tokens_before) ?? count(compression?.total_original_tokens) ?? count(obj(summary?.totals)?.before_tokens);
  const requests = count(compression?.total_requests) ?? count(summary?.total_requests) ?? count(obj(summary?.totals)?.requests);
  return { tokensRemoved, tokensBefore, requests };
}

// ------------------------------------------------------------------ state

export type HeadroomState = {
  /** Explicitly stopped: nothing starts it again until started. */
  stopped: boolean;
  installFailedAt: number | null;
  installError: string | null;
  /** Start times inside the window, oldest first. */
  starts: number[];
  unhealthyBeats: number;
  /** When it last went from healthy (or never up) to down; null while healthy. */
  downSince: number | null;
  /** Why it is down, for the board. */
  reason: string | null;
};

export const INITIAL_STATE: HeadroomState = {
  stopped: false,
  installFailedAt: null,
  installError: null,
  starts: [],
  unhealthyBeats: 0,
  downSince: null,
  reason: null,
};

/** A state file as read: anything malformed is the initial state. */
export function parseState(text: string | null): HeadroomState {
  if (text === null) return { ...INITIAL_STATE };
  try {
    const raw = obj(JSON.parse(text));
    if (raw === null) return { ...INITIAL_STATE };
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 500) : null);
    return {
      stopped: raw.stopped === true,
      installFailedAt: num(raw.installFailedAt),
      installError: str(raw.installError),
      starts: Array.isArray(raw.starts) ? raw.starts.filter((v): v is number => num(v) !== null).slice(-MAX_STARTS) : [],
      unhealthyBeats: Math.max(0, Math.min(100, num(raw.unhealthyBeats) ?? 0)),
      downSince: num(raw.downSince),
      reason: str(raw.reason),
    };
  } catch {
    return { ...INITIAL_STATE };
  }
}

export type BeatFacts = {
  now: number;
  installed: boolean;
  installing: boolean;
  /** Our proxy's pid when one is alive (pid file or health), else null. */
  pid: number | null;
  health: Health;
  rssBytes: number | null;
};

export type HeadroomAction = "none" | "install" | "start" | "restart";

export type BeatDecision = {
  action: HeadroomAction;
  /** Whether agents go through the proxy now: only while it is healthy. */
  route: boolean;
  state: HeadroomState;
};

function down(state: HeadroomState, now: number, reason: string): HeadroomState {
  return { ...state, downSince: state.downSince ?? now, reason };
}

/** The decision for one liveness beat. */
export function headroomStep(state: HeadroomState, facts: BeatFacts): BeatDecision {
  const { now } = facts;
  const starts = state.starts.filter((at) => now - at < START_WINDOW_MS);
  const base = { ...state, starts };
  const canStart = starts.length < MAX_STARTS;
  const capped = (s: HeadroomState): BeatDecision => ({
    action: "none",
    route: false,
    state: down(s, now, `restarted ${MAX_STARTS} times in ${START_WINDOW_MS / 60_000} min; staying down`),
  });
  const started = (s: HeadroomState, action: "start" | "restart", reason: string): BeatDecision => ({
    action,
    route: false,
    state: { ...down(s, now, reason), starts: [...s.starts, now], unhealthyBeats: 0 },
  });

  if (state.stopped) return { action: "none", route: false, state: { ...base, unhealthyBeats: 0, downSince: null, reason: "stopped" } };
  if (facts.installing) return { action: "none", route: false, state: down(base, now, "installing") };
  if (!facts.installed) {
    if (state.installFailedAt !== null && now - state.installFailedAt < INSTALL_RETRY_MS) {
      return { action: "none", route: false, state: down(base, now, `install failed: ${state.installError ?? "unknown error"}`) };
    }
    return { action: "install", route: false, state: down(base, now, "installing") };
  }
  const lastStart = starts[starts.length - 1] ?? null;
  const ok = { ...base, installFailedAt: null, installError: null };
  if (facts.health.healthy) {
    if (facts.rssBytes !== null && facts.rssBytes > MAX_RSS_BYTES) {
      return canStart ? started(ok, "restart", "restarting: it grew past 1.5 GB") : capped(ok);
    }
    return { action: "none", route: true, state: { ...ok, unhealthyBeats: 0, downSince: null, reason: null } };
  }
  if (facts.pid === null) {
    return canStart ? started(ok, "start", lastStart === null ? "starting" : `restarting: ${facts.health.reason}`) : capped(ok);
  }
  if (lastStart !== null && now - lastStart < STARTUP_GRACE_MS) {
    return { action: "none", route: false, state: down({ ...ok, unhealthyBeats: 0 }, now, "starting") };
  }
  const beats = state.unhealthyBeats + 1;
  if (beats < UNHEALTHY_BEATS) {
    return { action: "none", route: false, state: down({ ...ok, unhealthyBeats: beats }, now, facts.health.reason) };
  }
  return canStart ? started(ok, "restart", `restarting: ${facts.health.reason}`) : capped({ ...ok, unhealthyBeats: beats });
}

// ------------------------------------------------------------------ settings

export type SettingsChange = { action: "write"; text: string } | { action: "none" } | { action: "skip"; reason: string };

function sameUrl(value: unknown): boolean {
  return typeof value === "string" && value.replace(/\/+$/, "") === HEADROOM_URL;
}

/**
 * One settings object with routing on or off: only env.ANTHROPIC_BASE_URL
 * moves, and only when it is absent (on) or exactly ours (off). Null when
 * nothing changes. Every other key is the same object it was.
 */
export function applyRouting(settings: Record<string, unknown>, on: boolean): Record<string, unknown> | null {
  const envValue = settings.env;
  if (envValue !== undefined && obj(envValue) === null) return null;
  const env = obj(envValue) ?? {};
  const current = env[BASE_URL_KEY];
  if (on) {
    if (current !== undefined) return null;
    return { ...settings, env: { ...env, [BASE_URL_KEY]: HEADROOM_URL } };
  }
  if (!sameUrl(current)) return null;
  const rest = { ...env };
  delete rest[BASE_URL_KEY];
  const next = { ...settings };
  if (Object.keys(rest).length === 0) delete next.env;
  else next.env = rest;
  return next;
}

/**
 * A settings.local.json's text (null: no file) with routing on or off. A file
 * that does not parse, or whose env is not an object, is left alone.
 */
export function routeSettingsText(text: string | null, on: boolean): SettingsChange {
  let settings: Record<string, unknown> = {};
  if (text !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { action: "skip", reason: "does not parse as JSON" };
    }
    const record = obj(parsed);
    if (record === null) return { action: "skip", reason: "is not a JSON object" };
    if (record.env !== undefined && obj(record.env) === null) return { action: "skip", reason: "its env is not an object" };
    settings = record;
  } else if (!on) {
    return { action: "none" };
  }
  const next = applyRouting(settings, on);
  if (next === null) return { action: "none" };
  return { action: "write", text: `${JSON.stringify(next, null, 2)}\n` };
}

// ------------------------------------------------------------------ board

export type HeadroomView = {
  state: "on" | "installing" | "starting" | "down" | "off";
  line: string;
  /** Down past the cap for OWNER_AFTER_MS: the one Needs you item; else null. */
  needsOwner: { title: string; body: string; command: string } | null;
};

function short(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** The board's line and, when it has been down too long, the owner's item. */
export function headroomView(args: { state: HeadroomState; route: boolean; stats: Stats | null; now: number; paths: HeadroomPaths }): HeadroomView {
  const { state, route, stats, now, paths } = args;
  if (state.stopped) return { state: "off", line: "Headroom: off", needsOwner: null };
  if (route) {
    if (stats === null) return { state: "on", line: "Headroom: on", needsOwner: null };
    const pct = stats.tokensBefore !== null && stats.tokensBefore > 0 ? ` (${((stats.tokensRemoved / stats.tokensBefore) * 100).toFixed(1)}%)` : "";
    return { state: "on", line: `Headroom: on · ${short(stats.tokensRemoved)} tokens removed${pct}`, needsOwner: null };
  }
  if (state.reason === "installing") return { state: "installing", line: "Headroom: installing…", needsOwner: null };
  if (state.reason === "starting") return { state: "starting", line: "Headroom: starting…", needsOwner: null };
  const reason = state.reason ?? "not answering";
  const capped = state.starts.filter((at) => now - at < START_WINDOW_MS).length >= MAX_STARTS || state.installFailedAt !== null;
  const long = state.downSince !== null && now - state.downSince > OWNER_AFTER_MS;
  return {
    state: "down",
    line: `Headroom: down, agents go direct (${reason})`,
    needsOwner:
      capped && long
        ? {
            title: "Headroom is down",
            body: `The token proxy has been down for over ${OWNER_AFTER_MS / 60_000} minutes (${reason}); agents go straight to Claude meanwhile. Read its log to see why, then tell Patches what you find.`,
            command: `tail -n 100 ${shellQuote(state.installFailedAt !== null ? paths.installLog : paths.log)}`,
          }
        : null,
  };
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}
