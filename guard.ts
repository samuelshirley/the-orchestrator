// The memory guard's moving parts: the readings, the set of agents working
// now, the dispatch decision and the watchdog tick. Policy is memory.ts;
// server.ts wires this to bb (hook, events, timer) and supplies the effects
// through `deps`, so guard.test.ts drives the whole loop without bb.
import type { MessageDispatchHookContext, MessageDispatchHookDecision } from "@get-bb/plugin-sdk";
import {
  DISPATCH_MIN_FREE,
  HEARTBEAT_MS,
  WAIT_RETRY_MS,
  describeReading,
  describeTop,
  describeTree,
  dispatchDecision,
  isWorking,
  killedMessage,
  memoryHold,
  pickProcessKill,
  pickVictim,
  type AgentRole,
  type HeavyProcess,
  type KillTarget,
  type MemoryReading,
  type RunningAgent,
} from "./memory.js";

type ThreadRef = { id: string; originPluginId?: string | null; parentThreadId?: string | null };

export type GuardDeps = {
  /** task / research / build for an orchestrator agent; null for Patches and everything else. */
  roleOf(thread: ThreadRef): AgentRole | null;
  /** Hosts holding project checkouts. */
  hosts(): Promise<string[]>;
  readMemory(hostId: string): Promise<MemoryReading>;
  /** Ids bb reports as running. */
  runningIds(): Promise<string[]>;
  /** The thread's status, or null when it is gone. */
  thread(id: string): Promise<ThreadRef & { status: string } | null>;
  /** Stop the agent and tell its task; the guard has already logged it. */
  stop(victim: RunningAgent, reading: MemoryReading): Promise<void>;
  /** Kill one agent process on the host (its group or pid); the host re-verifies it first. */
  killProcess(hostId: string, victim: HeavyProcess, target: KillTarget): Promise<{ killed: boolean; detail: string }>;
  /** Tell the thread whose process was killed (and its task). */
  tellOwner(threadId: string, message: string): Promise<void>;
  /** Ask bb to re-decide every turn waiting on this plugin. */
  recheck(): void;
  warn(message: string): void;
  info(message: string): void;
  now(): number;
};

/** A reading the hold can judge: fresh enough is the caller's check; this one needs the totals. */
const holdOf = (reading: MemoryReading) =>
  reading.totalBytes === null || reading.treeBytes === null ? "cannot tell" : memoryHold(reading, DISPATCH_MIN_FREE);

export function createMemoryGuard(deps: GuardDeps) {
  const readings = new Map<string, MemoryReading>();
  const active = new Map<string, RunningAgent>();
  let lastStopAt: number | null = null;
  let lastKillAt: number | null = null;
  let lastWarned: string | null = null;
  let lastHeartbeat: number | null = null;
  let ticking = false;

  /** The reading for a host, or the lowest one when the host is unknown. */
  function readingFor(hostId: string | null | undefined): MemoryReading | null {
    if (hostId !== null && hostId !== undefined && readings.has(hostId)) return readings.get(hostId) ?? null;
    let worst: MemoryReading | null = null;
    for (const reading of readings.values()) {
      if (worst === null || reading.freePercent < worst.freePercent) worst = reading;
    }
    return worst;
  }

  function decide(context: MessageDispatchHookContext): MessageDispatchHookDecision {
    const role = deps.roleOf(context.thread);
    if (role === null) return { action: "proceed" };
    const now = deps.now();
    const decision = dispatchDecision({
      attempt: context.attempt,
      sentBySam: context.initiator === "user" && context.senderThreadId === null,
      threadId: context.thread.id,
      active: new Set(active.keys()),
      reading: readingFor(context.host?.id),
      now,
    });
    if (decision.action === "wait") return { action: "wait", reason: decision.reason, sendAt: now + WAIT_RETRY_MS };
    // Claim the slot now: the next decision may come before thread.active.
    if (context.attempt === "start-turn" && !active.has(context.thread.id)) {
      active.set(context.thread.id, { threadId: context.thread.id, role, since: now });
    }
    return decision;
  }

  function onActive(thread: ThreadRef) {
    if (active.has(thread.id)) return;
    const role = deps.roleOf(thread);
    if (role !== null) active.set(thread.id, { threadId: thread.id, role, since: deps.now() });
  }

  function onDone(threadId: string) {
    if (active.delete(threadId)) deps.recheck();
  }

  async function readHosts() {
    for (const hostId of await deps.hosts()) {
      try {
        const reading = await deps.readMemory(hostId);
        const before = readings.get(hostId);
        readings.set(hostId, reading);
        const summary = `${describeReading(reading)}, ${describeTree(reading, 0)}`;
        if (lastHeartbeat === null) {
          deps.info(`memory guard: live, ${summary}`);
          lastHeartbeat = reading.at;
        } else if (reading.at - lastHeartbeat >= HEARTBEAT_MS) {
          deps.info(`memory guard: ${summary}`);
          lastHeartbeat = reading.at;
        }
        const hold = holdOf(reading);
        if (hold !== null && hold !== lastWarned) {
          deps.warn(`memory guard: ${hold}; holding new agent turns\n${describeTree(reading, 8)}\n${describeTop(reading, 8)}`);
          lastWarned = hold;
        }
        // First reading, or memory back: release what waited.
        if (hold === null && (before === undefined || holdOf(before) !== null)) {
          lastWarned = null;
          deps.recheck();
        }
      } catch (error) {
        deps.warn(`memory guard: reading memory on ${hostId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Kill the one agent process that is taking the Mac down, if any. True when it acted. */
  async function killHeavy(): Promise<boolean> {
    for (const [hostId, reading] of readings) {
      const kill = pickProcessKill(reading, lastKillAt, deps.now());
      if (kill === null) continue;
      lastKillAt = deps.now();
      deps.warn(
        `memory guard: ${kill.why}; killing ${kill.target.kind === "group" ? `process group ${kill.target.pgid}` : `pid ${kill.victim.pid}`} (${kill.victim.command.slice(0, 120)}) at ${describeReading(reading)}\n${describeTree(reading, 8)}`,
      );
      try {
        const result = await deps.killProcess(hostId, kill.victim, kill.target);
        if (!result.killed) {
          deps.warn(`memory guard: did not kill pid ${kill.victim.pid}: ${result.detail}`);
          continue;
        }
        deps.warn(`memory guard: killed pid ${kill.victim.pid}: ${result.detail}`);
      } catch (error) {
        deps.warn(`memory guard: killing pid ${kill.victim.pid} failed: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (kill.victim.threadId === null) {
        deps.warn(`memory guard: pid ${kill.victim.pid} had no BB_THREAD_ID; no one to tell`);
      } else {
        await deps.tellOwner(kill.victim.threadId, killedMessage(kill, reading)).catch((error: unknown) => {
          deps.warn(`memory guard: telling ${kill.victim.threadId} failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      return true;
    }
    return false;
  }

  /**
   * Keep the active set honest: a thread that stopped without an event (a
   * reload, a crash) must not hold a slot forever, and one already working
   * when the plugin loaded must count. Status decides, per thread.
   */
  async function reconcile() {
    const candidates = new Set([...active.keys(), ...(await deps.runningIds())]);
    let freed = false;
    for (const id of candidates) {
      const thread = await deps.thread(id).catch(() => null);
      if (thread === null || !isWorking(thread.status)) {
        if (active.delete(id)) freed = true;
        continue;
      }
      onActive(thread);
    }
    if (freed) deps.recheck();
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await readHosts();
      try {
        await reconcile();
      } catch (error) {
        deps.warn(`memory guard: reconciling running threads failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await killHeavy();
      const reading = readingFor(null);
      const victim = pickVictim({ reading, running: [...active.values()], lastStopAt, now: deps.now() });
      if (victim === null || reading === null) return;
      lastStopAt = deps.now();
      active.delete(victim.threadId);
      deps.warn(`memory guard: stopping ${victim.role} ${victim.threadId} at ${describeReading(reading)}\n${describeTop(reading, 8)}`);
      try {
        await deps.stop(victim, reading);
      } catch (error) {
        deps.warn(`memory guard: stopping ${victim.threadId} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      ticking = false;
    }
  }

  return { decide, onActive, onDone, tick, readingFor, activeIds: () => [...active.keys()] };
}
