import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DISCONNECTED_MS,
  HOLD_TRUSTED_MS,
  KILL_SHOWN_MS,
  signedOutWait,
  STALE_MS,
  agentIndicator,
  agentLiveness,
  chatTrouble,
  connection,
  describeRefusal,
  incidentKey,
  limitReason,
  livenessActions,
  taskIndicator,
  troubleMessage,
  taskLiveness,
  type Hold,
  type Kill,
  type LimitWait,
  type Probe,
  type TaskFacts,
} from "./liveness";
import { clock } from "./usage";
import { setOwner } from "./owner";

// The name is whoever runs it (owner.ts): a neutral one here, the fallback after.
beforeEach(() => setOwner("Alex"));
afterEach(() => setOwner(null));

const NOW = 1_000_000_000;
const probe = (over: Partial<Probe> = {}): Probe => ({
  threadId: "thr_task",
  role: "task",
  status: "active",
  lastEventAt: NOW - 5_000,
  undeliverable: null,
  error: null,
  limit: null,
  ...over,
});
const task = (over: Partial<TaskFacts> = {}): TaskFacts => ({
  id: "t1",
  stage: "research",
  buildState: "none",
  threadId: "thr_task",
  ...over,
});
const none = new Map<string, never>();
const live = (args: { task?: Partial<TaskFacts>; probes: Probe[]; holds?: Map<string, Hold>; kills?: Map<string, Kill> }) =>
  taskLiveness({ task: task(args.task), probes: args.probes, holds: args.holds ?? none, kills: args.kills ?? none, now: NOW });

describe("agentLiveness", () => {
  it("is working while busy with recent events", () => {
    expect(agentLiveness(probe(), undefined, NOW).state).toBe("working");
    expect(agentLiveness(probe({ status: "starting", lastEventAt: null }), undefined, NOW).state).toBe("working");
    expect(agentLiveness(probe({ status: "stopping" }), undefined, NOW).state).toBe("working");
  });

  it("is stale at STALE_MS without an event, not a moment before", () => {
    expect(agentLiveness(probe({ lastEventAt: NOW - STALE_MS + 1 }), undefined, NOW).state).toBe("working");
    const stale = agentLiveness(probe({ lastEventAt: NOW - STALE_MS }), undefined, NOW);
    expect(stale.state).toBe("stale");
    expect(stale.reason).toBe("no activity for 12 min");
  });

  it("uses 12 minutes: longer than the Bash tool's 10-minute cap on one command", () => {
    expect(STALE_MS).toBe(12 * 60_000);
    expect(STALE_MS).toBeGreaterThan(10 * 60_000);
  });

  it("is idle, error or gone from the status, whatever the last event", () => {
    expect(agentLiveness(probe({ status: "idle", lastEventAt: 0 }), undefined, NOW).state).toBe("idle");
    expect(agentLiveness(probe({ status: "error" }), undefined, NOW).state).toBe("error");
    expect(agentLiveness(probe({ status: "gone" }), undefined, NOW).state).toBe("gone");
  });

  it("waits, not stale, when the memory guard or the browser lease holds it", () => {
    const old = probe({ lastEventAt: NOW - STALE_MS * 2 });
    const memory = agentLiveness(old, { kind: "memory", reason: "12% free", since: NOW - 60_000 }, NOW);
    expect(memory).toMatchObject({ state: "waiting", reason: "waiting for memory: 12% free" });
    const browser = agentLiveness(probe({ status: "idle" }), { kind: "browser", reason: "t2 has it", since: NOW }, NOW);
    expect(browser).toMatchObject({ state: "waiting", reason: "waiting for the browser: t2 has it" });
    expect(agentLiveness(probe({ status: "pending" }), undefined, NOW)).toMatchObject({ state: "waiting", reason: "queued to start" });
  });

  it("stops trusting a hold after HOLD_TRUSTED_MS", () => {
    const old = probe({ lastEventAt: NOW - STALE_MS });
    expect(agentLiveness(old, { kind: "memory", reason: "x", since: NOW - HOLD_TRUSTED_MS }, NOW).state).toBe("stale");
    expect(agentLiveness(old, { kind: "memory", reason: "x", since: NOW - HOLD_TRUSTED_MS + 1 }, NOW).state).toBe("waiting");
  });

  it("is blocked, not idle, when bb refuses its queued messages", () => {
    const busy = "Cannot checkout branch while another thread is using this workspace";
    for (const status of ["idle", "error", "pending"] as const) {
      const blocked = agentLiveness(probe({ status, undeliverable: busy }), undefined, NOW);
      expect(blocked.state).toBe("blocked");
      expect(blocked.reason).toBe(`can't receive messages: its checkout is locked by a thread bb never finished setting up (bb: "${busy}")`);
    }
    // A running turn is receiving: an old failure on the queue is history.
    expect(agentLiveness(probe({ undeliverable: busy }), undefined, NOW).state).toBe("working");
    // A recorded hold explains the wait itself.
    const hold: Hold = { kind: "memory", reason: "12% free", since: NOW };
    expect(agentLiveness(probe({ status: "idle", undeliverable: busy }), hold, NOW).state).toBe("waiting");
    expect(agentLiveness(probe({ status: "idle", undeliverable: "rate limited\nmore" }), undefined, NOW).reason).toBe(
      "can't receive messages: rate limited",
    );
  });

  it("says why it errored when bb recorded it", () => {
    const failed = agentLiveness(
      probe({ status: "error", error: "Provisioning thread failed: Workspace is being prepared by another thread" }),
      undefined,
      NOW,
    );
    expect(failed.reason).toMatch(/^stopped with an error: its checkout is locked by a thread bb never finished setting up/);
    expect(agentLiveness(probe({ status: "error", error: "host daemon disconnected" }), undefined, NOW).reason).toBe(
      "stopped with an error: host daemon disconnected",
    );
  });

  it("recognises every form of bb's workspace lock and nothing else", () => {
    for (const text of [
      "Cannot checkout branch while another thread is using this workspace",
      "Provisioning thread failed: Workspace is being prepared by another thread",
      "HTTP 409 workspace_busy",
    ]) {
      expect(describeRefusal(text)).toMatch(/^its checkout is locked/);
    }
    expect(describeRefusal("Checkout blocked by uncommitted changes")).toBe("Checkout blocked by uncommitted changes");
  });

  it("lets error and gone beat a hold", () => {
    const hold: Hold = { kind: "memory", reason: "x", since: NOW };
    expect(agentLiveness(probe({ status: "error" }), hold, NOW).state).toBe("error");
    expect(agentLiveness(probe({ status: "gone" }), hold, NOW).state).toBe("gone");
  });
});

describe("usage-limit waits", () => {
  const until = NOW + 60 * 60_000;
  const limit: LimitWait = { kind: "usage-limit", until };
  const limited = (over: Partial<Probe> = {}) => probe({ status: "error", lastEventAt: null, error: "Rate limited", limit, ...over });

  it("waits until the reset instead of erroring", () => {
    const agent = agentLiveness(limited(), undefined, NOW);
    expect(agent).toMatchObject({ state: "waiting", reason: `waiting until ${clock(until, NOW)}: usage limit` });
    expect(limitReason({ kind: "usage-limit", until: null }, NOW)).toBe("waiting for the usage limit to reset");
    expect(limitReason({ kind: "retry", until }, NOW)).toBe(`queued to retry at ${clock(until, NOW)}`);
    expect(limitReason({ kind: "retry", until: null }, NOW)).toBe("queued to retry");
  });

  it("is never stuck: no trouble, so no Needs you and no Restart, for any role", () => {
    const result = live({
      task: { stage: "build", buildState: "running" },
      probes: [limited(), limited({ threadId: "r1", role: "research" }), limited({ threadId: "b1", role: "build" })],
    });
    expect(result.trouble).toEqual([]);
    expect(result.waiting).toBe(`waiting until ${clock(until, NOW)}: usage limit`);
    expect(livenessActions({ tasks: [{ liveness: result, threadId: "thr_task" }], seen: new Set() }).actions).toEqual([]);
    expect(chatTrouble(limited(), NOW)).toBeNull();
  });

  it("the same probe without the limit is an error and a dead build", () => {
    const result = live({
      task: { stage: "build", buildState: "running" },
      probes: [limited({ limit: null }), limited({ threadId: "b1", role: "build", limit: null })],
    });
    expect(result.trouble.map((t) => t.kind)).toEqual(["error", "dead-build"]);
  });

  it("signed out is a wait for the owner, never trouble, a dead build or a chat alert", () => {
    const signedOut = (over: Partial<Probe> = {}) =>
      limited({ error: "Provider error: Failed to authenticate: OAuth session expired", limit: { kind: "signed-out", until: null }, ...over });
    expect(agentLiveness(signedOut(), undefined, NOW)).toMatchObject({ state: "waiting", reason: signedOutWait() });
    const result = live({
      task: { stage: "build", buildState: "running" },
      probes: [signedOut(), signedOut({ threadId: "r1", role: "research" }), signedOut({ threadId: "b1", role: "build" })],
    });
    expect(result.trouble).toEqual([]);
    expect(result.waiting).toBe("waiting for Alex to sign in to Claude");
    expect(livenessActions({ tasks: [{ liveness: result, threadId: "thr_task" }], seen: new Set() }).actions).toEqual([]);
    expect(chatTrouble(signedOut(), NOW)).toBeNull();
  });

  it("a turn held while signed out reads as waiting for the owner", () => {
    const hold: Hold = { kind: "signed-out", reason: "Claude is signed out: waiting for Alex to sign in.", since: NOW };
    expect(agentLiveness(probe({ status: "idle", lastEventAt: null }), hold, NOW)).toMatchObject({ state: "waiting", reason: signedOutWait() });
  });

  it("works normally once the retry runs", () => {
    expect(agentLiveness(limited({ status: "active", lastEventAt: NOW }), undefined, NOW).state).toBe("working");
    expect(agentLiveness(limited({ status: "active", lastEventAt: NOW - STALE_MS }), undefined, NOW).state).toBe("stale");
  });

  it("names the memory guard when it holds the retry past the reset", () => {
    const hold: Hold = { kind: "memory", reason: "12% free", since: NOW - 1_000 };
    expect(agentLiveness(limited(), hold, NOW)).toMatchObject({ state: "waiting", reason: "waiting for memory: 12% free" });
  });

  it("is blocked when bb refuses the retry", () => {
    expect(agentLiveness(limited({ undeliverable: "workspace_busy" }), undefined, NOW).state).toBe("blocked");
  });
});

describe("chatTrouble", () => {
  it("names a Patches chat that cannot take the owner's messages, errored or went silent", () => {
    const chat = (over: Partial<Probe>) => chatTrouble(probe({ threadId: "thr_chat", ...over }), NOW);
    expect(chat({ status: "idle", undeliverable: "Cannot checkout branch while another thread is using this workspace" })).toMatch(
      /^Patches can't receive messages: its checkout is locked/,
    );
    expect(chat({ status: "error", error: "host daemon disconnected" })).toBe("Patches stopped with an error: host daemon disconnected");
    expect(chat({ lastEventAt: NOW - STALE_MS })).toBe("Patches went silent: no activity for 12 min");
    expect(chat({ status: "idle" })).toBeNull();
    expect(chat({})).toBeNull();
    expect(chat({ status: "gone" })).toBeNull();
  });
});

describe("taskLiveness", () => {
  it("spins when any of its agents works, and not when none does", () => {
    expect(live({ probes: [probe({ status: "idle" }), probe({ threadId: "r1", role: "research" })] }).working).toBe(true);
    const idle = live({ probes: [probe({ status: "idle" }), probe({ threadId: "r1", role: "research", status: "idle" })] });
    expect(idle).toMatchObject({ working: false, waiting: null, trouble: [] });
  });

  it("puts the task's own error or silence in front of the owner; nobody below can fix it", () => {
    expect(live({ probes: [probe({ status: "error" })] }).trouble).toEqual([
      { kind: "error", threadId: "thr_task", role: "task", reason: "Task stopped with an error", samMustAct: true },
    ]);
    const stale = live({ probes: [probe({ lastEventAt: NOW - STALE_MS })] }).trouble;
    expect(stale).toEqual([
      { kind: "stale", threadId: "thr_task", role: "task", reason: "Task went silent: no activity for 12 min", samMustAct: true },
    ]);
  });

  it("gives a child's silence or error to the task", () => {
    const stale = live({ probes: [probe({ status: "idle" }), probe({ threadId: "r1", role: "research", lastEventAt: NOW - STALE_MS })] });
    expect(stale.trouble).toEqual([
      { kind: "stale", threadId: "r1", role: "research", reason: "Research went silent: no activity for 12 min", samMustAct: false },
    ]);
    const error = live({ probes: [probe({ status: "idle" }), probe({ threadId: "r1", role: "research", status: "error" })] });
    expect(error.trouble).toEqual([
      { kind: "error", threadId: "r1", role: "research", reason: "Research stopped with an error", samMustAct: false },
    ]);
  });

  it("puts a blocked task thread in front of the owner and gives a blocked child to the task", () => {
    const busy = "Cannot checkout branch while another thread is using this workspace";
    const task = live({ probes: [probe({ status: "idle", undeliverable: busy })] }).trouble;
    expect(task).toHaveLength(1);
    expect(task[0]).toMatchObject({ kind: "blocked", threadId: "thr_task", role: "task", samMustAct: true });
    expect(task[0]?.reason).toMatch(/^Task can't receive messages: its checkout is locked/);
    const child = live({ probes: [probe({ status: "idle" }), probe({ threadId: "r1", role: "research", status: "idle", undeliverable: busy })] });
    expect(child.trouble).toEqual([expect.objectContaining({ kind: "blocked", threadId: "r1", role: "research", samMustAct: false })]);
    expect(agentIndicator(child.agents[1], false)).toMatchObject({ kind: "trouble" });
    // Only the latest child of a kind: an older one's queue is history.
    const older = live({
      probes: [
        probe({ status: "idle" }),
        probe({ threadId: "r1", role: "research", status: "idle", undeliverable: busy }),
        probe({ threadId: "r2", role: "research", status: "idle" }),
      ],
    });
    expect(older.trouble).toEqual([]);
  });

  it("tells the task a blocked child cannot be nudged, and asks nothing of the owner", () => {
    const { actions } = livenessActions({
      tasks: [
        {
          liveness: live({ probes: [probe({ status: "idle" }), probe({ threadId: "r1", role: "research", status: "idle", undeliverable: "workspace_busy" })] }),
          threadId: "thr_task",
        },
      ],
      seen: new Set(),
    });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "tell-task", threadId: "thr_task" });
    const told = actions[0]?.kind === "tell-task" ? actions[0].message : "";
    expect(told).toContain("Telling it more does not help");
    expect(troubleMessage("t1", { kind: "stale", threadId: "r1", role: "research", reason: "x", samMustAct: false })).not.toContain("does not help");
  });

  it("forgets old research errors: only the latest, while the task is researching", () => {
    const probes = [
      probe({ status: "idle" }),
      probe({ threadId: "r1", role: "research", status: "error" }),
      probe({ threadId: "r2", role: "research", status: "idle" }),
    ];
    expect(live({ probes }).trouble).toEqual([]);
    const latest = [probe({ status: "idle" }), probe({ threadId: "r1", role: "research", status: "error" })];
    expect(live({ task: { stage: "build" }, probes: latest }).trouble).toEqual([]);
  });

  it("finds a running build with no live builder", () => {
    const building = { stage: "build", buildState: "running" };
    expect(live({ task: building, probes: [probe({ status: "idle" })] }).trouble).toEqual([
      { kind: "dead-build", threadId: null, role: "build", reason: "Build running with no builder thread", samMustAct: false },
    ]);
    for (const status of ["gone", "error"] as const) {
      const trouble = live({ task: building, probes: [probe({ status: "idle" }), probe({ threadId: "b1", role: "build", status })] }).trouble;
      expect(trouble).toHaveLength(1);
      expect(trouble[0]).toMatchObject({ kind: "dead-build", threadId: "b1", samMustAct: false });
    }
  });

  it("calls only a running build dead: preparing has no builder yet, failed is already the task's", () => {
    for (const buildState of ["preparing", "failed", "none"]) {
      expect(live({ task: { stage: "build", buildState }, probes: [probe({ status: "idle" })] }).trouble).toEqual([]);
    }
  });

  it("judges only the latest builder, and a finished one is fine", () => {
    const building = { stage: "build", buildState: "running" };
    const probes = [probe({ status: "idle" }), probe({ threadId: "b1", role: "build", status: "gone" }), probe({ threadId: "b2", role: "build", status: "idle" })];
    expect(live({ task: building, probes }).trouble).toEqual([]);
    const errored = [probe({ status: "idle" }), probe({ threadId: "b1", role: "build", status: "error" })];
    expect(live({ task: { stage: "pr", buildState: "none" }, probes: errored }).trouble).toEqual([]);
  });

  it("shows a memory-guard kill until the thread works again or KILL_SHOWN_MS passes", () => {
    const kills = new Map([["r1", { reason: "tree at 55% of RAM", at: NOW - 60_000 }]]);
    const idle = [probe({ status: "idle" }), probe({ threadId: "r1", role: "research", status: "idle" })];
    expect(live({ probes: idle, kills }).trouble).toEqual([
      { kind: "killed", threadId: "r1", role: "research", reason: "Research hit by the memory guard: tree at 55% of RAM", samMustAct: false },
    ]);
    const working = [probe({ status: "idle" }), probe({ threadId: "r1", role: "research" })];
    expect(live({ probes: working, kills }).trouble).toEqual([]);
    const old = new Map([["r1", { reason: "x", at: NOW - KILL_SHOWN_MS }]]);
    expect(live({ probes: idle, kills: old }).trouble).toEqual([]);
  });

  it("reports a waiting agent as waiting, not stuck", () => {
    const holds = new Map<string, Hold>([["r1", { kind: "memory", reason: "12% free", since: NOW }]]);
    const result = live({ probes: [probe({ status: "idle" }), probe({ threadId: "r1", role: "research", status: "pending" })], holds });
    expect(result).toMatchObject({ working: false, waiting: "waiting for memory: 12% free", trouble: [] });
  });
});

describe("livenessActions", () => {
  const research = (status: Probe["status"], lastEventAt = NOW - 5_000) =>
    live({ probes: [probe({ status: "idle" }), probe({ threadId: "r1", role: "research", status, lastEventAt })] });

  it("stops a silent researcher and tells its task, once", () => {
    const liveness = research("active", NOW - STALE_MS);
    const first = livenessActions({ tasks: [{ liveness, threadId: "thr_task" }], seen: new Set() });
    expect(first.actions.map((action) => action.kind)).toEqual(["stop", "tell-task"]);
    expect(first.actions[0]).toEqual({ kind: "stop", threadId: "r1" });
    const tell = first.actions[1];
    expect(tell?.kind === "tell-task" && tell.message).toContain("I stopped it");
    expect(tell?.kind === "tell-task" && tell.threadId).toBe("thr_task");
    const second = livenessActions({ tasks: [{ liveness, threadId: "thr_task" }], seen: first.open });
    expect(second.actions).toEqual([]);
    expect(second.open).toEqual(first.open);
  });

  it("tells the task about a research error without stopping anything", () => {
    const { actions } = livenessActions({ tasks: [{ liveness: research("error"), threadId: "thr_task" }], seen: new Set() });
    expect(actions.map((action) => action.kind)).toEqual(["tell-task"]);
  });

  it("fails a dead or silent build through failBuildFor, which counts toward BUILD_FAILURE_LIMIT", () => {
    const dead = live({ task: { stage: "build", buildState: "running" }, probes: [probe({ status: "idle" })] });
    expect(livenessActions({ tasks: [{ liveness: dead, threadId: "thr_task" }], seen: new Set() }).actions).toEqual([
      { kind: "fail-build", taskId: "t1", reason: "Build running with no builder thread (The Orchestrator's liveness check)." },
    ]);
    const silent = live({
      task: { stage: "build", buildState: "running" },
      probes: [probe({ status: "idle" }), probe({ threadId: "b1", role: "build", lastEventAt: NOW - STALE_MS })],
    });
    const { actions } = livenessActions({ tasks: [{ liveness: silent, threadId: "thr_task" }], seen: new Set() });
    expect(actions).toEqual([
      { kind: "stop", threadId: "b1" },
      { kind: "fail-build", taskId: "t1", reason: "The builder b1 went silent (no activity for 12 min) and was stopped." },
    ]);
  });

  it("never messages about what the owner must act on, or a kill the guard already told", () => {
    const own = live({ probes: [probe({ status: "error" })] });
    const kills = new Map([["r1", { reason: "x", at: NOW }]]);
    const killed = live({ probes: [probe({ status: "idle" }), probe({ threadId: "r1", role: "research", status: "idle" })], kills });
    const result = livenessActions({ tasks: [{ liveness: own, threadId: "thr_task" }, { liveness: killed, threadId: "thr_task" }], seen: new Set() });
    expect(result.actions).toEqual([]);
    expect(result.open.size).toBe(2);
  });

  it("acts again when an incident clears and comes back", () => {
    const liveness = research("error");
    const first = livenessActions({ tasks: [{ liveness, threadId: "thr_task" }], seen: new Set() });
    const cleared = livenessActions({ tasks: [{ liveness: research("idle"), threadId: "thr_task" }], seen: first.open });
    expect(cleared.open.size).toBe(0);
    expect(livenessActions({ tasks: [{ liveness, threadId: "thr_task" }], seen: cleared.open }).actions).toHaveLength(1);
  });

  it("keys incidents by task, kind and thread", () => {
    expect(incidentKey("t1", { kind: "stale", threadId: "r1", role: "research", reason: "", samMustAct: false })).toBe("t1:stale:r1");
    expect(incidentKey("t1", { kind: "dead-build", threadId: null, role: "build", reason: "", samMustAct: false })).toBe("t1:dead-build:none");
  });
});

describe("indicators", () => {
  const working = live({ probes: [probe()] });
  it("spins from the live status, and trouble or waiting from the check win", () => {
    expect(taskIndicator(undefined, true)).toEqual({ kind: "working" });
    expect(taskIndicator(undefined, false)).toBeNull();
    expect(taskIndicator(working, false)).toBeNull();
    const stale = live({ probes: [probe({ lastEventAt: NOW - STALE_MS })] });
    expect(taskIndicator(stale, true)).toEqual({ kind: "trouble", reason: "Task went silent: no activity for 12 min" });
    const holds = new Map<string, Hold>([["thr_task", { kind: "browser", reason: "t2", since: NOW }]]);
    expect(taskIndicator(live({ probes: [probe()], holds }), true)).toEqual({ kind: "waiting", reason: "waiting for the browser: t2" });
  });

  it("marks one agent's trouble or wait", () => {
    const at = (status: Probe["status"], lastEventAt = NOW) => agentLiveness(probe({ status, lastEventAt }), undefined, NOW);
    expect(agentIndicator(at("error"), false)).toEqual({ kind: "trouble", reason: "stopped with an error" });
    expect(agentIndicator(at("active", NOW - STALE_MS), true)).toMatchObject({ kind: "trouble" });
    expect(agentIndicator(at("pending"), false)).toEqual({ kind: "waiting", reason: "queued to start" });
    expect(agentIndicator(at("idle"), true)).toEqual({ kind: "working" });
    expect(agentIndicator(at("gone"), false)).toBeNull();
  });
});

describe("connection", () => {
  it("counts the last check's age, and says disconnected past DISCONNECTED_MS", () => {
    expect(DISCONNECTED_MS).toBe(90_000);
    expect(connection({ checkedAt: null, error: null, now: NOW })).toEqual({ kind: "checking", label: "Checking agents…" });
    expect(connection({ checkedAt: NOW - 12_000, error: null, now: NOW })).toEqual({ kind: "live", label: "Agents checked 12s ago" });
    expect(connection({ checkedAt: NOW - DISCONNECTED_MS + 1, error: null, now: NOW }).kind).toBe("live");
    expect(connection({ checkedAt: NOW - DISCONNECTED_MS, error: null, now: NOW })).toEqual({
      kind: "disconnected",
      label: "Disconnected: no check since 1 min ago",
    });
  });

  it("says disconnected, with the reason, the moment a poll fails", () => {
    expect(connection({ checkedAt: NOW - 5_000, error: "fetch failed", now: NOW })).toEqual({
      kind: "disconnected",
      label: "Disconnected: fetch failed · last check 5s ago",
    });
    expect(connection({ checkedAt: null, error: "boom", now: NOW }).label).toBe("Disconnected: boom · last check never");
  });
});
