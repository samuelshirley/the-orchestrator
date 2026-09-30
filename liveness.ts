// Is each task's agent still alive and making progress? Pure; liveness.test.ts
// pins it. server.ts probes the host every LIVENESS_INTERVAL_MS (one
// listRunning, a get per open-task thread, the last event only for busy ones)
// and acts on `livenessActions`; the board and the sidebar read the snapshot
// through one RPC on the same beat.
//
// The dossier is not the evidence: `buildState: "running"` outlives a builder
// that was archived or whose failure event was missed, and a thread's
// `updatedAt` does not move per event. Status and the last event do.
//
// Idle is not always fine: bb can refuse every message to a thread (a queued
// message's failureReason), e.g. a checkout claim left behind when bb restarted
// mid-setup ("workspace_busy"). That thread is blocked, not idle.
//
// Error is not always stuck either: a turn that failed on a usage limit sits in
// `error` with a retry queued for after the reset (usage.ts). It is waiting,
// never Needs you, and never gets a Restart that would run the turn twice.
// The same goes for a turn that failed because Claude is signed out
// (signin.ts): it waits for the owner to sign in, under one Needs you item.

import { owner } from "./owner.js";
import { clock } from "./usage.js";

/** How often the server checks, and the board asks for the result. */
export const LIVENESS_INTERVAL_MS = 30_000;
/**
 * A working turn with no event for this long is stuck. The longest silence a
 * healthy turn has is one foreground command, which the Bash tool caps at 10
 * minutes; two more are slack for the provider to report it.
 */
export const STALE_MS = 12 * 60_000;
/**
 * The board calls itself disconnected when its last good check is this old.
 * The server's check and the board's poll run on separate 30 s clocks, so a
 * healthy board sees ages up to about 60 s; three beats is a missed one.
 */
export const DISCONNECTED_MS = 90_000;
/** A memory-guard kill stays on the row this long, unless the thread works again. */
export const KILL_SHOWN_MS = 30 * 60_000;
/** A recorded wait (memory hold, browser lease) older than this is not trusted to explain a silence. */
export const HOLD_TRUSTED_MS = 30 * 60_000;

export type AgentRole = "task" | "research" | "build";

/** What the host said about one thread at check time. "gone": archived, deleted or not found. */
export type ProbeStatus = "starting" | "active" | "stopping" | "pending" | "idle" | "error" | "gone";

export interface Probe {
  threadId: string;
  role: AgentRole;
  status: ProbeStatus;
  /** The thread's newest event; read only while it is busy, null otherwise or when unreadable. */
  lastEventAt: number | null;
  /** Why bb refuses to deliver the thread's queued messages (the first failureReason); null when it delivers them. */
  undeliverable: string | null;
  /** An errored thread's last error ("Provisioning thread failed: …"); null when unknown or not errored. */
  error: string | null;
  /** A retry bb holds for it, or a usage-limit hit or sign-in failure being waited out; null when none. */
  limit: LimitWait | null;
}

/**
 * Why a failed turn is coming back on its own: "usage-limit" for a usage
 * limit (provider-retry's "Rate limited" row, or a hit The Orchestrator
 * re-queues after the reset), "retry" for another queued retry (a backoff),
 * "signed-out" for a turn that failed because Claude is signed out and is
 * retried once the owner signs in (signin.ts).
 */
export interface LimitWait {
  kind: "usage-limit" | "retry" | "signed-out";
  /** When it is sent, epoch ms; null when unknown. */
  until: number | null;
}

/** The row's words while Claude is signed out. */
export const signedOutWait = () => `waiting for ${owner()} to sign in to Claude`;

/** The row's words for a limit wait. */
export function limitReason(limit: LimitWait, now: number): string {
  if (limit.kind === "signed-out") return signedOutWait();
  if (limit.kind === "retry") return limit.until === null ? "queued to retry" : `queued to retry at ${clock(limit.until, now)}`;
  return limit.until === null ? "waiting for the usage limit to reset" : `waiting until ${clock(limit.until, now)}: usage limit`;
}

/** Why a turn is not running yet: held by the memory guard or while Claude is signed out, or told to wait for the browser. */
export interface Hold {
  kind: "memory" | "browser" | "signed-out";
  reason: string;
  since: number;
}

export interface Kill {
  reason: string;
  at: number;
}

export type AgentState = "working" | "waiting" | "idle" | "blocked" | "stale" | "error" | "gone";

export interface AgentLiveness {
  threadId: string;
  role: AgentRole;
  state: AgentState;
  /** Short words for the row; null when there is nothing to say. */
  reason: string | null;
}

const BUSY: ReadonlySet<ProbeStatus> = new Set(["starting", "active", "stopping"]);

export const minutes = (ms: number) => Math.max(1, Math.floor(ms / 60_000));

/** bb's words when a checkout is held by another thread's setup (HTTP 409 workspace_busy, or the provider's claim). */
const WORKSPACE_LOCK = /another thread is using this workspace|being prepared by another thread|workspace_busy/i;

const firstLine = (text: string) => (text.split("\n")[0] ?? "").trim().slice(0, 200);

export function isWorkspaceLock(text: string): boolean {
  return WORKSPACE_LOCK.test(text);
}

/** One line for a bb refusal: a workspace lock says so plainly, anything else as bb put it. */
export function describeRefusal(text: string): string {
  const line = firstLine(text);
  return isWorkspaceLock(line) ? `its checkout is locked by a thread bb never finished setting up (bb: "${line}")` : line;
}

const holdReason = (hold: Hold) =>
  hold.kind === "signed-out" ? signedOutWait() : hold.kind === "memory" ? `waiting for memory: ${hold.reason}` : `waiting for the browser: ${hold.reason}`;

/** One thread's state from its probe and what the plugin knows about it. */
export function agentLiveness(probe: Probe, hold: Hold | undefined, now: number): AgentLiveness {
  const base = { threadId: probe.threadId, role: probe.role };
  if (probe.status === "gone") return { ...base, state: "gone", reason: "thread is gone" };
  const trusted = hold !== undefined && now - hold.since < HOLD_TRUSTED_MS ? hold : undefined;
  // A turn that runs is receiving; a hold explains its own wait.
  if (probe.undeliverable !== null && trusted === undefined && !BUSY.has(probe.status)) {
    return { ...base, state: "blocked", reason: `can't receive messages: ${describeRefusal(probe.undeliverable)}` };
  }
  // Failed on a limit with its retry in hand: it comes back by itself, unless
  // bb refuses it (blocked, above). Past the reset the memory guard may hold
  // that retry: then that is the wait.
  if (probe.limit !== null && !BUSY.has(probe.status)) {
    return { ...base, state: "waiting", reason: trusted !== undefined ? holdReason(trusted) : limitReason(probe.limit, now) };
  }
  if (probe.status === "error") {
    return { ...base, state: "error", reason: probe.error === null ? "stopped with an error" : `stopped with an error: ${describeRefusal(probe.error)}` };
  }
  if (trusted !== undefined) {
    return { ...base, state: "waiting", reason: holdReason(trusted) };
  }
  if (probe.status === "pending") return { ...base, state: "waiting", reason: "queued to start" };
  if (!BUSY.has(probe.status)) return { ...base, state: "idle", reason: null };
  if (probe.lastEventAt !== null && now - probe.lastEventAt >= STALE_MS) {
    return { ...base, state: "stale", reason: `no activity for ${minutes(now - probe.lastEventAt)} min` };
  }
  return { ...base, state: "working", reason: null };
}

/**
 * A Patches chat's trouble for the board, or null. Chats are not tasks: no
 * Needs you ticket, no tell; the board's alert line is how the owner hears that the
 * chat they type into will not get their message.
 */
export function chatTrouble(probe: Probe, now: number): string | null {
  const agent = agentLiveness(probe, undefined, now);
  if (agent.state === "stale") return `Patches went silent: ${agent.reason}`;
  return agent.state === "blocked" || agent.state === "error" ? `Patches ${agent.reason}` : null;
}

export type TroubleKind = "error" | "blocked" | "stale" | "dead-build" | "killed";

export interface Trouble {
  kind: TroubleKind;
  threadId: string | null;
  role: AgentRole;
  /** One line for the row and the ticket. */
  reason: string;
  /** Nobody below the owner can fix it: the task's own thread is the one in trouble. */
  samMustAct: boolean;
}

export interface TaskLiveness {
  taskId: string;
  /** Some agent of the task is mid-turn: the row spins. */
  working: boolean;
  /** Why an agent of the task is waiting, when one is; not stuck. */
  waiting: string | null;
  trouble: Trouble[];
  agents: AgentLiveness[];
  /**
   * Why Patches is not told when this task's thread goes idle (its parent is
   * not its project's live chat), or null. The server sets it (chats.ts
   * parentFixes); taskLiveness cannot see parents.
   */
  unheard: string | null;
}

export interface TaskFacts {
  id: string;
  stage: string;
  buildState: string;
  threadId: string | null;
}

const ROLE_WORD: Record<AgentRole, string> = { task: "Task", research: "Research", build: "Builder" };

/**
 * The task's liveness. `probes` carries its task thread and children in
 * creation order; only the latest research and build child count for errors
 * (older ones are history). `kills` holds memory-guard kills by thread.
 */
export function taskLiveness(args: {
  task: TaskFacts;
  probes: readonly Probe[];
  holds: ReadonlyMap<string, Hold>;
  kills: ReadonlyMap<string, Kill>;
  now: number;
}): TaskLiveness {
  const { task, probes, holds, kills, now } = args;
  const agents = probes.map((probe) => agentLiveness(probe, holds.get(probe.threadId), now));
  const latest = (role: AgentRole) => [...agents].reverse().find((agent) => agent.role === role);
  const latestResearch = latest("research");
  const latestBuild = latest("build");
  const trouble: Trouble[] = [];

  for (const agent of agents) {
    const isTask = agent.role === "task";
    if (agent.state === "stale") {
      trouble.push({
        kind: "stale",
        threadId: agent.threadId,
        role: agent.role,
        reason: `${ROLE_WORD[agent.role]} went silent: ${agent.reason}`,
        samMustAct: isTask,
      });
    } else if (agent.state === "blocked") {
      // Only the latest child counts: an older one's undelivered message is history.
      if (isTask || agent === latestResearch || agent === latestBuild) {
        trouble.push({
          kind: "blocked",
          threadId: agent.threadId,
          role: agent.role,
          reason: `${ROLE_WORD[agent.role]} ${agent.reason}`,
          samMustAct: isTask,
        });
      }
    } else if (agent.state === "error") {
      const why = agent.reason?.replace(/^stopped with an error/, "") ?? "";
      if (isTask) {
        trouble.push({ kind: "error", threadId: agent.threadId, role: "task", reason: `Task stopped with an error${why}`, samMustAct: true });
      } else if (agent === latestResearch && task.stage === "research") {
        trouble.push({ kind: "error", threadId: agent.threadId, role: "research", reason: `Research stopped with an error${why}`, samMustAct: false });
      }
      // The latest builder's error is a dead build, below.
    }
    const kill = kills.get(agent.threadId);
    if (kill !== undefined && now - kill.at < KILL_SHOWN_MS && agent.state !== "working") {
      trouble.push({
        kind: "killed",
        threadId: agent.threadId,
        role: agent.role,
        reason: `${ROLE_WORD[agent.role]} hit by the memory guard: ${kill.reason}`,
        samMustAct: false,
      });
    }
  }

  if (task.buildState === "running") {
    if (latestBuild === undefined) {
      trouble.push({ kind: "dead-build", threadId: null, role: "build", reason: "Build running with no builder thread", samMustAct: false });
    } else if (latestBuild.state === "gone" || latestBuild.state === "error") {
      trouble.push({
        kind: "dead-build",
        threadId: latestBuild.threadId,
        role: "build",
        reason: `Build running but its builder ${latestBuild.state === "gone" ? "is gone" : latestBuild.reason ?? latestBuild.state}`,
        samMustAct: false,
      });
    }
  }

  return {
    taskId: task.id,
    working: agents.some((agent) => agent.state === "working"),
    waiting: agents.find((agent) => agent.state === "waiting")?.reason ?? null,
    trouble,
    agents,
    unheard: null,
  };
}

/** Stable per incident: a trouble is acted on once, however many checks see it. */
export function incidentKey(taskId: string, trouble: Trouble): string {
  return `${taskId}:${trouble.kind}:${trouble.threadId ?? "none"}`;
}

export type LivenessAction =
  /** Stop a silent child turn: it holds an agent slot and makes no progress. */
  | { kind: "stop"; threadId: string }
  /** The build is dead: failBuildFor, which tells the task and counts toward BUILD_FAILURE_LIMIT. */
  | { kind: "fail-build"; taskId: string; reason: string }
  /** Tell the task thread; it owns the fix. */
  | { kind: "tell-task"; taskId: string; threadId: string; message: string };

/**
 * What the server does about new incidents. The owner is never messaged: what only
 * they can fix (the task's own thread) reaches them through Needs you, and a dead
 * build reaches them only past BUILD_FAILURE_LIMIT. Kills were told by the
 * guard already. Returns the incidents still open, for next time.
 */
export function livenessActions(args: {
  tasks: readonly { liveness: TaskLiveness; threadId: string | null }[];
  seen: ReadonlySet<string>;
}): { actions: LivenessAction[]; open: Set<string> } {
  const actions: LivenessAction[] = [];
  const open = new Set<string>();
  for (const { liveness, threadId } of args.tasks) {
    for (const trouble of liveness.trouble) {
      const key = incidentKey(liveness.taskId, trouble);
      open.add(key);
      if (args.seen.has(key) || trouble.samMustAct || trouble.kind === "killed") continue;
      if (trouble.kind === "dead-build") {
        actions.push({ kind: "fail-build", taskId: liveness.taskId, reason: `${trouble.reason} (The Orchestrator's liveness check).` });
        continue;
      }
      if (trouble.kind === "stale" && trouble.threadId !== null) {
        actions.push({ kind: "stop", threadId: trouble.threadId });
        if (trouble.role === "build") {
          actions.push({
            kind: "fail-build",
            taskId: liveness.taskId,
            reason: `The builder ${trouble.threadId} went silent (${trouble.reason.replace(/^Builder went silent: /, "")}) and was stopped.`,
          });
          continue;
        }
      }
      if (threadId === null) continue;
      actions.push({ kind: "tell-task", taskId: liveness.taskId, threadId, message: troubleMessage(liveness.taskId, trouble) });
    }
  }
  return { actions, open };
}

/** What the task thread hears about a research agent in trouble. */
export function troubleMessage(taskId: string, trouble: Trouble): string {
  if (trouble.kind === "blocked") {
    return `[The Orchestrator] ${taskId}: ${trouble.reason}. Thread ${trouble.threadId ?? "unknown"}. Telling it more does not help: bb holds every message to it. Carry on without it, or run it again. A locked checkout refuses every thread in it until bb's stale claim is cleared, which only ${owner()} can do; say so in your report rather than retrying.`;
  }
  const what =
    trouble.kind === "stale"
      ? `${trouble.reason}; I stopped it.`
      : `${trouble.reason}.`;
  return `[The Orchestrator] ${taskId}: ${what} Thread ${trouble.threadId ?? "unknown"}. It is yours to fix: read its last output, then run the research again or carry on without it. Do not ask ${owner()} for anything you can run.`;
}

/** The row's one indicator: trouble beats waiting beats working. */
export type Indicator = { kind: "trouble"; reason: string } | { kind: "waiting"; reason: string } | { kind: "working" } | null;

/**
 * `liveWorking` is the host's live status (instant); `liveness` is the last
 * check (30 s). The spinner follows the live status unless the check found
 * the task stuck or waiting.
 */
export function taskIndicator(liveness: TaskLiveness | undefined, liveWorking: boolean): Indicator {
  const trouble = liveness?.trouble[0];
  if (trouble !== undefined) return { kind: "trouble", reason: trouble.reason };
  if (liveness?.waiting != null) return { kind: "waiting", reason: liveness.waiting };
  return liveWorking ? { kind: "working" } : null;
}

/** One agent's indicator, for the sidebar's research and build rows. */
export function agentIndicator(agent: AgentLiveness | undefined, liveWorking: boolean): Indicator {
  if (agent !== undefined && (agent.state === "stale" || agent.state === "error" || agent.state === "blocked")) {
    return { kind: "trouble", reason: agent.reason ?? agent.state };
  }
  if (agent?.state === "waiting") return { kind: "waiting", reason: agent.reason ?? "waiting" };
  return liveWorking ? { kind: "working" } : null;
}

export type Connection =
  | { kind: "checking"; label: string }
  | { kind: "live"; label: string }
  | { kind: "disconnected"; label: string };

/**
 * Whether the board's view is current. `checkedAt` is the server's last
 * completed check, as last received; `error` is the board's last poll failure
 * (null when the last poll worked) or the server's check failure.
 */
export function connection(args: { checkedAt: number | null; error: string | null; now: number }): Connection {
  const { checkedAt, error, now } = args;
  const age = checkedAt === null ? null : Math.max(0, now - checkedAt);
  const ago = age === null ? "never" : age < 60_000 ? `${Math.floor(age / 1000)}s ago` : `${minutes(age)} min ago`;
  if (error !== null) return { kind: "disconnected", label: `Disconnected: ${error} · last check ${ago}` };
  if (age === null) return { kind: "checking", label: "Checking agents…" };
  if (age >= DISCONNECTED_MS) return { kind: "disconnected", label: `Disconnected: no check since ${ago}` };
  return { kind: "live", label: `Agents checked ${ago}` };
}
