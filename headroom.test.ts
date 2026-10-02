import { describe, expect, it } from "vitest";
import {
  HEADROOM_URL,
  INITIAL_STATE,
  INSTALL_RETRY_MS,
  MAX_RSS_BYTES,
  MAX_STARTS,
  OWNER_AFTER_MS,
  START_WINDOW_MS,
  STARTUP_GRACE_MS,
  applyRouting,
  headroomPaths,
  headroomStep,
  headroomView,
  installSteps,
  isHeadroomProxy,
  parseHealth,
  parseState,
  parseStats,
  routeSettingsText,
  runArgv,
  runEnv,
  type BeatFacts,
  type HeadroomState,
} from "./headroom";

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
  it("binds 127.0.0.1 only, on the fixed port, in cache mode", () => {
    const argv = runArgv(paths);
    expect(argv).toEqual([`${paths.dir}/venv/bin/headroom`, "proxy", "--host", "127.0.0.1", "--port", "8791", "--mode", "cache"]);
    expect(argv).not.toContain("0.0.0.0");
    expect(HEADROOM_URL).toBe("http://127.0.0.1:8791");
  });
  it("always runs with the beacon and telemetry off, whatever the host's environment says", () => {
    const env = runEnv({ PATH: "/usr/bin", HEADROOM_BEACON: "on", HEADROOM_TELEMETRY: "on", DO_NOT_TRACK: "0" });
    expect(env).toMatchObject({ PATH: "/usr/bin", HEADROOM_BEACON: "off", HEADROOM_TELEMETRY: "off", DO_NOT_TRACK: "1" });
    for (const step of installSteps(paths)) expect(step.env).toMatchObject({ HEADROOM_BEACON: "off", HEADROOM_TELEMETRY: "off", DO_NOT_TRACK: "1" });
  });
  it("never points the proxy at itself, but keeps another upstream", () => {
    expect(runEnv({ ANTHROPIC_BASE_URL: HEADROOM_URL }).ANTHROPIC_BASE_URL).toBeUndefined();
    expect(runEnv({ ANTHROPIC_BASE_URL: "https://gw.example.com" }).ANTHROPIC_BASE_URL).toBe("https://gw.example.com");
  });
  it("knows its own proxy in ps, by the venv it installed", () => {
    expect(isHeadroomProxy(`${paths.python} ${runArgv(paths).join(" ")}`)).toBe(true);
    expect(isHeadroomProxy(`${paths.bin} proxy`)).toBe(true);
    expect(isHeadroomProxy(`${paths.bin} stats`)).toBe(false);
    expect(isHeadroomProxy("/tmp/x/bin/headroom proxy")).toBe(false);
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
  it("installs when not installed, and after a failure waits an hour", () => {
    expect(headroomStep(INITIAL_STATE, facts({ installed: false, pid: null, health: DOWN }))).toMatchObject({ action: "install", route: false });
    const failed = { ...INITIAL_STATE, installFailedAt: NOW - 1000, installError: "no network" };
    expect(headroomStep(failed, facts({ installed: false, pid: null, health: DOWN }))).toMatchObject({ action: "none", route: false });
    expect(headroomStep(failed, facts({ installed: false, pid: null, health: DOWN, now: NOW - 1000 + INSTALL_RETRY_MS })).action).toBe("install");
  });
  it("does nothing while installing, and routes nothing", () => {
    expect(headroomStep(INITIAL_STATE, facts({ installed: false, installing: true, pid: null, health: DOWN }))).toMatchObject({ action: "none", route: false });
  });
  it("starts an installed proxy that is not running", () => {
    const step = headroomStep(INITIAL_STATE, facts({ pid: null, health: DOWN }));
    expect(step).toMatchObject({ action: "start", route: false });
    expect(step.state.starts).toEqual([NOW]);
  });
  it("routes only while healthy", () => {
    expect(headroomStep(INITIAL_STATE, facts())).toMatchObject({ action: "none", route: true });
    expect(headroomStep(INITIAL_STATE, facts({ health: { healthy: false, reason: "x", pid: 4242 } })).route).toBe(false);
  });
  it("restarts after two unhealthy beats in a row, not one, and not while it is still starting", () => {
    const sick = { healthy: false as const, reason: "health check answered HTTP 500", pid: 4242 };
    const one = headroomStep(INITIAL_STATE, facts({ health: sick }));
    expect(one).toMatchObject({ action: "none", route: false });
    expect(headroomStep(one.state, facts({ health: sick, now: NOW + 30_000 })).action).toBe("restart");
    const justStarted = { ...INITIAL_STATE, starts: [NOW - STARTUP_GRACE_MS + 1] };
    const a = headroomStep(justStarted, facts({ health: sick }));
    expect(headroomStep(a.state, facts({ health: sick })).action).toBe("none");
    // A healthy beat in between resets the count.
    const healed = headroomStep(one.state, facts());
    expect(headroomStep(healed.state, facts({ health: sick })).action).toBe("none");
  });
  it(`restarts a proxy over ${MAX_RSS_BYTES / 1024 ** 3} GB, routing off meanwhile`, () => {
    expect(headroomStep(INITIAL_STATE, facts({ rssBytes: MAX_RSS_BYTES })).action).toBe("none");
    expect(headroomStep(INITIAL_STATE, facts({ rssBytes: MAX_RSS_BYTES + 1 }))).toMatchObject({ action: "restart", route: false });
  });
  it(`starts at most ${MAX_STARTS} times in ${START_WINDOW_MS / 60_000} min, then stays down`, () => {
    let state: HeadroomState = INITIAL_STATE;
    let now = NOW;
    const actions: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const step = headroomStep(state, facts({ pid: null, health: DOWN, now }));
      actions.push(step.action);
      state = step.state;
      now += 60_000;
    }
    expect(actions).toEqual(["start", "start", "start", "start", "none", "none"]);
    expect(state.reason).toMatch(/staying down/);
    expect(headroomStep(state, facts({ pid: null, health: DOWN, now: NOW + START_WINDOW_MS })).action).toBe("start");
  });
  it("is off when stopped, whatever it sees", () => {
    const stopped = { ...INITIAL_STATE, stopped: true };
    expect(headroomStep(stopped, facts())).toMatchObject({ action: "none", route: false });
    expect(headroomStep(stopped, facts({ installed: false, pid: null, health: DOWN })).action).toBe("none");
  });
  it("forgets an old install failure once installed", () => {
    const failed = { ...INITIAL_STATE, installFailedAt: NOW - 5, installError: "x" };
    expect(headroomStep(failed, facts()).state).toMatchObject({ installFailedAt: null, installError: null });
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

describe("routing in settings.local.json", () => {
  const builder = {
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node '/p/builderguard.ts' '/wt' || exit 2" }] }] },
    sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, network: { allowedDomains: ["registry.npmjs.org"] } },
    permissions: { deny: ["Bash(git push:*)"] },
    env: { FOO: "1" },
  };
  const written = (text: string | null, on: boolean) => {
    const change = routeSettingsText(text, on);
    return change.action === "write" ? (JSON.parse(change.text) as Record<string, unknown>) : change;
  };
  it("healthy: our URL is added; every other key survives", () => {
    const out = written(JSON.stringify(builder), true) as typeof builder & { env: Record<string, string> };
    expect(out.env).toEqual({ FOO: "1", ANTHROPIC_BASE_URL: HEADROOM_URL });
    expect({ ...out, env: builder.env }).toEqual(builder);
  });
  it("unhealthy: our URL is removed; every other key survives, and an emptied env goes", () => {
    const on = { ...builder, env: { FOO: "1", ANTHROPIC_BASE_URL: HEADROOM_URL } };
    expect(written(JSON.stringify(on), false)).toEqual(builder);
    expect(written(JSON.stringify({ env: { ANTHROPIC_BASE_URL: HEADROOM_URL } }), false)).toEqual({});
  });
  it("creates the file only to turn routing on", () => {
    expect(written(null, true)).toEqual({ env: { ANTHROPIC_BASE_URL: HEADROOM_URL } });
    expect(routeSettingsText(null, false)).toEqual({ action: "none" });
  });
  it("never changes or removes an ANTHROPIC_BASE_URL the owner set", () => {
    const owner = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://gateway.example.com" } });
    expect(routeSettingsText(owner, true)).toEqual({ action: "none" });
    expect(routeSettingsText(owner, false)).toEqual({ action: "none" });
    const near = JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8792" } });
    expect(routeSettingsText(near, false)).toEqual({ action: "none" });
  });
  it("is idempotent", () => {
    const on = routeSettingsText(JSON.stringify(builder), true);
    expect(on.action).toBe("write");
    expect(routeSettingsText(on.action === "write" ? on.text : "", true)).toEqual({ action: "none" });
    expect(routeSettingsText(JSON.stringify(builder), false)).toEqual({ action: "none" });
  });
  it("leaves a file that does not parse, or has a strange env, alone", () => {
    expect(routeSettingsText("{ not json", true).action).toBe("skip");
    expect(routeSettingsText("[]", true).action).toBe("skip");
    expect(routeSettingsText(JSON.stringify({ env: ["x"] }), true).action).toBe("skip");
    expect(applyRouting({ env: "x" }, true)).toBeNull();
  });
});

describe("headroomView", () => {
  const view = (state: HeadroomState, route = false, now = NOW) =>
    headroomView({ state, route, stats: route ? { tokensRemoved: 1_234_567, tokensBefore: 14_355_430, requests: 9 } : null, now, paths });
  it("says on, with the measured tokens removed and their share", () => {
    expect(view(INITIAL_STATE, true).line).toBe("Headroom: on · 1.2M tokens removed (8.6%)");
    expect(headroomView({ state: INITIAL_STATE, route: true, stats: { tokensRemoved: 900, tokensBefore: null, requests: null }, now: NOW, paths }).line).toBe(
      "Headroom: on · 900 tokens removed",
    );
  });
  it("says installing, starting, off, or down with the reason", () => {
    expect(view({ ...INITIAL_STATE, reason: "installing" }).line).toBe("Headroom: installing…");
    expect(view({ ...INITIAL_STATE, reason: "starting" }).line).toBe("Headroom: starting…");
    expect(view({ ...INITIAL_STATE, stopped: true }).line).toBe("Headroom: off");
    expect(view({ ...INITIAL_STATE, reason: "not answering", downSince: NOW }).line).toBe("Headroom: down, agents go direct (not answering)");
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
