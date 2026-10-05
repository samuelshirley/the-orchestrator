// What is left of Headroom, removed on 5 Oct 2026 (CLAUDE.md, docs/how-it-works.md
// "Removed: Headroom"). Pure; legacyroute.test.ts pins it. Two leftovers:
//
//   - The settings key. Its first version wrote ANTHROPIC_BASE_URL into
//     worktrees' .claude/settings.local.json; host writeBuilderGuard drops it
//     from a reused worktree (withoutLegacyRoute), only where the value is
//     exactly that URL. An owner-set gateway is never touched.
//   - The running pieces. Its relay (127.0.0.1:8791, detached, survives
//     reloads) and proxy (8792) may outlive the code that started them, and
//     its install dir (venv, uv, state, logs) stays on disk. The host retires
//     them once, on the liveness beat (retirePlan): the proxy at once; the
//     relay only while no Orchestrator agent turn runs and nothing is in
//     flight through it (bb applies a thread's contributed env per turn and
//     rebuilds the Claude session when it changed, so once the turns that
//     started routed are over, nothing points at 8791); the dir only after
//     both are confirmed gone, and only that exact path. Only a pid whose
//     command line is theirs (isLegacyProxy, isLegacyRelay) is signalled.

const join = (...parts: string[]) => parts.join("/").replace(/\/+/g, "/");

const obj = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export const BASE_URL_KEY = "ANTHROPIC_BASE_URL";
/** What the first version wrote into settings.local.json; withoutLegacyRoute removes exactly this. */
export const LEGACY_SETTINGS_URL = "http://127.0.0.1:8791";

/** The value check: that URL, trailing slashes aside. */
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

// ------------------------------------------------------------------ retirement

export const LEGACY_RELAY_URL = "http://127.0.0.1:8791";
export const LEGACY_PROXY_URL = "http://127.0.0.1:8792";
export const LEGACY_RELAY_HEALTH_PATH = "/__relay/health";

export type LegacyPaths = { dir: string; proxyPidFile: string; relayPidFile: string };

/** The install dir and its pid files: <home>/.local/share/the-orchestrator/headroom. */
export function legacyPaths(home: string): LegacyPaths {
  const dir = join(home, ".local", "share", "the-orchestrator", "headroom");
  return { dir, proxyPidFile: join(dir, "proxy.pid"), relayPidFile: join(dir, "relay.pid") };
}

/**
 * Whether `dir` is exactly the install dir under `home`, and so the one path
 * the retirement may remove. Anything else, wider or not, is refused: a home
 * that is not absolute, is the root, or carries `..`, and any other path.
 */
export function removableDir(dir: string, home: string): boolean {
  if (!home.startsWith("/") || home.replace(/\/+$/, "") === "" || home.split("/").includes("..")) return false;
  return dir === legacyPaths(home).dir;
}

const OUR_DIR = String.raw`/\.local/share/the-orchestrator/headroom/`;

/**
 * The proxy in a ps command line, as the command starts (never a shell or an
 * agent that mentions it): the install's own venv script, or its python
 * running the CLI module or that script, with `proxy`.
 */
const PROXY = new RegExp(
  String.raw`^\S*${OUR_DIR}venv/bin/(?:headroom|python[0-9.]*\s+(?:-m\s+headroom\.cli|\S*${OUR_DIR}venv/bin/headroom))\s+proxy(?:\s|$)`,
);
export function isLegacyProxy(command: string): boolean {
  return PROXY.test(command);
}

/** The relay in a ps command line: node on the install's relay.mts with the relay flag. */
const RELAY = new RegExp(String.raw`^\S*node\S*\s+(?:--\S+\s+)*\S*${OUR_DIR}relay\.mts\s+--orchestrator-relay(?:\s|$)`);
export function isLegacyRelay(command: string): boolean {
  return RELAY.test(command);
}

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
const pidOf = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value > 1 ? value : null);

/** The relay's GET /__relay/health: its pid and requests in flight when it answered as the relay (200, ok true, a pid); else null. */
export function parseLegacyRelayHealth(status: number | null, body: unknown): { pid: number; inFlight: number | null } | null {
  const root = obj(body);
  if (status !== 200 || root === null || root.ok !== true) return null;
  const pid = pidOf(root.pid);
  return pid === null ? null : { pid, inFlight: count(root.inFlight) };
}

/** The proxy's GET /health: the pid it names (config.pid), whatever its status; null when it names none. */
export function parseLegacyProxyHealth(status: number | null, body: unknown): number | null {
  if (status === null) return null;
  return pidOf(obj(obj(body)?.config)?.pid);
}

export type RetireFacts = {
  /** The pid the proxy's health names, or null when nothing answered as it. */
  proxyNamed: number | null;
  /** The proxy's pid, from its health or pid file, only when ps shows our command line. */
  proxyPid: number | null;
  /** The relay's health, or null when nothing answered as it. */
  relay: { pid: number; inFlight: number | null } | null;
  /** The relay's pid, from its health or pid file, only when ps shows our command line. */
  relayPid: number | null;
  /** The Orchestrator's agent turns running now, across every project. */
  activeAgentTurns: number;
  dirExists: boolean;
};

export type RetirePlan = {
  stopProxy: boolean;
  stopRelay: boolean;
  /** Both confirmed gone and the dir still there: remove it, that path only. */
  removeDir: boolean;
  /** Why something stays this beat, or null. */
  waits: string | null;
  /** Nothing of it runs; once the dir is gone too, nothing is left to do. */
  gone: boolean;
};

/**
 * One beat of the retirement. The proxy stops at once (nothing points at it
 * but the relay, which goes direct without it). The relay stops only while no
 * agent turn runs and nothing is in flight. Anything that answers as one of
 * them but whose pid ps cannot confirm is left alone and keeps the dir. The
 * dir goes only on a beat that found both gone before stopping anything, so
 * a stop is always re-checked on the next beat first.
 */
export function retirePlan(f: RetireFacts): RetirePlan {
  const proxyAlive = f.proxyPid !== null || f.proxyNamed !== null;
  const relayAlive = f.relayPid !== null || f.relay !== null;
  const waits: string[] = [];
  let stopRelay = false;
  if (relayAlive) {
    const inFlight = f.relay?.inFlight ?? 0;
    if (f.relayPid === null) waits.push("something answers on 8791 as the relay, but ps does not show its command line");
    else if (f.activeAgentTurns > 0) waits.push(`the relay waits for ${f.activeAgentTurns} agent turn${f.activeAgentTurns === 1 ? "" : "s"} to finish`);
    else if (inFlight > 0) waits.push(`the relay waits for ${inFlight} request${inFlight === 1 ? "" : "s"} in flight`);
    else stopRelay = true;
  }
  if (proxyAlive && f.proxyPid === null) waits.push("something answers on 8792 as the proxy, but ps does not show its command line");
  const gone = !proxyAlive && !relayAlive;
  return {
    stopProxy: f.proxyPid !== null,
    stopRelay,
    removeDir: gone && f.dirExists,
    waits: waits.length === 0 ? null : waits.join("; "),
    gone,
  };
}
