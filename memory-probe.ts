// Reads the machine's memory for the memory guard (memory.ts holds the
// policy and the parsers). Runs in the host worker; kept out of host.ts so
// memory.test.ts can run it for real on whatever machine runs the tests.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  KILL_GRACE_MS,
  THREAD_LOOKUPS,
  TOP_PROCESSES,
  agentTree,
  isBbRoot,
  killTarget,
  neverKill,
  orphanCandidates,
  parseBytes,
  parseMeminfo,
  parseMemoryPressure,
  parseMemorystatusLevel,
  parsePs,
  parsePsTree,
  parseSwapUsed,
  parseThreadIdFromEnv,
  summarizeTree,
  type KillTarget,
  type MemoryReading,
  type PsRow,
} from "./memory.js";

/** Output of a short command, or null when it fails: every probe but the free percentage is optional. */
function probe(command: string, args: string[], signal: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { signal, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
      resolve(error ? null : stdout),
    );
  });
}

/** BB_THREAD_ID from a process's environment (same user only), or null. */
async function threadIdOf(pid: number, signal: AbortSignal): Promise<string | null> {
  const out = await probe("/bin/ps", ["eww", "-o", "command=", "-p", String(pid)], signal);
  return out === null ? null : parseThreadIdFromEnv(out);
}

/**
 * Every process bb's agents started: descendants of bb's own processes, plus
 * big launchd orphans that still carry an agent's BB_THREAD_ID. Null when ps
 * fails.
 */
export async function readAgentTree(signal: AbortSignal): Promise<{ rows: PsRow[]; tree: Set<number> } | null> {
  const out = await probe("/bin/ps", ["-axo", "pid=,ppid=,pgid=,rss=,command="], signal);
  if (out === null) return null;
  const rows = parsePsTree(out);
  const adopted = new Set<number>();
  for (const orphan of orphanCandidates(rows)) {
    if ((await threadIdOf(orphan.pid, signal)) !== null) adopted.add(orphan.pid);
  }
  return { rows, tree: agentTree(rows, (row) => isBbRoot(row.command), adopted) };
}

/**
 * macOS: kern.memorystatus_level is the kernel's own "% available" (what
 * jetsam acts on); memory_pressure -Q is the fallback. Linux: /proc/meminfo.
 * Throws when no free percentage can be read: the guard treats that as
 * "cannot tell", never as "plenty".
 */
export async function readMemory(signal: AbortSignal): Promise<MemoryReading> {
  let freePercent: number | null = null;
  let totalBytes: number | null = null;
  let swapUsedBytes: number | null = null;
  if (process.platform === "darwin") {
    const level = await probe("/usr/sbin/sysctl", ["-n", "kern.memorystatus_level"], signal);
    freePercent = level === null ? null : parseMemorystatusLevel(level);
    if (freePercent === null) {
      const pressure = await probe("/usr/bin/memory_pressure", ["-Q"], signal);
      freePercent = pressure === null ? null : parseMemoryPressure(pressure);
    }
    const memsize = await probe("/usr/sbin/sysctl", ["-n", "hw.memsize"], signal);
    totalBytes = memsize === null ? null : parseBytes(memsize);
    const swap = await probe("/usr/sbin/sysctl", ["-n", "vm.swapusage"], signal);
    swapUsedBytes = swap === null ? null : parseSwapUsed(swap);
  } else {
    const info = parseMeminfo(await readFile("/proc/meminfo", "utf8").catch(() => ""));
    if (info !== null) ({ freePercent, totalBytes, swapUsedBytes } = info);
  }
  if (freePercent === null) throw new Error(`Could not read free memory on ${process.platform}.`);
  const ps = await probe("/bin/ps", ["-ax", "-o", "pid=,rss=,command="], signal);
  const agents = await readAgentTree(signal);
  const summary = agents === null ? null : summarizeTree(agents.rows, agents.tree);
  const heavy = summary?.heavy ?? [];
  for (const p of heavy.slice(0, THREAD_LOOKUPS)) p.threadId = await threadIdOf(p.pid, signal);
  return {
    freePercent,
    totalBytes,
    swapUsedBytes,
    top: ps === null ? [] : parsePs(ps, TOP_PROCESSES),
    treeBytes: summary?.treeBytes ?? null,
    heavy,
    at: Date.now(),
  };
}

const alive = (id: number) => {
  try {
    process.kill(id, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Kill what the guard picked: SIGTERM, then SIGKILL after KILL_GRACE_MS.
 * Re-reads the tree first, so a pid reused since the reading (or a process
 * that left bb's tree, or a group that gained a claude) is never touched.
 */
export async function killAgentProcess(
  input: { pid: number; command: string; target: KillTarget },
  signal: AbortSignal,
): Promise<{ killed: boolean; detail: string }> {
  const agents = await readAgentTree(signal);
  if (agents === null) return { killed: false, detail: "could not list processes" };
  const row = agents.rows.find((r) => r.pid === input.pid);
  if (row === undefined) return { killed: false, detail: `pid ${input.pid} is gone` };
  if (row.command.slice(0, 200) !== input.command.slice(0, 200)) return { killed: false, detail: `pid ${input.pid} is now another command` };
  if (!agents.tree.has(row.pid) || neverKill(row.command)) return { killed: false, detail: `pid ${input.pid} is not a killable agent process` };
  const now = killTarget(agents.rows, agents.tree, row);
  if (now.kind !== input.target.kind || (now.kind === "group" ? now.pgid : now.pid) !== (input.target.kind === "group" ? input.target.pgid : input.target.pid)) {
    return { killed: false, detail: `pid ${input.pid}'s kill scope changed; not killing` };
  }
  const id = now.kind === "group" ? -now.pgid : now.pid;
  try {
    process.kill(id, "SIGTERM");
  } catch (error) {
    return { killed: false, detail: `SIGTERM failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS));
  if (!alive(id)) return { killed: true, detail: "stopped on SIGTERM" };
  try {
    process.kill(id, "SIGKILL");
  } catch {
    // Exited between the check and the kill.
  }
  return { killed: true, detail: `ignored SIGTERM for ${KILL_GRACE_MS / 1000}s; sent SIGKILL` };
}
