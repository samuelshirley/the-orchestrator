import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  PROCESS_KILL_COOLDOWN_MS,
  PROCESS_KILL_FRACTION,
  TREE_HOLD_FRACTION,
  TREE_KILL_FRACTION,
  agentTree,
  isBbRoot,
  isClaude,
  killTarget,
  killedMessage,
  neverKill,
  orphanCandidates,
  parsePsTree,
  parseThreadIdFromEnv,
  pickProcessKill,
  summarizeTree,
  type HeavyProcess,
  type PsRow,
  BUILD_MIN_FREE,
  DISPATCH_MIN_FREE,
  MAX_ACTIVE_AGENTS,
  READING_MAX_AGE_MS,
  STOP_BELOW,
  STOP_COOLDOWN_MS,
  buildRefusal,
  dispatchDecision,
  isWorking,
  parseBytes,
  parseMeminfo,
  parseMemoryPressure,
  parseMemorystatusLevel,
  parsePs,
  parseSwapUsed,
  pickVictim,
  stoppedMessage,
  type MemoryReading,
  type RunningAgent,
} from "./memory.js";
import { readMemory } from "./memory-probe.js";

const NOW = 1_800_000_000_000;
const GB = 1024 ** 3;
const TOTAL = 16 * GB;
const reading = (freePercent: number, at = NOW): MemoryReading => ({
  freePercent,
  totalBytes: 16 * 1024 ** 3,
  swapUsedBytes: 3 * 1024 ** 3,
  top: [{ pid: 42, rssBytes: 9 * 1024 ** 3, command: "node /Users/me/acme-shop/.claude/worktrees/x/node_modules/.bin/tsc --noEmit" }],
  treeBytes: GB,
  heavy: [],
  at,
});
const ids = (n: number) => new Set(Array.from({ length: n }, (_, i) => `thr_${i}`));
const turn = (over: Partial<Parameters<typeof dispatchDecision>[0]> = {}) =>
  dispatchDecision({ attempt: "start-turn", sentBySam: false, threadId: "thr_new", active: new Set(), reading: reading(60), now: NOW, ...over });

describe("parsers", () => {
  it("reads macOS kern.memorystatus_level", () => {
    expect(parseMemorystatusLevel("43\n")).toBe(43);
    expect(parseMemorystatusLevel("0")).toBe(0);
    expect(parseMemorystatusLevel("")).toBeNull();
    expect(parseMemorystatusLevel("sysctl: unknown oid")).toBeNull();
    expect(parseMemorystatusLevel("101")).toBeNull();
  });
  it("reads memory_pressure -Q", () => {
    expect(parseMemoryPressure("The system has 17179869184 (1048576 pages with a page size of 16384).\nSystem-wide memory free percentage: 27%\n")).toBe(27);
    expect(parseMemoryPressure("nothing")).toBeNull();
  });
  it("reads hw.memsize and vm.swapusage", () => {
    expect(parseBytes("17179869184\n")).toBe(17179869184);
    expect(parseBytes("x")).toBeNull();
    expect(parseSwapUsed("total = 2048.00M  used = 1024.00M  free = 1024.00M  (encrypted)")).toBe(1024 ** 3);
    expect(parseSwapUsed("total = 12.00G  used = 10.50G  free = 1.50G  (encrypted)")).toBe(Math.round(10.5 * 1024 ** 3));
    expect(parseSwapUsed("")).toBeNull();
  });
  it("reads /proc/meminfo", () => {
    const info = parseMeminfo("MemTotal:       4000000 kB\nMemFree:  100 kB\nMemAvailable:   1000000 kB\nSwapTotal: 2000 kB\nSwapFree: 500 kB\n");
    expect(info).toEqual({ freePercent: 25, totalBytes: 4000000 * 1024, swapUsedBytes: 1500 * 1024 });
    expect(parseMeminfo("MemTotal: 10 kB\n")).toBeNull();
  });
  it("ranks ps rows by resident size, KiB to bytes", () => {
    const top = parsePs("  1   1024 /sbin/launchd\n 77 9437184 node tsc --noEmit\n  5  2048 zsh\ngarbage\n", 2);
    expect(top).toEqual([
      { pid: 77, rssBytes: 9437184 * 1024, command: "node tsc --noEmit" },
      { pid: 5, rssBytes: 2048 * 1024, command: "zsh" },
    ]);
  });
});

describe("dispatchDecision", () => {
  it("lets an agent start a turn with room and a fresh reading", () => {
    expect(turn()).toEqual({ action: "proceed" });
  });
  it("never holds a turn that is already running, or a message the owner typed", () => {
    const hostile = { active: ids(MAX_ACTIVE_AGENTS + 3), reading: reading(1) };
    expect(turn({ ...hostile, attempt: "join-turn" }).action).toBe("proceed");
    expect(turn({ ...hostile, sentBySam: true }).action).toBe("proceed");
  });
  it("allows 4 agent turns at once", () => {
    expect(MAX_ACTIVE_AGENTS).toBe(4);
  });
  it(`holds the ${MAX_ACTIVE_AGENTS + 1}th agent`, () => {
    expect(turn({ active: ids(MAX_ACTIVE_AGENTS - 1) }).action).toBe("proceed");
    const held = turn({ active: ids(MAX_ACTIVE_AGENTS) });
    expect(held.action).toBe("wait");
    expect(held.action === "wait" && held.reason).toMatch(/already working/);
  });
  it("does not count the thread against itself", () => {
    const active = ids(MAX_ACTIVE_AGENTS);
    expect(turn({ active, threadId: "thr_0" }).action).toBe("proceed");
  });
  it(`holds turns under ${DISPATCH_MIN_FREE}% free`, () => {
    expect(turn({ reading: reading(DISPATCH_MIN_FREE) }).action).toBe("proceed");
    const held = turn({ reading: reading(DISPATCH_MIN_FREE - 1) });
    expect(held.action === "wait" && held.reason).toMatch(`${DISPATCH_MIN_FREE - 1}% memory free`);
  });
  it("fails closed when it cannot tell: no reading, or a stale one", () => {
    expect(turn({ reading: null }).action).toBe("wait");
    expect(turn({ reading: reading(90, NOW - READING_MAX_AGE_MS - 1) }).action).toBe("wait");
    expect(turn({ reading: reading(90, NOW - READING_MAX_AGE_MS) }).action).toBe("proceed");
  });
});

describe("buildRefusal", () => {
  it(`refuses a build under ${BUILD_MIN_FREE}% free or without a fresh reading`, () => {
    expect(buildRefusal(reading(BUILD_MIN_FREE), NOW)).toBeNull();
    expect(buildRefusal(reading(BUILD_MIN_FREE - 1), NOW)).toMatch(`needs ${BUILD_MIN_FREE}%`);
    expect(buildRefusal(null, NOW)).toMatch(/cannot tell/);
    expect(buildRefusal(reading(90, NOW - READING_MAX_AGE_MS - 1), NOW)).toMatch(/cannot tell/);
  });
});

describe("pickVictim", () => {
  const running: RunningAgent[] = [
    { threadId: "task_old", role: "task", since: 1 },
    { threadId: "research_new", role: "research", since: 50 },
    { threadId: "build_old", role: "build", since: 10 },
    { threadId: "build_new", role: "build", since: 20 },
  ];
  const pick = (over: Partial<Parameters<typeof pickVictim>[0]> = {}) =>
    pickVictim({ reading: reading(STOP_BELOW - 1), running, lastStopAt: null, now: NOW, ...over });

  it("stops nothing at or above the floor", () => {
    expect(pick({ reading: reading(STOP_BELOW) })).toBeNull();
  });
  it("stops the newest builder first, then research, then tasks", () => {
    expect(pick()?.threadId).toBe("build_new");
    expect(pick({ running: running.filter((r) => r.role !== "build") })?.threadId).toBe("research_new");
    expect(pick({ running: running.filter((r) => r.role === "task") })?.threadId).toBe("task_old");
  });
  it("waits out the cooldown between stops", () => {
    expect(pick({ lastStopAt: NOW - STOP_COOLDOWN_MS + 1 })).toBeNull();
    expect(pick({ lastStopAt: NOW - STOP_COOLDOWN_MS })?.threadId).toBe("build_new");
  });
  it("never acts on a stale reading, and has nothing to stop with no agents", () => {
    expect(pick({ reading: reading(1, NOW - READING_MAX_AGE_MS - 1) })).toBeNull();
    expect(pick({ running: [] })).toBeNull();
  });
  it("tells the task what was running", () => {
    const text = stoppedMessage(running[3]!, reading(4));
    expect(text).toMatch(/stopped your builder \(build_new\)/);
    expect(text).toMatch(/4% free/);
    expect(text).toMatch(/9\.0 GB {2}pid 42 {2}node .*tsc --noEmit/);
  });
});

describe("isWorking", () => {
  it("counts starting, active and stopping threads; not idle, pending or error", () => {
    expect(["active", "starting", "stopping"].every(isWorking)).toBe(true);
    expect(["idle", "pending", "error"].some(isWorking)).toBe(false);
  });
});

// The builder sandbox refuses to spawn ps at all (EPERM): nothing to probe there.
let sandboxed = false;
try {
  execFileSync("ps", ["-o", "pid=", "-p", String(process.pid)]);
} catch (error) {
  sandboxed = (error as { code?: unknown }).code === "EPERM";
}

describe("readMemory on this machine", () => {
  it.skipIf(sandboxed)("reads a real free percentage and the biggest processes", async () => {
    const r = await readMemory(new AbortController().signal);
    expect(r.freePercent).toBeGreaterThanOrEqual(0);
    expect(r.freePercent).toBeLessThanOrEqual(100);
    expect(r.totalBytes).toBeGreaterThan(0);
    expect(r.top.length).toBeGreaterThan(0);
    expect(r.top[0]!.rssBytes).toBeGreaterThanOrEqual(r.top.at(-1)!.rssBytes);
    expect(r.treeBytes).not.toBeNull();
    for (const p of r.heavy) if (p.target !== null) expect(neverKill(p.command)).toBe(false);
  });
});

// ------------------------------------------------------------ agent tree

const BB = "/Users/me/.npm/_npx/614e/node_modules/bb-app";
const NODE = "/Users/me/.nvm/versions/node/v24.18.0/bin/node";
const CLAUDE = "/Users/me/.local/bin/claude --output-format stream-json --verbose";
const FFMPEG = "ffmpeg -i clip.mov -vf scale=3840:2160 out.mp4";
const row = (pid: number, ppid: number, pgid: number, gb: number, command: string): PsRow => ({ pid, ppid, pgid, rssBytes: Math.round(gb * GB), command });
/** The shape the 13:42 Jetsam report showed: bb → provider worker → claude → zsh → 4 × ffmpeg &. */
const machine = (ffmpegGb = 4.4): PsRow[] => [
  row(1, 0, 1, 0.02, "/sbin/launchd"),
  row(28989, 28971, 28969, 0.04, `node ${BB.replace("bb-app", ".bin/bb-app")}`),
  row(29009, 28989, 28969, 0.5, `${NODE} ${BB}/server/dist/index.js`),
  row(29075, 28989, 28969, 0.15, `${NODE} ${BB}/host-daemon/dist/daemon.js`),
  row(17678, 29075, 17678, 0.2, `${NODE} ${BB}/host-daemon/dist/bb-provider-bridge-worker.mjs`),
  row(17837, 17678, 17678, 0.3, CLAUDE),
  row(17986, 17837, 17678, 0.1, "npm exec @playwright/mcp@latest"),
  row(21976, 17837, 21976, 0.003, "/bin/zsh -c source snapshot.sh && ./encode-all.sh"),
  row(21980, 21976, 21976, ffmpegGb, FFMPEG),
  row(21981, 21976, 21976, ffmpegGb, FFMPEG),
  row(21982, 21976, 21976, ffmpegGb, FFMPEG),
  row(21983, 21976, 21976, ffmpegGb, FFMPEG),
  row(536, 1, 536, 3, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  row(537, 536, 536, 2, "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer"),
  row(900, 1, 900, 1, "/Applications/Visual Studio Code.app/Contents/MacOS/Code"),
];
const root = (r: PsRow) => isBbRoot(r.command);
const treeOf = (rows: PsRow[], adopted?: Set<number>) => agentTree(rows, root, adopted);
const tree = (treeGb: number, heavy: HeavyProcess[], at = NOW, totalBytes: number | null = TOTAL): MemoryReading => ({
  ...reading(60, at),
  totalBytes,
  treeBytes: Math.ceil(treeGb * GB),
  heavy,
});
const heavy = (gb: number, over: Partial<HeavyProcess> = {}): HeavyProcess => ({
  pid: 21980,
  pgid: 21976,
  rssBytes: Math.ceil(gb * GB),
  command: FFMPEG,
  threadId: "thr_builder",
  target: { kind: "group", pgid: 21976 },
  ...over,
});

describe("agent tree parsers", () => {
  it("parses ps pid, ppid, pgid, rss (KiB) and the command, spaces and all", () => {
    expect(parsePsTree("  537   536   536  2048 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper --type=renderer\nnoise\n")).toEqual([
      { pid: 537, ppid: 536, pgid: 536, rssBytes: 2048 * 1024, command: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome Helper --type=renderer" },
    ]);
  });
  it("reads BB_THREAD_ID from ps eww output, null when absent or malformed", () => {
    expect(parseThreadIdFromEnv("ffmpeg -i a.mov out.mp4 HOME=/Users/me BB_THREAD_ID=thr_esypgbcq9a BB_PROJECT_ID=proj_1")).toBe("thr_esypgbcq9a");
    expect(parseThreadIdFromEnv("BB_THREAD_ID=thr_x")).toBe("thr_x");
    expect(parseThreadIdFromEnv("ffmpeg HOME=/Users/me")).toBeNull();
    expect(parseThreadIdFromEnv("ffmpeg XBB_THREAD_ID=thr_x")).toBeNull();
    expect(parseThreadIdFromEnv("ffmpeg BB_THREAD_ID=$(rm)")).toBeNull();
    expect(parseThreadIdFromEnv("")).toBeNull();
  });
  it("knows bb's own processes by executable, never by arguments", () => {
    expect(isBbRoot(`${NODE} ${BB}/server/dist/index.js`)).toBe(true);
    expect(isBbRoot(`${NODE} ${BB}/host-daemon/dist/bb-provider-bridge-worker.mjs`)).toBe(true);
    expect(isBbRoot("node /Users/me/.npm/_npx/614e/node_modules/.bin/bb-app")).toBe(true);
    expect(isBbRoot("/usr/local/bin/bb-daemon --port 1")).toBe(true);
    expect(isBbRoot("/Applications/BB.app/Contents/MacOS/BB")).toBe(true);
    expect(isBbRoot(`vim ${BB}/server/dist/index.js`)).toBe(false);
    expect(isBbRoot(`/bin/zsh -c node ${BB}/server/dist/index.js`)).toBe(false);
    expect(isBbRoot(FFMPEG)).toBe(false);
  });
  it("knows claude however it runs", () => {
    expect(isClaude(CLAUDE)).toBe(true);
    expect(isClaude("/Users/me/.local/share/claude/versions/2.1.281 --print")).toBe(true);
    expect(isClaude("2.1.281")).toBe(true);
    expect(isClaude("node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js")).toBe(true);
    expect(isClaude(FFMPEG)).toBe(false);
    expect(isClaude("grep claude")).toBe(false);
  });
  it("never kills claude, bb, Chrome or anything under /Applications/", () => {
    expect(neverKill(CLAUDE)).toBe(true);
    expect(neverKill(`${NODE} ${BB}/server/dist/index.js`)).toBe(true);
    expect(neverKill("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")).toBe(true);
    expect(neverKill("/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild")).toBe(true);
    expect(neverKill(FFMPEG)).toBe(false);
  });
});

describe("agentTree", () => {
  it("is every descendant of bb's processes, not the roots, and nothing of the owner's", () => {
    const t = treeOf(machine());
    expect([...t].sort((a, b) => a - b)).toEqual([17837, 17986, 21976, 21980, 21981, 21982, 21983]);
    for (const pid of [1, 28989, 29009, 29075, 17678, 536, 537, 900]) expect(t.has(pid), String(pid)).toBe(false);
  });
  it("adopts a launchd orphan that carries an agent's thread id, with its orphaned group-mates", () => {
    const rows = machine().filter((r) => r.pid !== 21976).map((r) => (r.pgid === 21976 ? { ...r, ppid: 1 } : r));
    expect(treeOf(rows).has(21980)).toBe(false);
    const t = treeOf(rows, new Set([21980]));
    for (const pid of [21980, 21981, 21982, 21983]) expect(t.has(pid)).toBe(true);
    expect(t.has(536)).toBe(false);
  });
  it("offers only big non-system orphans for a thread-id check", () => {
    const rows = [
      row(10, 1, 10, 4.4, FFMPEG),
      row(11, 1, 11, 0.1, "node small.js"),
      row(12, 1, 12, 3, "/Applications/Spotify.app/Contents/MacOS/Spotify"),
      row(13, 1, 13, 2, "/usr/libexec/something"),
      row(14, 5, 14, 5, FFMPEG),
    ];
    expect(orphanCandidates(rows).map((r) => r.pid)).toEqual([10]);
  });
});

describe("killTarget", () => {
  const rows = machine();
  const t = treeOf(rows);
  const find = (pid: number) => rows.find((r) => r.pid === pid)!;
  it("kills a shell's whole group, so the `&` siblings go together", () => {
    expect(killTarget(rows, t, find(21981))).toEqual({ kind: "group", pgid: 21976 });
  });
  it("kills only the pid when its group holds claude or bb (MCP servers share claude's group)", () => {
    expect(killTarget(rows, t, find(17986))).toEqual({ kind: "pid", pid: 17986 });
  });
  it("kills only the pid when a claude shares its group, even inside the tree", () => {
    const nested = [...rows, row(21990, 21976, 21976, 0.3, CLAUDE)];
    expect(killTarget(nested, treeOf(nested), find(21981))).toEqual({ kind: "pid", pid: 21981 });
  });
  it("kills only the pid when its group leader is gone or outside the tree", () => {
    const orphaned = rows.filter((r) => r.pid !== 21976);
    expect(killTarget(orphaned, treeOf(orphaned), find(21981))).toEqual({ kind: "pid", pid: 21981 });
    const mixed = [...rows, row(5000, 1, 21976, 0.1, "some-daemon")];
    expect(killTarget(mixed, treeOf(mixed), find(21981))).toEqual({ kind: "pid", pid: 21981 });
  });
  it("summarizes the tree: its total and the heaviest, with never-kill ones marked", () => {
    const { treeBytes, heavy: top } = summarizeTree(rows, t);
    expect(treeBytes).toBe([17837, 17986, 21976, 21980, 21981, 21982, 21983].reduce((sum, pid) => sum + find(pid).rssBytes, 0));
    expect(top[0]).toMatchObject({ pid: 21980, target: { kind: "group", pgid: 21976 } });
    expect(top.find((p) => p.pid === 17837)?.target).toBeNull();
  });
});

describe("tree budget: hold", () => {
  const hold = TOTAL * TREE_HOLD_FRACTION / GB;
  it(`holds turns and refuses builds at ${Math.round(TREE_HOLD_FRACTION * 100)}% of RAM in bb's agents, naming the largest`, () => {
    expect(turn({ reading: tree(hold - 0.01, [heavy(1)]) }).action).toBe("proceed");
    expect(buildRefusal(tree(hold - 0.01, [heavy(1)]), NOW)).toBeNull();
    const held = turn({ reading: tree(hold, [heavy(1)]) });
    expect(held.action === "wait" && held.reason).toMatch(/bb's agents are using 6\.4 GB of 16\.0 GB .*largest is ffmpeg/);
    expect(buildRefusal(tree(hold, [heavy(1)]), NOW)).toMatch(/Not starting a build: bb's agents are using 6\.4 GB/);
  });
  it("cannot tell without the Mac's total or the tree, and waits", () => {
    expect(turn({ reading: tree(1, [], NOW, null) })).toMatchObject({ action: "wait" });
    expect(turn({ reading: { ...reading(60), treeBytes: null } })).toMatchObject({ action: "wait" });
    expect(buildRefusal(tree(1, [], NOW, null), NOW)).toMatch(/cannot tell/);
  });
});

describe("tree budget: pickProcessKill", () => {
  const killAt = TOTAL * TREE_KILL_FRACTION / GB;
  const oneAt = TOTAL * PROCESS_KILL_FRACTION / GB;
  it(`kills the largest agent process when the tree reaches ${Math.round(TREE_KILL_FRACTION * 100)}% of RAM`, () => {
    expect(pickProcessKill(tree(killAt - 0.01, [heavy(3)]), null, NOW)).toBeNull();
    const kill = pickProcessKill(tree(killAt, [heavy(2, { pid: 7, target: { kind: "pid", pid: 7 } }), heavy(3)]), null, NOW);
    expect(kill?.victim.pid).toBe(21980);
    expect(kill?.target).toEqual({ kind: "group", pgid: 21976 });
  });
  it("on the owner's 16 GB Mac: holds at 6.4 GB, kills at 8.8 GB in the tree or 4 GB in one process", () => {
    expect(pickProcessKill(tree(8.79, [heavy(3)]), null, NOW)).toBeNull();
    expect(pickProcessKill(tree(8.8, [heavy(3)]), null, NOW)?.why).toMatch(/using 8\.8 GB of 16\.0 GB \(limit 8\.8 GB\)/);
    expect(pickProcessKill(tree(5, [heavy(3.99)]), null, NOW)).toBeNull();
    expect(pickProcessKill(tree(5, [heavy(4)]), null, NOW)).not.toBeNull();
    expect(turn({ reading: tree(6.39, []) }).action).toBe("proceed");
    expect(turn({ reading: tree(6.4, []) }).action).toBe("wait");
  });
  it(`kills one agent process that alone reaches ${Math.round(PROCESS_KILL_FRACTION * 100)}% of RAM`, () => {
    expect(pickProcessKill(tree(oneAt, [heavy(oneAt - 0.01)]), null, NOW)).toBeNull();
    expect(pickProcessKill(tree(oneAt, [heavy(oneAt)]), null, NOW)?.why).toMatch(/one agent process holds 4\.0 GB/);
  });
  it("never picks claude, bb or /Applications/, even when they are the hogs", () => {
    const hogs = [
      heavy(10, { pid: 1, command: CLAUDE, target: null }),
      heavy(10, { pid: 2, command: `${NODE} ${BB}/server/dist/index.js`, target: null }),
      heavy(10, { pid: 3, command: "/Applications/Xcode.app/Contents/MacOS/Xcode", target: { kind: "pid", pid: 3 } }),
      heavy(10, { pid: 4, command: CLAUDE, target: { kind: "pid", pid: 4 } }),
    ];
    expect(pickProcessKill(tree(15, hogs), null, NOW)).toBeNull();
    expect(pickProcessKill(tree(15, [...hogs, heavy(1)]), null, NOW)?.victim.pid).toBe(21980);
  });
  it("waits out the cooldown, and never acts on a stale or partial reading", () => {
    const big = tree(12, [heavy(5)]);
    expect(pickProcessKill(big, NOW - PROCESS_KILL_COOLDOWN_MS + 1, NOW)).toBeNull();
    expect(pickProcessKill(big, NOW - PROCESS_KILL_COOLDOWN_MS, NOW)).not.toBeNull();
    expect(pickProcessKill(tree(12, [heavy(5)], NOW - READING_MAX_AGE_MS - 1), null, NOW)).toBeNull();
    expect(pickProcessKill(tree(12, [heavy(5)], NOW, null), null, NOW)).toBeNull();
    expect(pickProcessKill(null, null, NOW)).toBeNull();
  });
  it("tells the owner what was killed and how to run it next time", () => {
    const r = tree(17.6, [heavy(4.4)]);
    const text = killedMessage(pickProcessKill(r, null, NOW)!, r);
    expect(text).toMatch(/^The Orchestrator killed ffmpeg .*\(pid 21980, 4\.4 GB\) and its process group: bb's agents were using 17\.6 GB of 16\.0 GB\./);
    expect(text).toContain("never several in the background with &");
    expect(text).toContain("ffmpeg -threads 2");
  });
});

describe("the Headroom proxy and relay in the tree budget", () => {
  // As ps shows the proxy on the owner's Mac, and the relay as the host starts it.
  const PROXY = "/Users/sam/.local/share/the-orchestrator/headroom/venv/bin/python -m headroom.cli proxy --host 127.0.0.1 --port 8792 --mode cache";
  const RELAY = "/opt/homebrew/bin/node /Users/sam/.local/share/the-orchestrator/headroom/relay.mts --orchestrator-relay --host 127.0.0.1 --port 8791 --headroom-port 8792";
  it("are never killed, but an agent's own `headroom proxy` or node elsewhere is", () => {
    expect(neverKill(PROXY)).toBe(true);
    expect(neverKill("/Users/sam/.local/share/the-orchestrator/headroom/venv/bin/headroom proxy --port 8792")).toBe(true);
    expect(neverKill(RELAY)).toBe(true);
    expect(neverKill("/tmp/venv/bin/headroom proxy --port 9000")).toBe(false);
    expect(neverKill("/Users/sam/other/.venv/bin/python -m headroom.cli proxy --port 9000")).toBe(false);
    expect(neverKill("headroom proxy --port 9000")).toBe(false);
    expect(neverKill("node /tmp/relay.mts --orchestrator-relay")).toBe(false);
  });
  it("counts the relay in the tree after a reload leaves it to launchd", () => {
    const adopted = [...machine(), row(30010, 1, 30010, 0.05, RELAY)];
    expect(treeOf(adopted).has(30010)).toBe(true);
    const hog = heavy(10, { pid: 30010, command: RELAY, target: { kind: "pid", pid: 30010 } });
    expect(pickProcessKill(tree(15, [hog]), null, NOW)).toBeNull();
  });
  it("counts in the tree whether the host started it or launchd adopted it after a reload", () => {
    const started = [...machine(), row(30000, 17678, 30000, 0.9, PROXY)];
    expect(treeOf(started).has(30000)).toBe(true);
    const adopted = [...machine(), row(30000, 1, 30000, 0.9, PROXY), row(30001, 30000, 30000, 0.1, "/usr/bin/some-helper")];
    const t = treeOf(adopted);
    expect(t.has(30000)).toBe(true);
    expect(t.has(30001)).toBe(true);
    const { treeBytes, heavy: top } = summarizeTree(adopted, t);
    expect(treeBytes).toBe(summarizeTree(machine(), treeOf(machine())).treeBytes + Math.round(1.0 * GB));
    expect(top.find((p) => p.pid === 30000)?.target).toBeNull();
  });
  it("is never the victim even when it is the largest", () => {
    const hog = heavy(10, { pid: 30000, command: PROXY, target: { kind: "pid", pid: 30000 } });
    expect(pickProcessKill(tree(15, [hog]), null, NOW)).toBeNull();
    expect(pickProcessKill(tree(15, [hog, heavy(1)]), null, NOW)?.victim.pid).toBe(21980);
  });
});
