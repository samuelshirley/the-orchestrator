import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  BASE_URL_KEY,
  HEADROOM_URL,
  INITIAL_STATE,
  LEGACY_SETTINGS_URL,
  NO_RELAY,
  RELAY_URL,
  ROUTE_FRESH_MS,
  INSTALL_RETRY_MS,
  MAX_RSS_BYTES,
  MAX_STARTS,
  OFF_FOR_GOOD,
  OFF_FOR_GOOD_REFUSAL,
  OWNER_AFTER_MS,
  SAFETY_ENV,
  SAFETY_FLAGS,
  START_WINDOW_MS,
  STARTUP_GRACE_MS,
  agentEnv,
  cleanupSettingsText,
  controlRefusal,
  headroomArgs,
  headroomPaths,
  headroomStep,
  headroomView,
  installSteps,
  isHeadroomProcess,
  isHeadroomProxy,
  isHeadroomRelay,
  parseHealth,
  parseRelayHealth,
  parseState,
  parseStats,
  relayArgv,
  relayEnv,
  relayStep,
  runArgv,
  runEnv,
  stopPlan,
  withoutLegacyRoute,
  type BeatFacts,
  type HeadroomState,
  type RelayFacts,
  type RelayReading,
} from "./headroom";
import { RELAY_VERSION, parseRelayArgs } from "./headroomrelay";

const paths = headroomPaths("/Users/sam");
const NOW = 1_800_000_000_000;
const HEALTHY = parseHealth(200, { status: "healthy", ready: true, checks: { startup: { ready: true }, upstream: { ready: false } }, config: { pid: 4242 } });

describe("install and run commands", () => {
  it("installs the pinned [proxy] package with uv on Python 3.12, all under the install dir", () => {
    const steps = installSteps(paths);
    expect(steps.map((s) => s.argv)).toEqual([
      ["python3", "-m", "pip", "install", "--disable-pip-version-check", "--target", `${paths.dir}/uv`, "uv"],
      [`${paths.dir}/uv/bin/uv`, "venv", "-p", "3.12", `${paths.dir}/venv`],
      [`${paths.dir}/uv/bin/uv`, "pip", "install", "-p", `${paths.dir}/venv/bin/python`, "headroom-ai[proxy]==0.39.1"],
    ]);
    expect(steps[1]!.env.UV_PYTHON_INSTALL_DIR).toBe(`${paths.dir}/python`);
    expect(steps.flatMap((s) => s.argv).join(" ")).not.toMatch(/\[all\]/);
    expect(paths.dir).toBe("/Users/sam/.local/share/the-orchestrator/headroom");
  });
  it("binds 127.0.0.1 only, Headroom on 8792 behind the relay on 8791, in cache mode with the safety flags", () => {
    const argv = runArgv(paths);
    expect(argv).toEqual([`${paths.dir}/venv/bin/headroom`, "proxy", "--host", "127.0.0.1", "--port", "8792", "--mode", "cache", ...SAFETY_FLAGS]);
    expect(argv.slice(1)).toEqual(headroomArgs(8792));
    expect(argv).not.toContain("0.0.0.0");
    expect(HEADROOM_URL).toBe("http://127.0.0.1:8792");
    expect(RELAY_URL).toBe("http://127.0.0.1:8791");
    const relay = relayArgv(paths, "/opt/homebrew/bin/node");
    expect(relay).toEqual([
      "/opt/homebrew/bin/node",
      `${paths.dir}/relay.mts`,
      "--orchestrator-relay",
      "--host",
      "127.0.0.1",
      "--port",
      "8791",
      "--headroom-port",
      "8792",
    ]);
    expect(parseRelayArgs(relay.slice(2))).toEqual({ host: "127.0.0.1", port: 8791, headroomPort: 8792 });
  });
  it("never touches a tool result, never uses CCR, never runs in token mode", () => {
    const args = headroomArgs(8792);
    expect(args).toContain("--no-ccr");
    expect(args[args.indexOf("--protect-tool-results") + 1]).toBe("*");
    expect(args).not.toContain("token");
    expect(args).not.toContain("--anthropic-api-url");
  });
  it("turns off cross-turn dedup and server-side tool search, whatever the host's environment says", () => {
    expect(SAFETY_ENV).toEqual({ HEADROOM_TOOL_SEARCH: "0", HEADROOM_DEDUPE: "0" });
    expect(runEnv({ HEADROOM_TOOL_SEARCH: "1", HEADROOM_DEDUPE: "1" })).toMatchObject(SAFETY_ENV);
  });
  it("gives the relay PATH and HOME only: no keys, no base URL", () => {
    expect(relayEnv({ PATH: "/usr/bin", HOME: "/Users/sam", ANTHROPIC_API_KEY: "sk-x", JEV_API_KEY: "j", ANTHROPIC_BASE_URL: RELAY_URL })).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/sam",
    });
  });
  it("always runs with the beacon and telemetry off, whatever the host's environment says", () => {
    const env = runEnv({ PATH: "/usr/bin", HEADROOM_BEACON: "on", HEADROOM_TELEMETRY: "on", DO_NOT_TRACK: "0" });
    expect(env).toMatchObject({ PATH: "/usr/bin", HEADROOM_BEACON: "off", HEADROOM_TELEMETRY: "off", DO_NOT_TRACK: "1" });
    for (const step of installSteps(paths)) expect(step.env).toMatchObject({ HEADROOM_BEACON: "off", HEADROOM_TELEMETRY: "off", DO_NOT_TRACK: "1" });
  });
  it("never points the proxy at itself or the relay, but keeps another upstream", () => {
    expect(runEnv({ ANTHROPIC_BASE_URL: HEADROOM_URL }).ANTHROPIC_BASE_URL).toBeUndefined();
    expect(runEnv({ ANTHROPIC_BASE_URL: `${RELAY_URL}/` }).ANTHROPIC_BASE_URL).toBeUndefined();
    expect(runEnv({ ANTHROPIC_BASE_URL: "https://gw.example.com" }).ANTHROPIC_BASE_URL).toBe("https://gw.example.com");
  });
});

describe("ps matchers", () => {
  // Exactly as ps shows them on the owner's Mac.
  const REAL_PROXY = "/Users/samuelashirley/.local/share/the-orchestrator/headroom/venv/bin/python -m headroom.cli proxy --host 127.0.0.1 --port 8791 --mode cache";
  const SCRIPT_PROXY = "/Users/samuelashirley/.local/share/the-orchestrator/headroom/venv/bin/headroom proxy --host 127.0.0.1 --port 8792 --mode cache";
  const RELAY = "/opt/homebrew/bin/node /Users/samuelashirley/.local/share/the-orchestrator/headroom/relay.mts --orchestrator-relay --host 127.0.0.1 --port 8791 --headroom-port 8792";
  it("knows our proxy in both forms, and through the venv's python running the script", () => {
    expect(isHeadroomProxy(REAL_PROXY)).toBe(true);
    expect(isHeadroomProxy(SCRIPT_PROXY)).toBe(true);
    expect(isHeadroomProxy(`${paths.python} ${runArgv(paths).join(" ")}`)).toBe(true);
    expect(isHeadroomProxy(`${paths.python}3.12 -m headroom.cli proxy`)).toBe(true);
    expect(isHeadroomProxy(`${paths.bin} proxy`)).toBe(true);
  });
  it("knows our relay, with or without node flags", () => {
    expect(isHeadroomRelay(RELAY)).toBe(true);
    expect(isHeadroomRelay(relayArgv(paths, "node").join(" "))).toBe(true);
    expect(isHeadroomRelay(`/usr/local/bin/node --no-warnings ${paths.relayScript} --orchestrator-relay --port 8791`)).toBe(true);
    expect(isHeadroomProcess(RELAY) && isHeadroomProcess(REAL_PROXY)).toBe(true);
  });
  it("never matches another venv's headroom, another subcommand, or an agent running headroom elsewhere", () => {
    expect(isHeadroomProxy("/Users/samuelashirley/other/venv/bin/headroom proxy --port 8787")).toBe(false);
    expect(isHeadroomProxy("/Users/samuelashirley/proj/.venv/bin/python -m headroom.cli proxy --port 8787")).toBe(false);
    expect(isHeadroomProxy("/tmp/x/bin/headroom proxy")).toBe(false);
    expect(isHeadroomProxy("headroom proxy --host 127.0.0.1 --port 8791")).toBe(false);
    expect(isHeadroomProxy(`/bin/zsh -c ${SCRIPT_PROXY}`)).toBe(false);
    expect(isHeadroomProxy(`bash -c "${REAL_PROXY}"`)).toBe(false);
    expect(isHeadroomProxy(`${paths.bin} stats`)).toBe(false);
    expect(isHeadroomProxy(`${paths.python} -m headroom.cli stats`)).toBe(false);
    expect(isHeadroomProxy(`${paths.python} -m headroom.cli proxyx`)).toBe(false);
    expect(isHeadroomProxy("/Users/x/the-orchestrator/headroom/venv/bin/headroom proxy")).toBe(false);
  });
  it("never takes a shell, another script or a copy elsewhere for the relay", () => {
    expect(isHeadroomRelay(`/bin/sh -c "node ${paths.relayScript} --orchestrator-relay"`)).toBe(false);
    expect(isHeadroomRelay(`node /tmp/relay.mts --orchestrator-relay`)).toBe(false);
    expect(isHeadroomRelay(`node ${paths.relayScript}`)).toBe(false);
    expect(isHeadroomRelay(`node /Users/me/Github/the-orchestrator/headroomrelay.ts --orchestrator-relay`)).toBe(false);
    expect(isHeadroomRelay(REAL_PROXY)).toBe(false);
  });
});

describe("parseHealth", () => {
  it("is healthy on 200 with startup ready and a pid, whatever upstream says", () => {
    expect(HEALTHY).toEqual({ healthy: true, pid: 4242 });
  });
  it("is unhealthy on no answer, a non-200, startup not ready, or no pid", () => {
    expect(parseHealth(null, null)).toMatchObject({ healthy: false, reason: "not answering" });
    expect(parseHealth(503, { checks: { startup: { ready: true } }, config: { pid: 9 } })).toMatchObject({ healthy: false, pid: 9 });
    expect(parseHealth(200, { checks: { startup: { ready: false } }, config: { pid: 9 } })).toMatchObject({ healthy: false, reason: "still starting" });
    expect(parseHealth(200, { checks: { startup: { ready: true } } })).toMatchObject({ healthy: false, pid: null });
    expect(parseHealth(200, "<html>")).toMatchObject({ healthy: false });
    expect(parseHealth(200, { checks: { startup: { ready: "true" } }, config: { pid: 9 } }).healthy).toBe(false);
  });
});

describe("parseStats", () => {
  it("reads tokens compression removed, never the tool-schema estimate", () => {
    const body = { summary: { compression: { total_tokens_removed: 1_200_000, total_tokens_before: 14_000_000, total_requests: 80 }, tool_schema_tokens_saved: 9_999_999 } };
    expect(parseStats(body)).toEqual({ tokensRemoved: 1_200_000, tokensBefore: 14_000_000, requests: 80 });
  });
  it("leaves what it cannot find as null, and is null without the measured number", () => {
    expect(parseStats({ summary: { compression: { total_tokens_removed: 5 } } })).toEqual({ tokensRemoved: 5, tokensBefore: null, requests: null });
    expect(parseStats({ summary: { compression: { tool_schema_tokens_saved: 9 } } })).toBeNull();
    expect(parseStats({ summary: { compression: { total_tokens_removed: -1 } } })).toBeNull();
    expect(parseStats(null)).toBeNull();
  });
});

const facts = (over: Partial<BeatFacts> = {}): BeatFacts => ({
  now: NOW,
  installed: true,
  installing: false,
  pid: 4242,
  health: HEALTHY,
  rssBytes: 200 * 1024 ** 2,
  ...over,
});
const DOWN = parseHealth(null, null);

describe("headroomStep", () => {
  // The machinery, for a version that passes headroomproxy.test.ts; off for good below.
  const runningStep = (state: HeadroomState, f: BeatFacts) => headroomStep(state, f, null);
  it("installs when not installed, and after a failure waits an hour", () => {
    expect(runningStep(INITIAL_STATE, facts({ installed: false, pid: null, health: DOWN }))).toMatchObject({ action: "install", up: false });
    const failed = { ...INITIAL_STATE, installFailedAt: NOW - 1000, installError: "no network" };
    expect(runningStep(failed, facts({ installed: false, pid: null, health: DOWN }))).toMatchObject({ action: "none", up: false });
    expect(runningStep(failed, facts({ installed: false, pid: null, health: DOWN, now: NOW - 1000 + INSTALL_RETRY_MS })).action).toBe("install");
  });
  it("does nothing while installing, and routes nothing", () => {
    expect(runningStep(INITIAL_STATE, facts({ installed: false, installing: true, pid: null, health: DOWN }))).toMatchObject({ action: "none", up: false });
  });
  it("starts an installed proxy that is not running", () => {
    const step = runningStep(INITIAL_STATE, facts({ pid: null, health: DOWN }));
    expect(step).toMatchObject({ action: "start", up: false });
    expect(step.state.starts).toEqual([NOW]);
  });
  it("routes only while healthy", () => {
    expect(runningStep(INITIAL_STATE, facts())).toMatchObject({ action: "none", up: true });
    expect(runningStep(INITIAL_STATE, facts({ health: { healthy: false, reason: "x", pid: 4242 } })).up).toBe(false);
  });
  it("restarts after two unhealthy beats in a row, not one, and not while it is still starting", () => {
    const sick = { healthy: false as const, reason: "health check answered HTTP 500", pid: 4242 };
    const one = runningStep(INITIAL_STATE, facts({ health: sick }));
    expect(one).toMatchObject({ action: "none", up: false });
    expect(runningStep(one.state, facts({ health: sick, now: NOW + 30_000 })).action).toBe("restart");
    const justStarted = { ...INITIAL_STATE, starts: [NOW - STARTUP_GRACE_MS + 1] };
    const a = runningStep(justStarted, facts({ health: sick }));
    expect(runningStep(a.state, facts({ health: sick })).action).toBe("none");
    // A healthy beat in between resets the count.
    const healed = runningStep(one.state, facts());
    expect(runningStep(healed.state, facts({ health: sick })).action).toBe("none");
  });
  it(`restarts a proxy over ${MAX_RSS_BYTES / 1024 ** 3} GB, routing off meanwhile`, () => {
    expect(runningStep(INITIAL_STATE, facts({ rssBytes: MAX_RSS_BYTES })).action).toBe("none");
    expect(runningStep(INITIAL_STATE, facts({ rssBytes: MAX_RSS_BYTES + 1 }))).toMatchObject({ action: "restart", up: false });
  });
  it(`starts at most ${MAX_STARTS} times in ${START_WINDOW_MS / 60_000} min, then stays down`, () => {
    let state: HeadroomState = INITIAL_STATE;
    let now = NOW;
    const actions: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const step = runningStep(state, facts({ pid: null, health: DOWN, now }));
      actions.push(step.action);
      state = step.state;
      now += 60_000;
    }
    expect(actions).toEqual(["start", "start", "start", "start", "none", "none"]);
    expect(state.reason).toMatch(/staying down/);
    expect(runningStep(state, facts({ pid: null, health: DOWN, now: NOW + START_WINDOW_MS })).action).toBe("start");
  });
  it("is off when stopped, whatever it sees", () => {
    const stopped = { ...INITIAL_STATE, stopped: true };
    expect(runningStep(stopped, facts())).toMatchObject({ action: "none", up: false });
    expect(runningStep(stopped, facts({ installed: false, pid: null, health: DOWN })).action).toBe("none");
  });
  it("off for good: never installs, starts or routes, and counts as stopped, whatever it sees", () => {
    expect(OFF_FOR_GOOD).toBe("it altered tool output");
    for (const f of [facts(), facts({ installed: false, pid: null, health: DOWN }), facts({ pid: null, health: DOWN }), facts({ rssBytes: MAX_RSS_BYTES + 1 })]) {
      const step = headroomStep(INITIAL_STATE, f);
      expect(step).toMatchObject({ action: "none", up: false });
      expect(step.state.stopped).toBe(true);
    }
  });
  it("forgets an old install failure once installed", () => {
    const failed = { ...INITIAL_STATE, installFailedAt: NOW - 5, installError: "x" };
    expect(runningStep(failed, facts()).state).toMatchObject({ installFailedAt: null, installError: null });
  });
});

describe("parseState", () => {
  it("reads what it wrote and treats junk as a fresh start", () => {
    const state = { ...INITIAL_STATE, starts: [NOW], downSince: NOW, reason: "starting" };
    expect(parseState(JSON.stringify(state))).toEqual(state);
    expect(parseState("{")).toEqual(INITIAL_STATE);
    expect(parseState(null)).toEqual(INITIAL_STATE);
    expect(parseState("[1]")).toEqual(INITIAL_STATE);
  });
});

describe("the one-time settings cleanup", () => {
  const builder = {
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node '/p/builderguard.ts' '/wt' || exit 2" }] }] },
    sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, network: { allowedDomains: ["registry.npmjs.org"] } },
    permissions: { deny: ["Bash(git push:*)"] },
    env: { FOO: "1" },
  };
  const cleaned = (value: unknown) => {
    const change = cleanupSettingsText(JSON.stringify(value));
    return change.action === "write" ? (JSON.parse(change.text) as unknown) : change;
  };
  it("removes our key; every other key survives, and an emptied env goes", () => {
    expect(cleaned({ ...builder, env: { FOO: "1", ANTHROPIC_BASE_URL: LEGACY_SETTINGS_URL } })).toEqual(builder);
    const { env: _env, ...noEnv } = builder;
    expect(cleaned({ ...noEnv, env: { ANTHROPIC_BASE_URL: LEGACY_SETTINGS_URL } })).toEqual(noEnv);
    expect(cleaned({ env: { ANTHROPIC_BASE_URL: `${LEGACY_SETTINGS_URL}/` }, model: "x" })).toEqual({ model: "x" });
  });
  it("deletes the file only when it held nothing but our key", () => {
    expect(cleanupSettingsText(JSON.stringify({ env: { ANTHROPIC_BASE_URL: LEGACY_SETTINGS_URL } }))).toEqual({ action: "delete" });
    expect(cleanupSettingsText(JSON.stringify({ env: { ANTHROPIC_BASE_URL: LEGACY_SETTINGS_URL }, permissions: {} })).action).toBe("write");
    expect(cleanupSettingsText(JSON.stringify({ env: { ANTHROPIC_BASE_URL: LEGACY_SETTINGS_URL, FOO: "1" } })).action).toBe("write");
    expect(cleanupSettingsText("{}")).toEqual({ action: "none" });
    expect(cleanupSettingsText(null)).toEqual({ action: "none" });
  });
  it("never changes or removes an ANTHROPIC_BASE_URL that is not exactly ours", () => {
    for (const other of ["https://gateway.example.com", "http://127.0.0.1:8792", "http://localhost:8791", "http://127.0.0.1:87910", "http://127.0.0.1:8791/v1"]) {
      expect(cleanupSettingsText(JSON.stringify({ env: { ANTHROPIC_BASE_URL: other } }))).toEqual({ action: "none" });
    }
    expect(cleanupSettingsText(JSON.stringify({ ANTHROPIC_BASE_URL: LEGACY_SETTINGS_URL }))).toEqual({ action: "none" });
  });
  it("leaves a file that does not parse alone, and one with a strange env untouched", () => {
    expect(cleanupSettingsText("{ not json").action).toBe("skip");
    expect(cleanupSettingsText("[]").action).toBe("skip");
    expect(cleanupSettingsText(JSON.stringify({ env: ["x"] }))).toEqual({ action: "none" });
    expect(withoutLegacyRoute({ env: "x" })).toBeNull();
  });
  it("is idempotent", () => {
    const once = cleanupSettingsText(JSON.stringify({ ...builder, env: { ANTHROPIC_BASE_URL: LEGACY_SETTINGS_URL } }));
    expect(once.action).toBe("write");
    expect(cleanupSettingsText(once.action === "write" ? once.text : "")).toEqual({ action: "none" });
  });
  it("never adds a base URL, whatever it is given", () => {
    const inputs = [
      null,
      "{}",
      JSON.stringify(builder),
      JSON.stringify({ env: {} }),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: LEGACY_SETTINGS_URL, OTHER: RELAY_URL } }),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: LEGACY_SETTINGS_URL } }),
    ];
    for (const text of inputs) {
      const change = cleanupSettingsText(text);
      if (change.action !== "write") continue;
      const out = JSON.parse(change.text) as { env?: Record<string, unknown> };
      expect(out.env?.[BASE_URL_KEY]).toBeUndefined();
    }
  });
});

describe("no settings file is ever routed", () => {
  // Routing is per thread (agentEnv through bb's provider env). The first
  // version wrote ANTHROPIC_BASE_URL into every checkout's settings and
  // routed the owner's own sessions; none of that code may come back.
  const source = (file: string) => readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
  it("has no routing writer left in headroom.ts, host.ts or server.ts", () => {
    for (const file of ["headroom.ts", "host.ts", "server.ts"]) {
      const text = source(file);
      expect(text).not.toMatch(/\bapplyRouting\b|\brouteSettingsText\b|\brouteCheckout\b/);
    }
  });
  it("names the base URL key in host.ts only through the cleanup", () => {
    const host = source("host.ts");
    expect(host).not.toMatch(/ANTHROPIC_BASE_URL["'`]?\s*[:\]]/);
    expect(host).not.toMatch(/\bBASE_URL_KEY\b/);
    expect(host).not.toMatch(/\bRELAY_URL\b[^\n]*settings/i);
  });
});

describe("agentEnv", () => {
  it("off for good: routes no thread, however healthy the relay", () => {
    const fresh = { enabled: true, relayHealthy: true, at: NOW };
    expect(agentEnv({ agent: true, reading: fresh, now: NOW })).toEqual([]);
  });
  const fresh = { enabled: true, relayHealthy: true, at: NOW - 1_000 };
  it("routes an Orchestrator agent thread through the relay while enabled and the relay answered", () => {
    expect(agentEnv({ offForGood: null, agent: true, reading: fresh, now: NOW })).toEqual([
      { name: "ANTHROPIC_BASE_URL", value: "http://127.0.0.1:8791", reason: expect.stringContaining("relay") },
    ]);
  });
  it("gives an unknown thread (the owner's own session) nothing", () => {
    expect(agentEnv({ offForGood: null, agent: false, reading: fresh, now: NOW })).toEqual([]);
  });
  it("gives nothing when stopped, when the relay is down, or with no reading", () => {
    expect(agentEnv({ offForGood: null, agent: true, reading: { ...fresh, enabled: false }, now: NOW })).toEqual([]);
    expect(agentEnv({ offForGood: null, agent: true, reading: { ...fresh, relayHealthy: false }, now: NOW })).toEqual([]);
    expect(agentEnv({ offForGood: null, agent: true, reading: null, now: NOW })).toEqual([]);
  });
  it(`gives nothing on a reading older than ${ROUTE_FRESH_MS / 1000} s, or one from the future`, () => {
    expect(agentEnv({ offForGood: null, agent: true, reading: { ...fresh, at: NOW - ROUTE_FRESH_MS }, now: NOW })).toHaveLength(1);
    expect(agentEnv({ offForGood: null, agent: true, reading: { ...fresh, at: NOW - ROUTE_FRESH_MS - 1 }, now: NOW })).toEqual([]);
    expect(agentEnv({ offForGood: null, agent: true, reading: { ...fresh, at: NOW + 60_000 }, now: NOW })).toEqual([]);
  });
  it("never names Headroom's own port: agents only ever see the relay", () => {
    expect(JSON.stringify(agentEnv({ offForGood: null, agent: true, reading: fresh, now: NOW }))).not.toContain(":8792");
  });
});

describe("parseRelayHealth", () => {
  it("is healthy on 200 with ok and a pid", () => {
    expect(parseRelayHealth(200, { ok: true, pid: 77, version: RELAY_VERSION, upstream: "direct", inFlight: 2, startedAt: 1 })).toEqual({
      healthy: true,
      pid: 77,
      version: RELAY_VERSION,
      inFlight: 2,
    });
  });
  it("is down on no answer, a non-200, no ok or no pid", () => {
    expect(parseRelayHealth(null, null)).toEqual(NO_RELAY);
    expect(parseRelayHealth(502, { ok: true, pid: 77 })).toEqual(NO_RELAY);
    expect(parseRelayHealth(200, { ok: "true", pid: 77 })).toEqual(NO_RELAY);
    expect(parseRelayHealth(200, { ok: true })).toEqual(NO_RELAY);
    expect(parseRelayHealth(200, "<html>")).toEqual(NO_RELAY);
  });
});

describe("relayStep", () => {
  const up: RelayReading = { healthy: true, pid: 77, version: RELAY_VERSION, inFlight: 0 };
  const base: RelayFacts = { stopped: false, pid: 77, reading: up, activeAgentTurns: 0, canStart: true, unhealthyBeats: 0 };
  const step = (over: Partial<RelayFacts>) => relayStep({ ...base, ...over });
  it("leaves a healthy relay alone", () => {
    expect(step({}).action).toBe("none");
    expect(step({ activeAgentTurns: 3 }).action).toBe("none");
  });
  it("starts a dead relay at once", () => {
    expect(step({ pid: null, reading: NO_RELAY })).toMatchObject({ action: "start" });
    expect(step({ pid: null, reading: NO_RELAY, activeAgentTurns: 2 })).toMatchObject({ action: "start" });
  });
  it("restarts a live relay only after two beats without an answer", () => {
    const one = step({ reading: NO_RELAY });
    expect(one).toMatchObject({ action: "none", unhealthyBeats: 1 });
    expect(step({ reading: NO_RELAY, unhealthyBeats: one.unhealthyBeats })).toMatchObject({ action: "restart", unhealthyBeats: 0 });
  });
  it("cannot start without the script, and says so", () => {
    expect(step({ pid: null, reading: NO_RELAY, canStart: false })).toMatchObject({ action: "none", reason: expect.stringMatching(/script/) });
  });
  it("replaces an older relay only when nothing uses it", () => {
    const old = { ...up, version: RELAY_VERSION - 1 };
    expect(step({ reading: old }).action).toBe("restart");
    expect(step({ reading: old, activeAgentTurns: 1 }).action).toBe("none");
    expect(step({ reading: { ...old, inFlight: 1 } }).action).toBe("none");
  });
  it("stopped: never stops the relay while an agent turn is active or a request is in flight", () => {
    expect(step({ stopped: true, activeAgentTurns: 1 })).toMatchObject({ action: "none", reason: "waiting for 1 agent turn to finish" });
    expect(step({ stopped: true, activeAgentTurns: 4 }).action).toBe("none");
    expect(step({ stopped: true, reading: { ...up, inFlight: 2 } })).toMatchObject({ action: "none", reason: "waiting for 2 requests in flight" });
    expect(step({ stopped: true }).action).toBe("stop");
    expect(step({ stopped: true, reading: NO_RELAY }).action).toBe("stop");
    expect(step({ stopped: true, reading: NO_RELAY, pid: null }).action).toBe("none");
  });
  it("stopped: never starts one", () => {
    expect(step({ stopped: true, pid: null, reading: NO_RELAY }).action).toBe("none");
  });
});

describe("stopPlan", () => {
  const up: RelayReading = { healthy: true, pid: 77, version: RELAY_VERSION, inFlight: 0 };
  it("stops Headroom at once and the relay only when no agent turn is active", () => {
    expect(stopPlan({ headroomPid: 9, relayAlive: true, activeAgentTurns: 0, reading: up })).toEqual({ stopHeadroom: true, stopRelay: true, relayWaits: null });
    expect(stopPlan({ headroomPid: 9, relayAlive: true, activeAgentTurns: 2, reading: up })).toEqual({
      stopHeadroom: true,
      stopRelay: false,
      relayWaits: "waiting for 2 agent turns to finish",
    });
    expect(stopPlan({ headroomPid: 9, relayAlive: true, activeAgentTurns: 0, reading: { ...up, inFlight: 1 } }).stopRelay).toBe(false);
  });
  it("has nothing to stop when nothing runs", () => {
    expect(stopPlan({ headroomPid: null, relayAlive: false, activeAgentTurns: 3, reading: NO_RELAY })).toEqual({ stopHeadroom: false, stopRelay: false, relayWaits: null });
  });
});

describe("headroomView", () => {
  it("off for good: says so, whatever the state, and never needs the owner", () => {
    const down = { ...INITIAL_STATE, starts: Array.from({ length: MAX_STARTS }, (_, i) => NOW - i * 1000), reason: "staying down", downSince: NOW - OWNER_AFTER_MS - 1 };
    for (const state of [INITIAL_STATE, { ...INITIAL_STATE, stopped: true }, down]) {
      expect(headroomView({ state, up: true, relayUp: false, relayNote: null, stats: null, now: NOW, paths })).toEqual({
        state: "off",
        line: "Headroom: off for good (it altered tool output)",
        needsOwner: null,
      });
    }
    expect(headroomView({ state: INITIAL_STATE, up: false, relayUp: true, relayNote: "waiting for 1 agent turn to finish", stats: null, now: NOW, paths }).line).toBe(
      "Headroom: off for good (it altered tool output) (the relay stays up, waiting for 1 agent turn to finish)",
    );
  });
  const view = (state: HeadroomState, up = false, now = NOW, relayUp = true, relayNote: string | null = null) =>
    headroomView({ state, up, relayUp, relayNote, offForGood: null, stats: up ? { tokensRemoved: 1_234_567, tokensBefore: 14_355_430, requests: 9 } : null, now, paths });
  it("says on, with the measured tokens removed and their share", () => {
    expect(view(INITIAL_STATE, true).line).toBe("Headroom: on · 1.2M tokens removed (8.6%)");
    expect(
      headroomView({ state: INITIAL_STATE, up: true, relayUp: true, relayNote: null, offForGood: null, stats: { tokensRemoved: 900, tokensBefore: null, requests: null }, now: NOW, paths }).line,
    ).toBe("Headroom: on · 900 tokens removed");
  });
  it("says installing, starting, off, or down with the reason", () => {
    expect(view({ ...INITIAL_STATE, reason: "installing" }).line).toBe("Headroom: installing…");
    expect(view({ ...INITIAL_STATE, reason: "starting" }).line).toBe("Headroom: starting…");
    expect(view({ ...INITIAL_STATE, stopped: true }, false, NOW, false).line).toBe("Headroom: off, agents go direct");
    expect(view({ ...INITIAL_STATE, reason: "not answering", downSince: NOW }).line).toBe("Headroom: down, agents go direct (not answering)");
  });
  it("says when the relay is down, and why a stopped relay is still up", () => {
    expect(view(INITIAL_STATE, true, NOW, false, "starting the relay")).toMatchObject({ state: "down", line: "Headroom: down, agents go direct (starting the relay)" });
    expect(view({ ...INITIAL_STATE, stopped: true }, false, NOW, true, "waiting for 1 agent turn to finish").line).toBe(
      "Headroom: off, agents go direct (the relay stays up, waiting for 1 agent turn to finish)",
    );
  });
  it("needs the owner only past the restart cap and down over 30 min, with the log to read", () => {
    const capped = { ...INITIAL_STATE, starts: Array.from({ length: MAX_STARTS }, (_, i) => NOW - i * 1000), reason: "staying down", downSince: NOW - OWNER_AFTER_MS - 1 };
    expect(view(capped).needsOwner?.command).toBe(`tail -n 100 ${paths.log}`);
    expect(view({ ...capped, downSince: NOW - OWNER_AFTER_MS + 1 }).needsOwner).toBeNull();
    expect(view({ ...capped, starts: [NOW] }).needsOwner).toBeNull();
    const installFailed = { ...INITIAL_STATE, installFailedAt: NOW - 10, installError: "x", reason: "install failed: x", downSince: NOW - OWNER_AFTER_MS - 1 };
    expect(view(installFailed).needsOwner?.command).toBe(`tail -n 100 ${paths.installLog}`);
  });
});

describe("controlRefusal", () => {
  it("off for good: start refuses, stop goes through", () => {
    expect(controlRefusal("start")).toBe(OFF_FOR_GOOD_REFUSAL);
    expect(OFF_FOR_GOOD_REFUSAL).toBe("Headroom stays off: it cannot run without changing tool output");
    expect(controlRefusal("stop")).toBeNull();
    expect(controlRefusal("start", null)).toBeNull();
  });
});
