import { describe, expect, it } from "vitest";
import { makeMessageDispatchHookContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createMemoryGuard, type GuardDeps } from "./guard.js";
import {
  HEARTBEAT_MS,
  MAX_ACTIVE_AGENTS,
  PROCESS_KILL_COOLDOWN_MS,
  READING_MAX_AGE_MS,
  STOP_COOLDOWN_MS,
  type AgentRole,
  type HeavyProcess,
  type KillTarget,
  type MemoryReading,
  type RunningAgent,
} from "./memory.js";

const GB = 1024 ** 3;

function rig() {
  const state = {
    now: 1_000_000,
    free: 60,
    readFails: false,
    roles: new Map<string, AgentRole>(),
    statuses: new Map<string, string>(),
    running: [] as string[],
    stopped: [] as string[],
    rechecks: 0,
    warnings: [] as string[],
    infos: [] as string[],
    treeGb: 1,
    heavy: [] as HeavyProcess[],
    killed: [] as { hostId: string; pid: number; target: KillTarget }[],
    told: [] as { threadId: string; message: string }[],
  };
  const deps: GuardDeps = {
    roleOf: (thread) => state.roles.get(thread.id) ?? null,
    hosts: async () => ["host_mac"],
    readMemory: async () => {
      if (state.readFails) throw new Error("sysctl: no such oid");
      return {
        freePercent: state.free,
        totalBytes: 16 * GB,
        swapUsedBytes: 0,
        top: [],
        treeBytes: Math.ceil(state.treeGb * GB),
        heavy: state.heavy,
        at: state.now,
      } satisfies MemoryReading;
    },
    runningIds: async () => state.running,
    thread: async (id) => (state.statuses.has(id) ? { id, status: state.statuses.get(id) as string } : null),
    stop: async (victim: RunningAgent) => {
      state.stopped.push(victim.threadId);
    },
    killProcess: async (hostId, victim, target) => {
      state.killed.push({ hostId, pid: victim.pid, target });
      return { killed: true, detail: "stopped on SIGTERM" };
    },
    tellOwner: async (threadId, message) => {
      state.told.push({ threadId, message });
    },
    recheck: () => {
      state.rechecks += 1;
    },
    warn: (message) => {
      state.warnings.push(message);
    },
    info: (message) => {
      state.infos.push(message);
    },
    now: () => state.now,
  };
  const guard = createMemoryGuard(deps);
  const agent = (id: string, role: AgentRole = "task") => {
    state.roles.set(id, role);
    state.statuses.set(id, "idle");
    return id;
  };
  const start = (id: string, over: Record<string, unknown> = {}) =>
    guard.decide(
      makeMessageDispatchHookContext({ thread: makeThreadResponse({ id }), attempt: "start-turn", initiator: "agent", senderThreadId: "thr_patches", ...over } as never),
    );
  return { state, guard, agent, start };
}

describe("memory guard: admission", () => {
  it("holds agent turns until the first reading, and never holds anything else", async () => {
    const { guard, agent, start, state } = rig();
    agent("thr_task");
    expect(start("thr_task").action).toBe("wait");
    expect(start("thr_patches_chat").action).toBe("proceed");
    await guard.tick();
    expect(state.rechecks).toBe(1); // first reading releases what waited
    expect(start("thr_task").action).toBe("proceed");
  });

  it(`lets ${MAX_ACTIVE_AGENTS} agents work and queues the next until one finishes`, async () => {
    const { guard, agent, start, state } = rig();
    await guard.tick();
    for (let i = 0; i < MAX_ACTIVE_AGENTS; i++) expect(start(agent(`thr_${i}`)).action).toBe("proceed");
    const held = start(agent("thr_extra"));
    expect(held).toMatchObject({ action: "wait", sendAt: state.now + 30_000 });
    const before = state.rechecks;
    guard.onDone("thr_0");
    expect(state.rechecks).toBe(before + 1);
    expect(start("thr_extra").action).toBe("proceed");
  });

  it("never holds a turn already running or a message the owner typed", async () => {
    const { guard, agent, start, state } = rig();
    state.free = 1;
    await guard.tick();
    agent("thr_task");
    expect(start("thr_task", { attempt: "join-turn" }).action).toBe("proceed");
    expect(start("thr_task", { initiator: "user", senderThreadId: null }).action).toBe("proceed");
    expect(start("thr_task").action).toBe("wait");
  });

  it("holds turns while memory is low and releases them when it recovers", async () => {
    const { guard, agent, start, state } = rig();
    state.free = 15;
    await guard.tick();
    const held = start(agent("thr_task"));
    expect(held.action === "wait" && held.reason).toMatch(/15% memory free/);
    expect(state.warnings.some((w) => w.includes("holding new agent turns"))).toBe(true);
    const before = state.rechecks;
    state.free = 50;
    await guard.tick();
    expect(state.rechecks).toBe(before + 1);
    expect(start("thr_task").action).toBe("proceed");
  });

  it("fails closed when the Mac stops answering", async () => {
    const { guard, agent, start, state } = rig();
    await guard.tick();
    agent("thr_task");
    state.readFails = true;
    state.now += READING_MAX_AGE_MS + 1;
    await guard.tick();
    expect(state.warnings.some((w) => w.includes("sysctl: no such oid"))).toBe(true);
    expect(start("thr_task").action).toBe("wait");
  });
});

describe("memory guard: slots", () => {
  it("frees a slot bb no longer reports working, and counts agents working before it loaded", async () => {
    const { guard, agent, start, state } = rig();
    await guard.tick();
    expect(start(agent("thr_a")).action).toBe("proceed");
    agent("thr_b");
    state.running = ["thr_b"];
    state.statuses.set("thr_b", "active"); // working when the plugin loaded
    state.statuses.set("thr_a", "idle"); // its idle event never came
    await guard.tick();
    expect(guard.activeIds()).toEqual(["thr_b"]);
  });
  it("ignores threads that are not orchestrator agents", async () => {
    const { guard, state } = rig();
    state.running = ["thr_sams_own"];
    state.statuses.set("thr_sams_own", "active");
    await guard.tick();
    expect(guard.activeIds()).toEqual([]);
  });
});

describe("memory guard: watchdog", () => {
  it("stops the newest builder first, one per cooldown, and never a non-agent", async () => {
    const { guard, agent, start, state } = rig();
    await guard.tick();
    for (const [id, role] of [["thr_task", "task"], ["thr_research", "research"], ["thr_build", "build"]] as const) {
      expect(start(agent(id, role)).action).toBe("proceed");
      state.statuses.set(id, "active");
      state.running.push(id);
      state.now += 1;
    }
    state.running.push("thr_sams_own");
    state.statuses.set("thr_sams_own", "active");
    state.free = 5;
    await guard.tick();
    expect(state.stopped).toEqual(["thr_build"]);
    state.statuses.set("thr_build", "idle");
    state.now += STOP_COOLDOWN_MS - 1;
    await guard.tick();
    expect(state.stopped).toEqual(["thr_build"]);
    state.now += 1;
    await guard.tick();
    expect(state.stopped).toEqual(["thr_build", "thr_research"]);
    expect(state.warnings.some((w) => w.includes("stopping build thr_build at 5% free"))).toBe(true);
  });
  it("stops nothing while memory is above the floor", async () => {
    const { guard, agent, start, state } = rig();
    state.free = 11;
    await guard.tick();
    state.free = 25;
    await guard.tick();
    start(agent("thr_build", "build"));
    state.statuses.set("thr_build", "active");
    state.free = 11;
    await guard.tick();
    expect(state.stopped).toEqual([]);
  });
});

const FFMPEG = "ffmpeg -i clip.mov -vf scale=3840:2160 -c:v libx264 out.mp4";
const CLAUDE = "/Users/me/.local/bin/claude --output-format stream-json";
const proc = (pid: number, gb: number, over: Partial<HeavyProcess> = {}): HeavyProcess => ({
  pid,
  pgid: 21976,
  rssBytes: Math.ceil(gb * GB),
  command: FFMPEG,
  threadId: "thr_build",
  target: { kind: "group", pgid: 21976 },
  ...over,
});

describe("memory guard: agent tree budget", () => {
  it("kills an 18 GB ffmpeg group and tells its thread, once per cooldown", async () => {
    const { guard, state } = rig();
    state.treeGb = 18;
    state.heavy = [proc(21980, 4.5), proc(21981, 4.5), proc(21982, 4.5), proc(21983, 4.5)];
    await guard.tick();
    expect(state.killed).toEqual([{ hostId: "host_mac", pid: 21980, target: { kind: "group", pgid: 21976 } }]);
    expect(state.told).toHaveLength(1);
    expect(state.told[0]!.threadId).toBe("thr_build");
    expect(state.told[0]!.message).toMatch(/killed ffmpeg .* and its process group: bb's agents were using 18\.0 GB of 16\.0 GB/);
    expect(state.warnings.some((w) => w.includes("killing process group 21976"))).toBe(true);
    state.now += PROCESS_KILL_COOLDOWN_MS - 1;
    await guard.tick();
    expect(state.killed).toHaveLength(1);
    state.now += 1;
    await guard.tick();
    expect(state.killed).toHaveLength(2);
  });

  it("never kills claude, however big the tree", async () => {
    const { guard, state } = rig();
    state.treeGb = 15;
    state.heavy = [proc(17837, 12, { command: CLAUDE, pgid: 17678, target: null, threadId: null })];
    await guard.tick();
    expect(state.killed).toEqual([]);
  });

  it("logs a kill with no thread id, and tells no one", async () => {
    const { guard, state } = rig();
    state.treeGb = 10;
    state.heavy = [proc(21980, 9, { threadId: null, target: { kind: "pid", pid: 21980 } })];
    await guard.tick();
    expect(state.killed).toHaveLength(1);
    expect(state.told).toEqual([]);
    expect(state.warnings.some((w) => w.includes("no BB_THREAD_ID"))).toBe(true);
  });

  it("holds agent turns at 40% of RAM in the tree and releases them below it", async () => {
    const { guard, agent, start, state } = rig();
    state.treeGb = 6.4;
    state.heavy = [proc(21980, 3)];
    await guard.tick();
    const held = start(agent("thr_task"));
    expect(held.action === "wait" && held.reason).toMatch(/bb's agents are using 6\.4 GB of 16\.0 GB/);
    expect(state.warnings.some((w) => w.includes("holding new agent turns"))).toBe(true);
    expect(state.killed).toEqual([]);
    const before = state.rechecks;
    state.treeGb = 6.3;
    await guard.tick();
    expect(state.rechecks).toBe(before + 1);
    expect(start("thr_task").action).toBe("proceed");
  });

  it("logs that it is live on the first reading, then a heartbeat at most every 10 minutes", async () => {
    const { guard, state } = rig();
    await guard.tick();
    expect(state.infos).toEqual([expect.stringMatching(/^memory guard: live, 60% free.*agent tree 1\.0 GB/)]);
    state.now += HEARTBEAT_MS - 1;
    await guard.tick();
    expect(state.infos).toHaveLength(1);
    state.now += 1;
    await guard.tick();
    expect(state.infos).toHaveLength(2);
  });
});
