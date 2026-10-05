import { describe, expect, it } from "vitest";
import {
  LEGACY_SETTINGS_URL,
  isLegacyProxy,
  isLegacyRelay,
  legacyPaths,
  parseLegacyProxyHealth,
  parseLegacyRelayHealth,
  removableDir,
  retirePlan,
  withoutLegacyRoute,
  type RetireFacts,
} from "./legacyroute";

describe("withoutLegacyRoute", () => {
  const guard = {
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node '/p/builderguard.ts' '/wt' || exit 2" }] }] },
    permissions: { deny: ["Bash(git push:*)"] },
  };
  it("removes the first version's key; every other key survives, and an emptied env goes", () => {
    expect(withoutLegacyRoute({ ...guard, env: { FOO: "1", ANTHROPIC_BASE_URL: LEGACY_SETTINGS_URL } })).toEqual({ ...guard, env: { FOO: "1" } });
    expect(withoutLegacyRoute({ ...guard, env: { ANTHROPIC_BASE_URL: LEGACY_SETTINGS_URL } })).toEqual(guard);
    expect(withoutLegacyRoute({ env: { ANTHROPIC_BASE_URL: `${LEGACY_SETTINGS_URL}//` }, model: "x" })).toEqual({ model: "x" });
  });
  it("is null, and changes nothing, for any other value or no env", () => {
    for (const other of ["https://gateway.example.com", "http://127.0.0.1:8792", "http://localhost:8791", "http://127.0.0.1:87910", "http://127.0.0.1:8791/v1", 8791]) {
      const settings = { env: { ANTHROPIC_BASE_URL: other } };
      expect(withoutLegacyRoute(settings)).toBeNull();
      expect(settings.env.ANTHROPIC_BASE_URL).toBe(other);
    }
    expect(withoutLegacyRoute({})).toBeNull();
    expect(withoutLegacyRoute({ env: "x" })).toBeNull();
    expect(withoutLegacyRoute({ env: { OTHER: LEGACY_SETTINGS_URL } })).toBeNull();
  });
  it("never mutates what it was given", () => {
    const settings = { env: { ANTHROPIC_BASE_URL: LEGACY_SETTINGS_URL, FOO: "1" } };
    withoutLegacyRoute(settings);
    expect(settings.env).toEqual({ ANTHROPIC_BASE_URL: LEGACY_SETTINGS_URL, FOO: "1" });
  });
});

describe("the install dir", () => {
  it("is one exact path under the home folder", () => {
    expect(legacyPaths("/Users/sam")).toEqual({
      dir: "/Users/sam/.local/share/the-orchestrator/headroom",
      proxyPidFile: "/Users/sam/.local/share/the-orchestrator/headroom/proxy.pid",
      relayPidFile: "/Users/sam/.local/share/the-orchestrator/headroom/relay.pid",
    });
    expect(legacyPaths("/Users/sam/").dir).toBe("/Users/sam/.local/share/the-orchestrator/headroom");
  });
  it("may be removed, and nothing else: not its parent, a child, a sibling or another home's", () => {
    const home = "/Users/sam";
    expect(removableDir(legacyPaths(home).dir, home)).toBe(true);
    for (const other of [
      "/Users/sam/.local/share/the-orchestrator",
      "/Users/sam/.local/share",
      "/Users/sam",
      "/",
      "/Users/sam/.local/share/the-orchestrator/headroom/venv",
      "/Users/sam/.local/share/the-orchestrator/headroom/",
      "/Users/sam/.local/share/the-orchestrator/headroom2",
      "/Users/other/.local/share/the-orchestrator/headroom",
      "/Users/sam/.local/share/the-orchestrator/headroom/..",
    ]) {
      expect(removableDir(other, home)).toBe(false);
    }
  });
  it("refuses a home that is relative, the root, empty or climbs", () => {
    for (const home of ["", "/", "//", "Users/sam", "/Users/sam/../..", "~"]) {
      expect(removableDir(legacyPaths(home).dir, home)).toBe(false);
    }
  });
});

describe("ps matchers", () => {
  // Exactly as ps showed them on the owner's Mac.
  const PROXY = "/Users/sam/.local/share/the-orchestrator/headroom/venv/bin/python -m headroom.cli proxy --host 127.0.0.1 --port 8792 --mode cache";
  const SCRIPT = "/Users/sam/.local/share/the-orchestrator/headroom/venv/bin/headroom proxy --host 127.0.0.1 --port 8792";
  const RELAY = "/opt/homebrew/bin/node /Users/sam/.local/share/the-orchestrator/headroom/relay.mts --orchestrator-relay --host 127.0.0.1 --port 8791 --headroom-port 8792";
  it("know the proxy and the relay", () => {
    expect(isLegacyProxy(PROXY)).toBe(true);
    expect(isLegacyProxy(SCRIPT)).toBe(true);
    expect(isLegacyProxy("/Users/sam/.local/share/the-orchestrator/headroom/venv/bin/python3.12 /Users/sam/.local/share/the-orchestrator/headroom/venv/bin/headroom proxy")).toBe(true);
    expect(isLegacyRelay(RELAY)).toBe(true);
    expect(isLegacyRelay("/usr/local/bin/node --no-warnings /Users/sam/.local/share/the-orchestrator/headroom/relay.mts --orchestrator-relay")).toBe(true);
  });
  it("never match a shell, another venv, another subcommand or a copy elsewhere", () => {
    expect(isLegacyProxy(`/bin/zsh -c ${SCRIPT}`)).toBe(false);
    expect(isLegacyProxy(`bash -c "${PROXY}"`)).toBe(false);
    expect(isLegacyProxy("/Users/sam/proj/.venv/bin/python -m headroom.cli proxy --port 8787")).toBe(false);
    expect(isLegacyProxy("headroom proxy --port 8792")).toBe(false);
    expect(isLegacyProxy("/Users/sam/.local/share/the-orchestrator/headroom/venv/bin/headroom stats")).toBe(false);
    expect(isLegacyProxy("/Users/sam/.local/share/the-orchestrator/headroom/venv/bin/python -m headroom.cli proxyx")).toBe(false);
    expect(isLegacyProxy(RELAY)).toBe(false);
    expect(isLegacyRelay("node /tmp/relay.mts --orchestrator-relay")).toBe(false);
    expect(isLegacyRelay("node /Users/sam/.local/share/the-orchestrator/headroom/relay.mts")).toBe(false);
    expect(isLegacyRelay(`/bin/sh -c "${RELAY}"`)).toBe(false);
    expect(isLegacyRelay(PROXY)).toBe(false);
  });
});

describe("health readings", () => {
  it("take the relay only when it answers as the relay", () => {
    expect(parseLegacyRelayHealth(200, { ok: true, pid: 77, version: 1, upstream: "direct", inFlight: 2 })).toEqual({ pid: 77, inFlight: 2 });
    expect(parseLegacyRelayHealth(200, { ok: true, pid: 77 })).toEqual({ pid: 77, inFlight: null });
    expect(parseLegacyRelayHealth(null, null)).toBeNull();
    expect(parseLegacyRelayHealth(502, { ok: true, pid: 77 })).toBeNull();
    expect(parseLegacyRelayHealth(200, { ok: "true", pid: 77 })).toBeNull();
    expect(parseLegacyRelayHealth(200, { ok: true, pid: 1 })).toBeNull();
    expect(parseLegacyRelayHealth(200, "<html>")).toBeNull();
  });
  it("take the proxy's pid whatever its status, and nothing that names none", () => {
    expect(parseLegacyProxyHealth(200, { config: { pid: 4242 }, checks: { startup: { ready: true } } })).toBe(4242);
    expect(parseLegacyProxyHealth(503, { config: { pid: 4242 } })).toBe(4242);
    expect(parseLegacyProxyHealth(null, { config: { pid: 4242 } })).toBeNull();
    expect(parseLegacyProxyHealth(200, { ok: true })).toBeNull();
    expect(parseLegacyProxyHealth(200, { config: { pid: "4242" } })).toBeNull();
  });
});

describe("retirePlan", () => {
  const none: RetireFacts = { proxyNamed: null, proxyPid: null, relay: null, relayPid: null, activeAgentTurns: 0, dirExists: true };
  const plan = (over: Partial<RetireFacts>) => retirePlan({ ...none, ...over });
  it("removes the dir when both are gone, and is done once it is", () => {
    expect(plan({})).toEqual({ stopProxy: false, stopRelay: false, removeDir: true, waits: null, gone: true });
    expect(plan({ dirExists: false })).toEqual({ stopProxy: false, stopRelay: false, removeDir: false, waits: null, gone: true });
  });
  it("stops the proxy at once, agent turns or not, and keeps the dir until a later beat finds it gone", () => {
    const p = plan({ proxyNamed: 4242, proxyPid: 4242, activeAgentTurns: 3 });
    expect(p).toMatchObject({ stopProxy: true, removeDir: false, gone: false });
    expect(plan({ proxyPid: 4242 })).toMatchObject({ stopProxy: true, removeDir: false, gone: false });
  });
  it("stops the relay only when no agent turn runs and nothing is in flight", () => {
    const relay = { pid: 77, inFlight: 0 };
    expect(plan({ relay, relayPid: 77 })).toMatchObject({ stopRelay: true, removeDir: false, waits: null, gone: false });
    expect(plan({ relayPid: 77 })).toMatchObject({ stopRelay: true, removeDir: false });
    expect(plan({ relay, relayPid: 77, activeAgentTurns: 1 })).toMatchObject({ stopRelay: false, removeDir: false, waits: "the relay waits for 1 agent turn to finish" });
    expect(plan({ relay: { pid: 77, inFlight: 2 }, relayPid: 77 })).toMatchObject({ stopRelay: false, removeDir: false, waits: "the relay waits for 2 requests in flight" });
    expect(plan({ relay: { pid: 77, inFlight: null }, relayPid: 77 })).toMatchObject({ stopRelay: true });
  });
  it("never signals or removes anything for a pid ps cannot confirm", () => {
    const relay = plan({ relay: { pid: 77, inFlight: 0 } });
    expect(relay).toMatchObject({ stopRelay: false, stopProxy: false, removeDir: false, gone: false });
    expect(relay.waits).toMatch(/8791.*ps does not show/);
    const proxy = plan({ proxyNamed: 4242 });
    expect(proxy).toMatchObject({ stopRelay: false, stopProxy: false, removeDir: false, gone: false });
    expect(proxy.waits).toMatch(/8792.*ps does not show/);
  });
  it("stops both on one beat when it may, and still keeps the dir for the next", () => {
    expect(plan({ proxyPid: 4242, relay: { pid: 77, inFlight: 0 }, relayPid: 77 })).toEqual({ stopProxy: true, stopRelay: true, removeDir: false, waits: null, gone: false });
  });
});
