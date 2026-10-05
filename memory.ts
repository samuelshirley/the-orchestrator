// Memory guard: The Orchestrator must never take the Mac down. Before the
// guard, only builds were capped (4); tasks and research threads had no limit,
// and one big ask drove the machine to ~28 GB and a crash.
//
// Three layers, all policy here (pure, tested in memory.test.ts); server.ts
// only wires them:
//   1. Admission — every turn an orchestrator agent starts passes the
//      `message.dispatch` hook. Over the active-agent cap, or with memory
//      under DISPATCH_MIN_FREE, the turn WAITS (queued, visible, retried);
//      it never starts a process the Mac cannot hold.
//   2. Builds — `build` refuses under BUILD_MIN_FREE: a build is two `npm ci`s
//      plus type checks and a test suite, the heaviest thing a task does.
//   3. Watchdog — under STOP_BELOW, stop one orchestrator agent per cooldown
//      (builders first, newest first; never a Patches chat) and record the
//      top processes, so the next incident names its culprit.
//   4. Agent tree budget — the free % alone missed the real crashes (Jetsam,
//      2026-09-24: four parallel 4K ffmpeg encodes an agent started with `&`,
//      12.8–17.6 GB, while the guard only counted turns). Every process bb's
//      agents start is summed; over TREE_HOLD_FRACTION of RAM new turns and
//      builds wait, and over TREE_KILL_FRACTION (or one process over
//      PROCESS_KILL_FRACTION) the largest one is killed with its process
//      group, so `cmd &` siblings go together. Never claude, bb, Chrome or
//      anything under /Applications/.
//
// A memory reading that is missing or stale counts as "cannot tell", and
// cannot-tell waits: a broken sensor must show up as queued work with its
// reason, never as a silently disabled guard.

/** Queue new agent turns below this % free (macOS kern.memorystatus_level). */
export const DISPATCH_MIN_FREE = 20;
/** Refuse a new build below this % free. */
export const BUILD_MIN_FREE = 30;
/** Stop running agents below this % free. */
export const STOP_BELOW = 10;
/** Orchestrator agent turns (task, research, build) running at once. */
export const MAX_ACTIVE_AGENTS = 4;
/** New turns wait and builds refuse when bb's agent tree holds this share of RAM. */
export const TREE_HOLD_FRACTION = 0.4;
/** Kill the largest agent process when the tree holds this share of RAM… */
export const TREE_KILL_FRACTION = 0.55;
/** …or when one agent process alone holds this share. */
export const PROCESS_KILL_FRACTION = 0.25;
/** Between process kills: let the Mac release the memory first. */
export const PROCESS_KILL_COOLDOWN_MS = 10_000;
/** SIGTERM, then SIGKILL after this long if still alive. */
export const KILL_GRACE_MS = 5_000;
/** Agent processes carried in a reading (the heaviest). */
export const HEAVY_PROCESSES = 8;
/** Of those, how many get their BB_THREAD_ID read (one ps call each). */
export const THREAD_LOOKUPS = 3;
/** A process launchd adopted (its agent's shell died) this big is checked for BB_THREAD_ID. */
export const ORPHAN_MIN_BYTES = 512 * 1024 ** 2;
/** Orphans checked per reading. */
export const ORPHAN_LOOKUPS = 3;
/** The guard logs a heartbeat at most this often, so the logs prove it runs. */
export const HEARTBEAT_MS = 10 * 60_000;
export const WATCHDOG_INTERVAL_MS = 10_000;
/** After a stop, give the Mac this long to release memory before another. */
export const STOP_COOLDOWN_MS = 30_000;
/** A reading older than this is not a reading. */
export const READING_MAX_AGE_MS = 45_000;
/** A waiting turn is re-asked at least this often (the recheck is the fast path). */
export const WAIT_RETRY_MS = 30_000;
/** Processes named in a snapshot. */
export const TOP_PROCESSES = 8;

export type ProcessSample = { pid: number; rssBytes: number; command: string };

/** Kill a whole process group (a shell and its `&` children) or one pid. */
export type KillTarget = { kind: "group"; pgid: number } | { kind: "pid"; pid: number };

/** One of the heaviest processes bb's agents started. */
export type HeavyProcess = {
  pid: number;
  pgid: number;
  rssBytes: number;
  command: string;
  /** BB_THREAD_ID from its environment; null when absent or not read. */
  threadId: string | null;
  /** What killing it means; null when it must never be killed (claude, bb, /Applications/). */
  target: KillTarget | null;
};

export type MemoryReading = {
  /** 0–100: how much memory the OS considers available. */
  freePercent: number;
  totalBytes: number | null;
  swapUsedBytes: number | null;
  /** Largest resident processes, biggest first. */
  top: ProcessSample[];
  /** Resident bytes of every process bb's agents started; null when ps failed. */
  treeBytes: number | null;
  /** The heaviest of those, biggest first. */
  heavy: HeavyProcess[];
  /** Epoch ms the host read it. */
  at: number;
};

export type AgentRole = "task" | "research" | "build";

// ------------------------------------------------------------------ parsers

/** `sysctl -n kern.memorystatus_level` → "43". */
export function parseMemorystatusLevel(out: string): number | null {
  const trimmed = out.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value <= 100 ? value : null;
}

/** `memory_pressure -Q` → "System-wide memory free percentage: 43%". */
export function parseMemoryPressure(out: string): number | null {
  const match = /free percentage:\s*(\d{1,3})%/i.exec(out);
  if (match === null) return null;
  const value = Number(match[1]);
  return value <= 100 ? value : null;
}

/** `sysctl -n hw.memsize` → "17179869184". */
export function parseBytes(out: string): number | null {
  const trimmed = out.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

const UNIT: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** `sysctl -n vm.swapusage` → "total = 2048.00M  used = 1234.50M  free = 813.50M  (encrypted)". */
export function parseSwapUsed(out: string): number | null {
  const match = /used\s*=\s*([\d.]+)([KMGT])/i.exec(out);
  if (match === null) return null;
  return Math.round(Number(match[1]) * (UNIT[match[2]!.toUpperCase()] ?? 1));
}

/** Linux fallback: /proc/meminfo. */
export function parseMeminfo(text: string): { freePercent: number; totalBytes: number; swapUsedBytes: number } | null {
  const kb = (key: string) => {
    const match = new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(text);
    return match === null ? null : Number(match[1]) * 1024;
  };
  const total = kb("MemTotal");
  const available = kb("MemAvailable");
  if (total === null || available === null || total === 0) return null;
  const swapTotal = kb("SwapTotal") ?? 0;
  const swapFree = kb("SwapFree") ?? 0;
  return {
    freePercent: Math.floor((available / total) * 100),
    totalBytes: total,
    swapUsedBytes: swapTotal - swapFree,
  };
}

/** `ps -ax -o pid=,rss=,command=` (rss in KiB on macOS and Linux) → the biggest first. */
export function parsePs(out: string, limit = TOP_PROCESSES): ProcessSample[] {
  const rows: ProcessSample[] = [];
  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match === null) continue;
    rows.push({ pid: Number(match[1]), rssBytes: Number(match[2]) * 1024, command: match[3]!.slice(0, 200) });
  }
  return rows.sort((a, b) => b.rssBytes - a.rssBytes).slice(0, limit);
}

// ------------------------------------------------------------ agent tree

export type PsRow = { pid: number; ppid: number; pgid: number; rssBytes: number; command: string };

/**
 * `ps -axo pid=,ppid=,pgid=,rss=,command=` (rss in KiB). No comm column:
 * macOS truncates it to 16 characters, so the executable comes from the
 * command's first word (see executable()).
 */
export function parsePsTree(out: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match === null) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      rssBytes: Number(match[4]) * 1024,
      command: match[5]!.slice(0, 1000),
    });
  }
  return rows;
}

const words = (command: string) => command.trim().split(/\s+/);
const base = (path: string) => path.replace(/.*\//, "").toLowerCase();

/**
 * bb's own processes, by executable name only (never by arguments, so a
 * shell that merely mentions a bb path is not one), as memwatch.sh bb_pids():
 * an executable called bb, BB, bb-daemon…, an app bundle BB.app, or
 * node/bun/deno running bb, bb-app, bb-server, bb-host-daemon or any script
 * inside the bb-app package (the server, host daemon and plugin workers).
 */
export function isBbRoot(command: string): boolean {
  const [exe = "", arg = ""] = words(command);
  if (/^bb([-.]|$)/.test(base(exe))) return true;
  if (/^\/([^ ]*\/)?bb\.app\/contents\/macos\//.test(command.toLowerCase())) return true;
  const runtime = ["node", "bun", "deno"].includes(base(exe));
  return runtime && (/^bb([-.]|$)/.test(base(arg)) || arg.includes("/node_modules/bb-app/"));
}

/** Claude Code itself: ~/.local/bin/claude, its version-named binary (…/claude/versions/2.1.281), or the npm package. */
export function isClaude(command: string): boolean {
  const [exe = ""] = words(command);
  const name = base(exe);
  return (
    name === "claude" ||
    /\/claude\/versions\//.test(exe) ||
    /^\d+\.\d+\.\d+/.test(name) ||
    command.includes("/@anthropic-ai/claude-code/")
  );
}

/** Never killed by the guard: bb, claude, and (defense in depth) the owner's apps and Chrome. */
export function neverKill(command: string): boolean {
  return (
    isBbRoot(command) ||
    isClaude(command) ||
    command.startsWith("/Applications/") ||
    command.startsWith("/System/")
  );
}

/**
 * Pids of everything bb's agents started: every descendant of a bb root
 * (not the roots), plus processes adopted by launchd that still carry an
 * agent's BB_THREAD_ID (a stopped thread's `cmd &` survivors) and theirs.
 */
export function agentTree(rows: readonly PsRow[], isRoot: (row: PsRow) => boolean, adopted: ReadonlySet<number> = new Set()): Set<number> {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    if (row.pid === row.ppid) continue;
    const list = children.get(row.ppid) ?? [];
    list.push(row.pid);
    children.set(row.ppid, list);
  }
  const roots = new Set(rows.filter(isRoot).map((row) => row.pid));
  // An adopted orphan's group-mates launchd also adopted are the same `&` batch.
  const groups = new Set(rows.filter((row) => adopted.has(row.pid)).map((row) => row.pgid));
  const orphans = rows.filter((row) => row.ppid === 1 && groups.has(row.pgid) && !neverKill(row.command)).map((row) => row.pid);
  const seen = new Set<number>();
  const queue = [...roots, ...adopted, ...orphans];
  while (queue.length > 0) {
    const pid = queue.pop() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  for (const pid of roots) seen.delete(pid);
  for (const pid of seen) if (!rows.some((row) => row.pid === pid)) seen.delete(pid);
  return seen;
}

/** Big launchd orphans worth one `ps eww` each: they may be an agent's leftovers. */
export function orphanCandidates(rows: readonly PsRow[], limit = ORPHAN_LOOKUPS): PsRow[] {
  return rows
    .filter((row) => row.ppid === 1 && row.rssBytes >= ORPHAN_MIN_BYTES && !neverKill(row.command) && !/^\/(usr|sbin|bin|Library)\//.test(row.command))
    .sort((a, b) => b.rssBytes - a.rssBytes)
    .slice(0, limit);
}

/** `ps eww -o command= -p <pid>` (command then environment) → its BB_THREAD_ID, or null. */
export function parseThreadIdFromEnv(out: string): string | null {
  const match = /(?:^|\s)BB_THREAD_ID=([A-Za-z0-9_-]{1,100})(?=\s|$)/.exec(out);
  return match === null ? null : match[1]!;
}

/**
 * The victim's whole process group when its leader is one of the agent
 * processes and every member is a killable agent process (so a shell and
 * its `&` children go together); otherwise the pid alone. claude and the
 * bb-provider worker share a group with their MCP servers: that group is
 * never killed whole.
 */
export function killTarget(rows: readonly PsRow[], tree: ReadonlySet<number>, victim: PsRow): KillTarget {
  const members = rows.filter((row) => row.pgid === victim.pgid);
  const leader = members.find((row) => row.pid === victim.pgid);
  const whole =
    victim.pgid > 1 &&
    leader !== undefined &&
    members.every((row) => tree.has(row.pid) && !neverKill(row.command));
  return whole ? { kind: "group", pgid: victim.pgid } : { kind: "pid", pid: victim.pid };
}

/** Tree size and its heaviest processes, each with its kill target (threadId filled in by the probe). */
export function summarizeTree(rows: readonly PsRow[], tree: ReadonlySet<number>, limit = HEAVY_PROCESSES): { treeBytes: number; heavy: HeavyProcess[] } {
  const members = rows.filter((row) => tree.has(row.pid));
  const treeBytes = members.reduce((sum, row) => sum + row.rssBytes, 0);
  const heavy = members
    .sort((a, b) => b.rssBytes - a.rssBytes)
    .slice(0, limit)
    .map((row) => ({
      pid: row.pid,
      pgid: row.pgid,
      rssBytes: row.rssBytes,
      command: row.command.slice(0, 200),
      threadId: null,
      target: neverKill(row.command) ? null : killTarget(rows, tree, row),
    }));
  return { treeBytes, heavy };
}

// ------------------------------------------------------------------ policy

export function readingProblem(reading: MemoryReading | null, now: number): string | null {
  if (reading === null) return "no memory reading from the Mac yet";
  if (now - reading.at > READING_MAX_AGE_MS) {
    return `the last memory reading is ${Math.round((now - reading.at) / 1000)}s old`;
  }
  return null;
}

/** Why the agent tree cannot be judged on an otherwise fresh reading; null when it can. */
function treeProblem(reading: MemoryReading): string | null {
  if (reading.totalBytes === null || reading.totalBytes <= 0) return "the Mac's total memory is unknown";
  if (reading.treeBytes === null) return "bb's agent processes could not be listed";
  return null;
}

/** Why new work must wait on a fresh, complete reading: low free memory or a big agent tree; null when it may start. */
export function memoryHold(reading: MemoryReading, minFree: number): string | null {
  if (reading.freePercent < minFree) return `the Mac has ${reading.freePercent}% memory free (needs ${minFree}%)`;
  const total = reading.totalBytes as number;
  const tree = reading.treeBytes as number;
  if (tree >= total * TREE_HOLD_FRACTION) {
    const top = reading.heavy[0];
    return `bb's agents are using ${gib(tree)} of ${gib(total)} (limit ${gib(total * TREE_HOLD_FRACTION)})${top ? `; the largest is ${describeProcess(top)}` : ""}`;
  }
  return null;
}

export type DispatchDecision = { action: "proceed" } | { action: "wait"; reason: string };

/**
 * Whether an orchestrator agent may start a turn now. Joining a turn that is
 * already running asks for nothing new; a message the owner typed themself is their
 * call; everything else is held to the cap and the memory floor.
 */
export function dispatchDecision(args: {
  attempt: "start-turn" | "join-turn";
  sentBySam: boolean;
  threadId: string;
  /** Orchestrator agent threads with a turn running now. */
  active: ReadonlySet<string>;
  reading: MemoryReading | null;
  now: number;
}): DispatchDecision {
  if (args.attempt === "join-turn" || args.sentBySam) return { action: "proceed" };
  const others = [...args.active].filter((id) => id !== args.threadId).length;
  if (others >= MAX_ACTIVE_AGENTS) {
    return {
      action: "wait",
      reason: `The Orchestrator: ${others} agents are already working (limit ${MAX_ACTIVE_AGENTS}); this starts when one finishes.`,
    };
  }
  const problem = readingProblem(args.reading, args.now);
  if (problem !== null) {
    return { action: "wait", reason: `The Orchestrator: waiting because ${problem}, so it cannot tell whether the Mac has room.` };
  }
  const reading = args.reading as MemoryReading;
  const blind = treeProblem(reading);
  if (blind !== null) {
    return { action: "wait", reason: `The Orchestrator: waiting because ${blind}, so it cannot tell whether the Mac has room.` };
  }
  const hold = memoryHold(reading, DISPATCH_MIN_FREE);
  if (hold !== null) return { action: "wait", reason: `The Orchestrator: ${hold}; this starts when memory frees up.` };
  return { action: "proceed" };
}

/** Why a build may not start now; null when it may. */
export function buildRefusal(reading: MemoryReading | null, now: number): string | null {
  const problem = readingProblem(reading, now);
  if (problem !== null) return `Not starting a build: ${problem}, so it cannot tell whether the Mac has room. Try again shortly.`;
  const r = reading as MemoryReading;
  const blind = treeProblem(r);
  if (blind !== null) return `Not starting a build: ${blind}, so it cannot tell whether the Mac has room. Try again shortly.`;
  const hold = memoryHold(r, BUILD_MIN_FREE);
  if (hold !== null) return `Not starting a build: ${hold}. Wait for running work to finish, then build again.`;
  return null;
}

/** A thread status that holds a slot: its turn is starting, running or still stopping. */
export function isWorking(status: string): boolean {
  return status === "active" || status === "starting" || status === "stopping";
}

export type RunningAgent = { threadId: string; role: AgentRole; since: number };

/**
 * Which agent the watchdog stops, or null when it should not stop one: only
 * under STOP_BELOW, only once per STOP_COOLDOWN_MS, and only orchestrator
 * agents (never a Patches chat, never the owner's other threads). Builders go first
 * (they run the heaviest commands), then research, then tasks; newest first,
 * so the oldest work — the closest to done — survives.
 */
export function pickVictim(args: {
  reading: MemoryReading | null;
  running: readonly RunningAgent[];
  lastStopAt: number | null;
  now: number;
}): RunningAgent | null {
  if (readingProblem(args.reading, args.now) !== null) return null;
  if ((args.reading as MemoryReading).freePercent >= STOP_BELOW) return null;
  if (args.lastStopAt !== null && args.now - args.lastStopAt < STOP_COOLDOWN_MS) return null;
  const order: Record<AgentRole, number> = { build: 0, research: 1, task: 2 };
  const sorted = [...args.running].sort((a, b) => order[a.role] - order[b.role] || b.since - a.since);
  return sorted[0] ?? null;
}

export type ProcessKill = { victim: HeavyProcess; target: KillTarget; why: string };

/**
 * The agent process to kill, or null: when the agent tree holds
 * TREE_KILL_FRACTION of RAM (its largest killable process) or one killable
 * process alone holds PROCESS_KILL_FRACTION, at most once per
 * PROCESS_KILL_COOLDOWN_MS. Never on a reading it cannot trust, never a
 * process without a target (claude, bb, /Applications/).
 */
export function pickProcessKill(reading: MemoryReading | null, lastKillAt: number | null, now: number): ProcessKill | null {
  if (readingProblem(reading, now) !== null) return null;
  const r = reading as MemoryReading;
  if (treeProblem(r) !== null) return null;
  if (lastKillAt !== null && now - lastKillAt < PROCESS_KILL_COOLDOWN_MS) return null;
  const total = r.totalBytes as number;
  const tree = r.treeBytes as number;
  const killable = [...r.heavy]
    .filter((p) => p.target !== null && !neverKill(p.command))
    .sort((a, b) => b.rssBytes - a.rssBytes);
  const victim = killable[0];
  if (victim === undefined) return null;
  const target = victim.target as KillTarget;
  if (victim.rssBytes >= total * PROCESS_KILL_FRACTION) {
    return { victim, target, why: `one agent process holds ${gib(victim.rssBytes)} of ${gib(total)} (limit ${gib(total * PROCESS_KILL_FRACTION)})` };
  }
  if (tree >= total * TREE_KILL_FRACTION) {
    return { victim, target, why: `bb's agents are using ${gib(tree)} of ${gib(total)} (limit ${gib(total * TREE_KILL_FRACTION)})` };
  }
  return null;
}

function gib(bytes: number) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function describeProcess(p: { pid: number; rssBytes: number; command: string }): string {
  return `${p.command.slice(0, 100)} (pid ${p.pid}, ${gib(p.rssBytes)})`;
}

/** For the logs: tree size and the heaviest agent processes. */
export function describeTree(reading: MemoryReading, count = 5): string {
  const head = `agent tree ${reading.treeBytes === null ? "unknown" : gib(reading.treeBytes)}`;
  const lines = reading.heavy
    .slice(0, count)
    .map((p) => `- ${gib(p.rssBytes)}  pid ${p.pid} pgid ${p.pgid}${p.threadId ? ` ${p.threadId}` : ""}${p.target === null ? " (never killed)" : ""}  ${p.command.slice(0, 120)}`);
  return [head, ...lines].join("\n");
}

/** What the agent whose process was killed hears. */
export function killedMessage(kill: ProcessKill, reading: MemoryReading): string {
  const group = kill.target.kind === "group" ? " and its process group" : "";
  const total = reading.totalBytes === null ? "" : ` of ${gib(reading.totalBytes)}`;
  const tree = reading.treeBytes === null ? "" : `: bb's agents were using ${gib(reading.treeBytes)}${total}`;
  return `The Orchestrator killed ${describeProcess(kill.victim)}${group}${tree}. Run heavy commands one at a time, never several in the background with &; cap threads (ffmpeg -threads 2, fewer test workers).`;
}

export function describeReading(reading: MemoryReading): string {
  const parts = [`${reading.freePercent}% free`];
  if (reading.totalBytes !== null) parts.push(`of ${gib(reading.totalBytes)}`);
  if (reading.swapUsedBytes !== null) parts.push(`swap ${gib(reading.swapUsedBytes)}`);
  return parts.join(", ");
}

export function describeTop(reading: MemoryReading, count = 5): string {
  return reading.top
    .slice(0, count)
    .map((p) => `- ${gib(p.rssBytes)}  pid ${p.pid}  ${p.command.slice(0, 120)}`)
    .join("\n");
}

/** What the stopped agent's task hears (queued until memory lets it run). */
export function stoppedMessage(victim: RunningAgent, reading: MemoryReading): string {
  const what = victim.role === "build" ? "your builder" : victim.role === "research" ? "a research thread" : "this task";
  return [
    `The Orchestrator stopped ${what} (${victim.threadId}): the Mac was down to ${describeReading(reading)}, under the ${STOP_BELOW}% floor.`,
    "Largest processes at the time:",
    describeTop(reading),
    victim.role === "build"
      ? "The build is marked failed with its worktree kept; build again once memory is back. If the builder's own commands were the big ones, make them lighter (fewer test workers, one check at a time) before rebuilding."
      : "Start it again once memory is back, lighter if its own commands were the big ones.",
  ].join("\n");
}
