// Headroom (https://github.com/headroomlabs-ai/headroom, Apache-2.0, PyPI
// headroom-ai): a local proxy that compresses what Claude Code sends, put in
// front of The Orchestrator's own agents. Pure; headroom.test.ts pins it.
// host.ts does the IO: install, start and stop, health and stats.
//
// The rules:
//   - Per thread, never through settings files. server.ts gives
//     ANTHROPIC_BASE_URL (agentEnv) through bb's provider env to a Patches
//     chat, task, research or build thread only, only while Headroom is not
//     stopped and the relay answered its health check in the last
//     ROUTE_FRESH_MS. Every other thread, the owner's own sessions included,
//     gets nothing. No code writes the key into a settings file; the only
//     settings code left removes the key the first version wrote
//     (cleanupSettingsText).
//   - Agents point at the relay (headroomrelay.ts, RELAY_PORT), never at
//     Headroom (HEADROOM_PORT). The relay sends each request to Headroom while
//     it is healthy, else straight to Anthropic, so a Headroom crash, restart
//     or stop costs at most the requests in flight to it.
//   - Stop, in order (stopPlan): stopped first, so new threads go direct;
//     then Headroom; the relay last, and only once no Orchestrator agent turn
//     is active and nothing is in flight through it. The beat restarts a dead
//     relay at once while not stopped.
//   - Its upload of anonymous session summaries (the beacon) and telemetry
//     are always off, and both listen on 127.0.0.1 only.
//   - A pinned version, installed with uv on Python 3.12 (the Mac's python3
//     may be older), [proxy] only: [all] pulls in torch and models.
//   - Both run detached in their own process groups with pid files, so a
//     plugin reload (every land) does not stop them; a new host adopts them.
//     Only a pid whose command line is ours (isHeadroomProxy, isHeadroomRelay)
//     is ever signalled.
//   - The liveness beat runs headroomStep: install (at most once an hour
//     after a failure), start, restart after two unhealthy beats or over
//     MAX_RSS_BYTES, at most MAX_STARTS starts per START_WINDOW_MS. Past
//     that it stays down (the relay goes direct), and after OWNER_AFTER_MS
//     down it is one Needs you item with the log path.
//   - Never change what Claude Code sends (tool results, user messages, the
//     tools list) and never add a tool. Headroom 0.39.1 cannot run that way:
//     with every flag that leaves it anything to do it still rewrites the
//     tools list (headroomproxy.test.ts). So it is off for good
//     (OFF_FOR_GOOD): the beat never starts it, start refuses, no thread is
//     routed. The machinery stays, pinned by its tests, for a version that
//     passes headroomproxy.test.ts.

import { RELAY_HEALTH_PATH, RELAY_VERSION, relayArgs } from "./headroomrelay.js";

const join = (...parts: string[]) => parts.join("/").replace(/\/+/g, "/");

export const HEADROOM_VERSION = "0.39.1";
export const HEADROOM_PACKAGE = `headroom-ai[proxy]==${HEADROOM_VERSION}`;
export const HEADROOM_PYTHON = "3.12";
export const HEADROOM_HOST = "127.0.0.1";
/** What agents' ANTHROPIC_BASE_URL names: the relay. */
export const RELAY_PORT = 8791;
export const RELAY_URL = `http://${HEADROOM_HOST}:${RELAY_PORT}`;
/** Headroom itself, behind the relay; only the relay and the host's probes call it. */
export const HEADROOM_PORT = 8792;
export const HEADROOM_URL = `http://${HEADROOM_HOST}:${HEADROOM_PORT}`;
export const BASE_URL_KEY = "ANTHROPIC_BASE_URL";
/** What the first version wrote into settings.local.json; cleanupSettingsText removes exactly this. */
export const LEGACY_SETTINGS_URL = "http://127.0.0.1:8791";

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
/** The relay's health check (agentEnv's reading) answers within this or counts as down. */
export const RELAY_PROBE_TIMEOUT_MS = 500;
/** A relay reading older than this is checked again before a thread is routed. */
export const ROUTE_FRESH_MS = 10_000;
/** Relay beats in a row with a live pid but no health answer before it is restarted. */
export const RELAY_UNHEALTHY_BEATS = 2;

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
  /** The relay, copied here from headroomrelay.ts so a land never changes the running file. */
  relayScript: string;
  relayLog: string;
  relayPidFile: string;
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
    relayScript: join(dir, "relay.mts"),
    relayLog: join(dir, "relay.log"),
    relayPidFile: join(dir, "relay.pid"),
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

/**
 * Why Headroom stays off, or null once a pinned version passes
 * headroomproxy.test.ts. On 4 Oct 2026 0.39.1 garbled agents' tool output and
 * reports, and put a headroom_retrieve tool reference into a chat's history
 * that jammed every later turn once Headroom stopped (400 "Tool reference
 * 'headroom_retrieve' not found in available tools").
 */
export const OFF_FOR_GOOD: string | null = "it altered tool output";
export const OFF_FOR_GOOD_REFUSAL = "Headroom stays off: it cannot run without changing tool output";

/**
 * The strictest settings 0.39.1 has. Each of these fails
 * headroomproxy.test.ts when removed: every tool's results protected ('*';
 * without it a failing-test log loses its repeated lines to "... (repeated
 * 30 times)"), and, in SAFETY_ENV, its default "coding" savings profile's
 * cross-turn dedup (a log seen before becomes "[↑316L same as msg 6: ...]")
 * and server-side tool search (it adds a tool_search tool and defers the
 * others, which is how a tool_reference to headroom_retrieve got into a
 * chat's history on 4 Oct). --no-ccr (no retrieval markers, no
 * headroom_retrieve tool) is kept against that tool though the test cannot
 * show it: with nothing compressed there is nothing to retrieve. Even so,
 * whenever it optimises at all it sorts the tools list and collapses the
 * whitespace in tool descriptions (proxy/tool_schema_compaction.py, no
 * setting), so OFF_FOR_GOOD holds; only --no-optimize keeps the request
 * intact, and then Headroom has nothing left to do.
 */
export const SAFETY_FLAGS: readonly string[] = ["--no-ccr", "--protect-tool-results", "*"];
export const SAFETY_ENV: Readonly<Record<string, string>> = {
  HEADROOM_TOOL_SEARCH: "0",
  HEADROOM_DEDUPE: "0",
};

/** Headroom's argv after the binary (runArgv; headroomproxy.test.ts runs the same). */
export function headroomArgs(port: number): string[] {
  return ["proxy", "--host", HEADROOM_HOST, "--port", String(port), "--mode", "cache", ...SAFETY_FLAGS];
}

export function runArgv(paths: HeadroomPaths): string[] {
  return [paths.bin, ...headroomArgs(HEADROOM_PORT)];
}

/** headroom_control: why it refuses, or null. Stop always goes through. */
export function controlRefusal(action: "start" | "stop", offForGood: string | null = OFF_FOR_GOOD): string | null {
  return action === "start" && offForGood !== null ? OFF_FOR_GOOD_REFUSAL : null;
}

/** The relay's command: node on the copied script, 127.0.0.1 only, in front of Headroom's port. */
export function relayArgv(paths: HeadroomPaths, node: string): string[] {
  return [node, paths.relayScript, ...relayArgs({ host: HEADROOM_HOST, port: RELAY_PORT, headroomPort: HEADROOM_PORT })];
}

/**
 * The proxy's environment: the host's, minus a base URL pointing at the
 * relay or the proxy (it would call itself), with the safety and privacy
 * keys last so nothing turns them back on.
 */
export function runEnv(base: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value;
  if (isOurUrl(env[BASE_URL_KEY])) delete env[BASE_URL_KEY];
  return { ...env, ...SAFETY_ENV, ...PRIVACY_ENV };
}

/** The relay's environment: PATH and HOME only; it needs nothing else and is given no secrets. */
export function relayEnv(base: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME"]) {
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

const OUR_DIR = String.raw`/\.local/share/the-orchestrator/headroom/`;

/**
 * Our proxy in a ps command line, as the command starts (never a shell or an
 * agent that mentions it): our venv's headroom script, or our venv's python
 * running headroom.cli or that script, with `proxy`. On this Mac it shows as
 * `<home>/.local/share/the-orchestrator/headroom/venv/bin/python -m headroom.cli proxy --host ...`.
 */
const PROXY = new RegExp(
  String.raw`^\S*${OUR_DIR}venv/bin/(?:headroom|python[0-9.]*\s+(?:-m\s+headroom\.cli|\S*${OUR_DIR}venv/bin/headroom))\s+proxy(?:\s|$)`,
);
export function isHeadroomProxy(command: string): boolean {
  return PROXY.test(command);
}

/** Our relay in a ps command line: node on our copied relay.mts with the relay flag. */
const RELAY = new RegExp(String.raw`^\S*node\S*\s+(?:--\S+\s+)*\S*${OUR_DIR}relay\.mts\s+--orchestrator-relay(?:\s|$)`);
export function isHeadroomRelay(command: string): boolean {
  return RELAY.test(command);
}

/** Either of ours: counted in the agent tree, never killed by the memory guard. */
export function isHeadroomProcess(command: string): boolean {
  return isHeadroomProxy(command) || isHeadroomRelay(command);
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
  /** Whether Headroom is healthy now: the relay sends to it (it checks for itself too). */
  up: boolean;
  state: HeadroomState;
};

function down(state: HeadroomState, now: number, reason: string): HeadroomState {
  return { ...state, downSince: state.downSince ?? now, reason };
}

/** The decision for one liveness beat. Off for good is stopped, whatever the state file says. */
export function headroomStep(state: HeadroomState, facts: BeatFacts, offForGood: string | null = OFF_FOR_GOOD): BeatDecision {
  const { now } = facts;
  const starts = state.starts.filter((at) => now - at < START_WINDOW_MS);
  const base = { ...state, starts, stopped: state.stopped || offForGood !== null };
  const canStart = starts.length < MAX_STARTS;
  const capped = (s: HeadroomState): BeatDecision => ({
    action: "none",
    up: false,
    state: down(s, now, `restarted ${MAX_STARTS} times in ${START_WINDOW_MS / 60_000} min; staying down`),
  });
  const started = (s: HeadroomState, action: "start" | "restart", reason: string): BeatDecision => ({
    action,
    up: false,
    state: { ...down(s, now, reason), starts: [...s.starts, now], unhealthyBeats: 0 },
  });

  if (base.stopped) return { action: "none", up: false, state: { ...base, unhealthyBeats: 0, downSince: null, reason: "stopped" } };
  if (facts.installing) return { action: "none", up: false, state: down(base, now, "installing") };
  if (!facts.installed) {
    if (state.installFailedAt !== null && now - state.installFailedAt < INSTALL_RETRY_MS) {
      return { action: "none", up: false, state: down(base, now, `install failed: ${state.installError ?? "unknown error"}`) };
    }
    return { action: "install", up: false, state: down(base, now, "installing") };
  }
  const lastStart = starts[starts.length - 1] ?? null;
  const ok = { ...base, installFailedAt: null, installError: null };
  if (facts.health.healthy) {
    if (facts.rssBytes !== null && facts.rssBytes > MAX_RSS_BYTES) {
      return canStart ? started(ok, "restart", "restarting: it grew past 1.5 GB") : capped(ok);
    }
    return { action: "none", up: true, state: { ...ok, unhealthyBeats: 0, downSince: null, reason: null } };
  }
  if (facts.pid === null) {
    return canStart ? started(ok, "start", lastStart === null ? "starting" : `restarting: ${facts.health.reason}`) : capped(ok);
  }
  if (lastStart !== null && now - lastStart < STARTUP_GRACE_MS) {
    return { action: "none", up: false, state: down({ ...ok, unhealthyBeats: 0 }, now, "starting") };
  }
  const beats = state.unhealthyBeats + 1;
  if (beats < UNHEALTHY_BEATS) {
    return { action: "none", up: false, state: down({ ...ok, unhealthyBeats: beats }, now, facts.health.reason) };
  }
  return canStart ? started(ok, "restart", `restarting: ${facts.health.reason}`) : capped({ ...ok, unhealthyBeats: beats });
}

// ------------------------------------------------------------------ relay

export type RelayReading = {
  /** It answered GET /__relay/health as our relay. */
  healthy: boolean;
  pid: number | null;
  version: number | null;
  /** Requests it is relaying now; null when it did not say. */
  inFlight: number | null;
};

export const NO_RELAY: RelayReading = { healthy: false, pid: null, version: null, inFlight: null };

/** GET /__relay/health (headroomrelay.ts RelayHealth): healthy is HTTP 200 with ok true and a pid. */
export function parseRelayHealth(status: number | null, body: unknown): RelayReading {
  const root = obj(body);
  if (status !== 200 || root === null || root.ok !== true) return NO_RELAY;
  const pid = typeof root.pid === "number" && Number.isInteger(root.pid) && root.pid > 1 ? root.pid : null;
  if (pid === null) return NO_RELAY;
  const version = typeof root.version === "number" && Number.isInteger(root.version) ? root.version : null;
  return { healthy: true, pid, version, inFlight: count(root.inFlight) };
}

export { RELAY_HEALTH_PATH };

export type RelayFacts = {
  stopped: boolean;
  /** Our relay's live pid (pid file or health, command checked), else null. */
  pid: number | null;
  reading: RelayReading;
  /** The Orchestrator's agent turns running now, across every project. */
  activeAgentTurns: number;
  /** The relay script can be written (the plugin's source is on this machine). */
  canStart: boolean;
  /** Earlier beats in a row with a live pid and no health answer. */
  unhealthyBeats: number;
};

export type RelayAction = "none" | "start" | "restart" | "stop";
export type RelayDecision = { action: RelayAction; unhealthyBeats: number; reason: string | null };

/** Why the relay must stay up now, or null when nothing is using it. */
export function relayBusy(activeAgentTurns: number, reading: RelayReading): string | null {
  if (activeAgentTurns > 0) return `waiting for ${activeAgentTurns} agent turn${activeAgentTurns === 1 ? "" : "s"} to finish`;
  if (reading.inFlight !== null && reading.inFlight > 0) return `waiting for ${reading.inFlight} request${reading.inFlight === 1 ? "" : "s"} in flight`;
  return null;
}

/**
 * The relay's decision for one beat. Not stopped: a dead relay starts at
 * once, a live one that stops answering restarts after RELAY_UNHEALTHY_BEATS,
 * an older version is replaced only when nothing uses it. Stopped: it stops,
 * but never while an agent turn is active or a request is in flight.
 */
export function relayStep(facts: RelayFacts): RelayDecision {
  const { reading, pid } = facts;
  const alive = reading.healthy || pid !== null;
  if (facts.stopped) {
    if (!alive) return { action: "none", unhealthyBeats: 0, reason: null };
    const busy = relayBusy(facts.activeAgentTurns, reading);
    return busy === null ? { action: "stop", unhealthyBeats: 0, reason: null } : { action: "none", unhealthyBeats: 0, reason: busy };
  }
  if (reading.healthy) {
    const outdated = reading.version === null || reading.version < RELAY_VERSION;
    if (outdated && facts.canStart && relayBusy(facts.activeAgentTurns, reading) === null) {
      return { action: "restart", unhealthyBeats: 0, reason: "replacing an older relay" };
    }
    return { action: "none", unhealthyBeats: 0, reason: null };
  }
  if (!facts.canStart) return { action: "none", unhealthyBeats: 0, reason: "the relay script is not on this machine" };
  if (pid === null) return { action: "start", unhealthyBeats: 0, reason: "starting the relay" };
  const beats = facts.unhealthyBeats + 1;
  if (beats < RELAY_UNHEALTHY_BEATS) return { action: "none", unhealthyBeats: beats, reason: "the relay is not answering" };
  return { action: "restart", unhealthyBeats: 0, reason: "restarting the relay: it stopped answering" };
}

export type StopPlan = { stopHeadroom: boolean; stopRelay: boolean; relayWaits: string | null };

/**
 * headroom_control stop, after `stopped` is saved: Headroom goes now (the
 * relay already sends direct when it is down); the relay only once nothing
 * uses it, else a later beat stops it (relayStep).
 */
export function stopPlan(args: { headroomPid: number | null; relayAlive: boolean; activeAgentTurns: number; reading: RelayReading }): StopPlan {
  const busy = args.relayAlive ? relayBusy(args.activeAgentTurns, args.reading) : null;
  return { stopHeadroom: args.headroomPid !== null, stopRelay: args.relayAlive && busy === null, relayWaits: busy };
}

// ------------------------------------------------------------------ routing

export type RouteReading = {
  /** Headroom is not stopped. */
  enabled: boolean;
  /** The relay answered its health check. */
  relayHealthy: boolean;
  /** When this was read. */
  at: number;
};

export type EnvEntry = { name: string; value: string; reason: string };

export function routeFresh(reading: RouteReading | null, now: number): reading is RouteReading {
  return reading !== null && now - reading.at <= ROUTE_FRESH_MS && reading.at <= now + 1_000;
}

/**
 * bb's provider env for one claude-code thread (server.ts registers it with
 * experimental_contributeEnv): ANTHROPIC_BASE_URL at the relay only for one
 * of The Orchestrator's own agent threads, only while Headroom is not
 * stopped and the relay answered in the last ROUTE_FRESH_MS. Anything else,
 * the owner's own sessions first, gets nothing and goes direct.
 */
export function agentEnv(args: { agent: boolean; reading: RouteReading | null; now: number; offForGood?: string | null }): EnvEntry[] {
  if ((args.offForGood === undefined ? OFF_FOR_GOOD : args.offForGood) !== null) return [];
  if (!args.agent || !routeFresh(args.reading, args.now)) return [];
  if (!args.reading.enabled || !args.reading.relayHealthy) return [];
  return [{ name: BASE_URL_KEY, value: RELAY_URL, reason: "The Orchestrator's Headroom relay (fewer tokens; goes direct when Headroom is down)" }];
}

// ------------------------------------------------------------------ settings cleanup

export type CleanupChange = { action: "none" } | { action: "skip"; reason: string } | { action: "write"; text: string } | { action: "delete" };

function isOurUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const url = value.replace(/\/+$/, "");
  return url === RELAY_URL || url === HEADROOM_URL;
}

/** The value check the first version's own removal used: its URL, trailing slashes aside. */
function isLegacyUrl(value: unknown): boolean {
  return typeof value === "string" && value.replace(/\/+$/, "") === LEGACY_SETTINGS_URL;
}

/**
 * Settings without the key the first version wrote: env.ANTHROPIC_BASE_URL
 * removed only when its value is exactly LEGACY_SETTINGS_URL, an emptied env
 * dropped. Null when there is nothing of ours. Every other key is the same
 * object it was; nothing is ever added.
 */
export function withoutLegacyRoute(settings: Record<string, unknown>): Record<string, unknown> | null {
  const env = obj(settings.env);
  if (env === null || !isLegacyUrl(env[BASE_URL_KEY])) return null;
  const rest = { ...env };
  delete rest[BASE_URL_KEY];
  const next = { ...settings };
  if (Object.keys(rest).length === 0) delete next.env;
  else next.env = rest;
  return next;
}

/**
 * The one-time cleanup of a settings.local.json (null: no file): our key
 * out, and the file deleted only when it held nothing but our key. A file
 * that does not parse is left alone.
 */
export function cleanupSettingsText(text: string | null): CleanupChange {
  if (text === null) return { action: "none" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { action: "skip", reason: "does not parse as JSON" };
  }
  const settings = obj(parsed);
  if (settings === null) return { action: "skip", reason: "is not a JSON object" };
  const next = withoutLegacyRoute(settings);
  if (next === null) return { action: "none" };
  const onlyOurs = Object.keys(settings).length === 1 && Object.keys(obj(settings.env) ?? {}).length === 1;
  if (onlyOurs && Object.keys(next).length === 0) return { action: "delete" };
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

/**
 * The board's line and, when it has been down too long, the owner's item.
 * `up`: Headroom is healthy. `relayUp`: the relay answers (agents are routed
 * only then). `relayNote`: why a stopped relay is still up, or why it is down.
 */
export function headroomView(args: {
  state: HeadroomState;
  up: boolean;
  relayUp: boolean;
  relayNote: string | null;
  stats: Stats | null;
  now: number;
  paths: HeadroomPaths;
  offForGood?: string | null;
}): HeadroomView {
  const { state, up, relayUp, relayNote, stats, now, paths } = args;
  const offForGood = args.offForGood === undefined ? OFF_FOR_GOOD : args.offForGood;
  if (offForGood !== null) {
    const relay = relayUp ? ` (the relay stays up, ${relayNote ?? "until nothing uses it"})` : "";
    return { state: "off", line: `Headroom: off for good (${offForGood})${relay}`, needsOwner: null };
  }
  if (state.stopped) {
    const relay = relayUp ? ` (the relay stays up, ${relayNote ?? "until nothing uses it"})` : "";
    return { state: "off", line: `Headroom: off, agents go direct${relay}`, needsOwner: null };
  }
  if (!relayUp) {
    return { state: "down", line: `Headroom: down, agents go direct (${relayNote ?? "the relay is not answering"})`, needsOwner: null };
  }
  if (up) {
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
