// Runs on the machine that holds the project checkouts, as the owner's user, so git
// and gh have their credentials. Reads by default: refs, PRs, PR comments.
//
// The writes are the ones the owner delegated to The Orchestrator: create and remove
// a task's worktree under <repo>/.claude/worktrees (removal only when clean
// and pushed; an orphan no task records only when it holds no files, or is a
// clean worktree whose every commit is on main), install its dependencies, push the task's own branch, open its
// PR, and apply the ai-tests label. Each refuses anything wider: no force, no
// pushing a default branch, no path outside the repo's worktree directory.
// The one merge is landBranch: a local fast-forward the server allows only
// for land: "main" profiles (The Orchestrator itself, a local app; landBranch
// never pushes). Merging anything that deploys stays the owner's. After a land,
// pushBackup pushes the default branch to that profile's private backup
// remote (never forced), and runAfterLand runs its bb commands in the main
// checkout: build, then a detached reload that records its exit code and
// output under the temp dir (reloadOutcome reads them; pluginStatus asks bb
// how the plugin is). keepLastGood copies dist/ to the plugin's data dir
// after a good reload; restoreLastGood puts it back after a failed one
// (recovery.ts); runGuardTests runs a guard's tests in a worktree before
// land (landguard.ts). createProject (Add project) makes
// a new folder under the owner's projects folder (the local config's
// projectsDir, else ~/Documents/Github; never an existing one), its first
// commit, and a private GitHub repo under the signed-in gh account, then checks from
// outside that GitHub hides it; it deletes nothing it made. ai.voice.transcribe
// runs the chat mic's recording through ffmpeg and Apple's on-device speech
// (voice.ts), in a temp folder it always removes. claudeSignIn starts `claude
// auth login` for the board's Sign in with Claude button: its output is never
// read, logged or stored, and nothing is written to it. The setup wizard
// (setupwizard.ts): setupFacts and listRepos only read; saveSetup is the one
// write to ~/.config/the-orchestrator/config.json, the folder and the name
// merged into the file as it is, never over a file that has a problem.
// retireLegacyRoute stops the removed token proxy's leftover processes by
// verified pid and then removes its install dir, that path only (legacyroute.ts).
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import {
  experimental_defineHostEntry,
  experimental_killProcessesWithCwdUnder,
} from "@get-bb/plugin-sdk/host";
import {
  hostContract,
  MAIN_COMMIT_LIMIT,
  type Branch,
  type Checks,
  type PrComment,
  type PullRequest,
  type RepoSnapshot,
  type AiVoiceTranscribeInput,
  type AiVoiceTranscribeOutput,
  type RetireLegacyOutput,
} from "./contract.js";
import { SIGN_IN_ARGS, SIGN_IN_TIMEOUT_MS, signInPathDirs, signInSpawnError } from "./signin.js";
import { killAgentProcess, readMemory } from "./memory-probe.js";
import { builderSettings, envPatternsOf, guardHookCommand } from "./builderguard.js";
import {
  LEGACY_PROXY_URL,
  LEGACY_RELAY_HEALTH_PATH,
  LEGACY_RELAY_URL,
  isLegacyProxy,
  isLegacyRelay,
  legacyPaths,
  parseLegacyProxyHealth,
  parseLegacyRelayHealth,
  removableDir,
  retirePlan,
  withoutLegacyRoute,
} from "./legacyroute.js";
import {
  GH_LOGIN_ARGS,
  SLUG_PATTERN,
  firstCommitFiles,
  firstCommitMessage,
  folderExistsReason,
  ghCreateArgs,
  ghRetryCommand,
  parseGhLogin,
  validateNewProject,
  visibilityFromStatus,
  type Visibility,
} from "./newproject.js";
import { askJev, downGate } from "./jevwatch.js";
import { askRoute } from "./modelroute.js";
import { JEV_KEY_PATH, KEY_FILE_MAX_CHARS, jevKey, keyStale, repoEnvPath, type KeyReading, type KeySource } from "./typesafe.js";
import { LOCAL_CONFIG_LAST_GOOD, LOCAL_CONFIG_MAX_CHARS, LOCAL_CONFIG_PATH, parseLocalConfig } from "./localconfig.js";
import { githubSlug } from "./profiles.js";
import {
  GIT_CONFIG_MAX_CHARS,
  REPO_LIST_CAP,
  claudeSignIn as claudeSignInState,
  ghSignIn,
  mergeSetupIntoConfig,
  originUrlOf,
  projectsDirInForce,
  validateProjectsDir,
  type CommandEnd,
  type RepoEntry,
} from "./setupwizard.js";
import { pluginStatusOf } from "./reload.js";
import { builtFromSha, stickyComment } from "./validation.js";
import {
  FFMPEG_MISSING,
  HELPER_INFO_PLIST,
  HELPER_NAME,
  HELPER_SOURCE,
  audioExtension,
  codesignArgs,
  compileFailure,
  ffmpegArgs,
  ffmpegCandidates,
  ffmpegFailure,
  helperOutcome,
  remainingMs,
  swiftcArgs,
  timeoutFailure,
  voiceRequestProblem,
  type StepResult,
} from "./voice.js";
import {
  WORKTREES_DIR,
  branchCheckedOut,
  cleanupAfterFailedPrepare,
  cleanupDecision,
  includeMatcher,
  mergeWorktreeInclude,
  isRepoWorktreePath,
  leftoverDecision,
  orphanDecision,
  porcelainDirty,
  parseWorktreeInclude,
  setupEnv,
  unlandedCommits,
  untrackedPaths,
  worktreePathFor,
  type LeftoverFacts,
  type WorktreeInspection,
} from "./worktrees.js";

const BRANCH_LIMIT = 60;
const PR_LIMIT = 60;
/** Open PRs whose sticky preview comment is read for stale detection. */
const PREVIEW_LOOKUPS = 12;

/**
 * The builder guard (builderguard.ts): Claude Code in the worktree loads
 * .claude/settings.local.json, so that is where the sandbox, the deny rules
 * and the PreToolUse hook on Bash go. Existing keys (an included MCP setup)
 * are kept; rewriting it is idempotent, so a reused worktree is re-guarded.
 */
async function writeBuilderGuard(
  root: string,
  repoPath: string,
  worktreePath: string,
  include: string[],
): Promise<void> {
  if (!existsSync(join(root, "builderguard.ts"))) {
    throw new Error(`builder guard missing: ${join(root, "builderguard.ts")} does not exist, so no builder starts.`);
  }
  const file = join(worktreePath, ".claude", "settings.local.json");
  let existing: unknown = {};
  try {
    existing = JSON.parse(await readFile(file, "utf8"));
  } catch {
    // None yet, or not JSON (Claude Code couldn't read it either): start fresh.
  }
  // A reused worktree may still carry the removed proxy's base URL: it goes
  // (legacyroute.ts withoutLegacyRoute).
  if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
    existing = withoutLegacyRoute(existing as Record<string, unknown>) ?? existing;
  }
  const settings = builderSettings(existing, {
    hookCommand: guardHookCommand(root, worktreePath),
    repoPath,
    envPatterns: envPatternsOf(include),
    worktreePath,
  });
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`);
}

// ------------------------------------------------- the removed proxy's leftovers
// legacyroute.ts holds the policy (retirePlan); here the IO, one liveness beat
// at a time until it says done: read both health endpoints with short
// timeouts, confirm each pid with ps, stop by verified pid only (TERM, then
// KILL), and remove the install dir once both are confirmed gone. Starts
// nothing and writes nothing.

const legacy = legacyPaths(homedir());

async function localGet(url: string, timeoutMs: number, signal: AbortSignal): Promise<{ status: number; body: unknown } | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]), redirect: "error" });
    const text = (await response.text()).slice(0, 100_000);
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch {
    return null;
  }
}

/** pgid and command of a live pid, or null. */
async function processFacts(pid: number, signal: AbortSignal): Promise<{ pgid: number; command: string } | null> {
  const out = await new Promise<string | null>((done) =>
    execFile("/bin/ps", ["-o", "pgid=,command=", "-p", String(pid)], { signal, timeout: 5_000 }, (error, stdout) => done(error ? null : stdout)),
  );
  const match = out === null ? null : /^\s*(\d+)\s+(.+?)\s*$/m.exec(out);
  return match === null ? null : { pgid: Number(match[1]), command: match[2]! };
}

/** The pid one of them runs as: the one its health names, else its pid file's, only while ps shows its command line. */
async function verifiedPid(named: number | null, pidFile: string, ours: (command: string) => boolean, signal: AbortSignal): Promise<number | null> {
  const fromFile = Number((await readFile(pidFile, "utf8").catch(() => "")).trim());
  for (const pid of [named, Number.isInteger(fromFile) && fromFile > 1 ? fromFile : null]) {
    if (pid === null) continue;
    const facts = await processFacts(pid, signal);
    if (facts !== null && ours(facts.command)) return pid;
  }
  return null;
}

/**
 * Stop one of them: its own group when it leads one (both were started
 * detached), TERM, then KILL after `graceMs`. Only while ps shows its command
 * line, checked again right before each signal.
 */
async function stopVerified(pid: number, ours: (command: string) => boolean, graceMs: number, signal: AbortSignal): Promise<void> {
  const facts = await processFacts(pid, signal);
  if (facts === null || !ours(facts.command)) return;
  const id = facts.pgid === pid ? -pid : pid;
  try {
    process.kill(id, "SIGTERM");
  } catch {
    return;
  }
  for (let waited = 0; waited < graceMs; waited += 250) {
    await new Promise((done) => setTimeout(done, 250));
    if ((await processFacts(pid, signal)) === null) return;
  }
  const still = await processFacts(pid, signal);
  if (still === null || !ours(still.command)) return;
  try {
    process.kill(id, "SIGKILL");
  } catch {
    // Gone between the check and the kill.
  }
}

let retiring = false;

async function retireLegacyRoute({ activeAgentTurns }: { activeAgentTurns: number }, signal: AbortSignal): Promise<RetireLegacyOutput> {
  if (retiring) return { done: false, waits: "the last beat's retirement is still running", stopped: [], removed: null };
  retiring = true;
  try {
    const relayReply = await localGet(`${LEGACY_RELAY_URL}${LEGACY_RELAY_HEALTH_PATH}`, 3_000, signal);
    const relay = parseLegacyRelayHealth(relayReply?.status ?? null, relayReply?.body ?? null);
    const proxyReply = await localGet(`${LEGACY_PROXY_URL}/health`, 3_000, signal);
    const proxyNamed = parseLegacyProxyHealth(proxyReply?.status ?? null, proxyReply?.body ?? null);
    const relayPid = await verifiedPid(relay?.pid ?? null, legacy.relayPidFile, isLegacyRelay, signal);
    const proxyPid = await verifiedPid(proxyNamed, legacy.proxyPidFile, isLegacyProxy, signal);
    const dirExists = await lstat(legacy.dir).then((s) => s.isDirectory(), () => false);
    const plan = retirePlan({ proxyNamed, proxyPid, relay, relayPid, activeAgentTurns, dirExists });

    const stopped: RetireLegacyOutput["stopped"] = [];
    if (plan.stopProxy && proxyPid !== null) {
      await stopVerified(proxyPid, isLegacyProxy, 5_000, signal);
      stopped.push({ what: "proxy", pid: proxyPid });
    }
    // The relay drains what is in flight on TERM (at most 10 s) before it leaves.
    if (plan.stopRelay && relayPid !== null) {
      await stopVerified(relayPid, isLegacyRelay, 12_000, signal);
      stopped.push({ what: "relay", pid: relayPid });
    }
    let removed: string | null = null;
    if (plan.removeDir && removableDir(legacy.dir, homedir())) {
      await rm(legacy.dir, { recursive: true, force: true });
      removed = legacy.dir;
    }
    const done = plan.gone && !(await lstat(legacy.dir).then(() => true, () => false));
    return { done, waits: plan.waits === null ? null : clip(plan.waits, 400), stopped, removed };
  } finally {
    retiring = false;
  }
}

function run(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  input?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { cwd, signal, timeout: 25_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim().split("\n")[0] || error.message;
          reject(new Error(`${command} ${args[0]}: ${detail}`));
          return;
        }
        resolve(stdout);
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

/**
 * Git's yes/no commands (show-ref --verify, merge-base --is-ancestor): exit 0
 * is yes, exit 1 is no; anything else (a timeout, a bad object) throws.
 */
function gitYesNo(args: string[], cwd: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, signal, timeout: 25_000 }, (error, _stdout, stderr) => {
      if (!error) resolve(true);
      else if ((error as { code?: unknown }).code === 1) resolve(false);
      else reject(new Error(`git ${args[0]}: ${stderr.trim().split("\n")[0] || error.message}`));
    });
  });
}

/** Dependency installs take minutes; everything else is bounded at 25 s. */
function runLong(command: string, args: string[], cwd: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd, signal, timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024, env: setupEnv(process.env) },
      (error, stdout, stderr) => {
        if (error) {
          const tail = `${stdout}\n${stderr}`.trim().split("\n").slice(-25).join("\n");
          reject(new Error(tail || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

/** `claude` on PATH, else its default install: the host worker's PATH may be minimal. */
function claudeBinary(): string {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir !== "" && existsSync(join(dir, "claude"))) return join(dir, "claude");
  }
  return join(homedir(), ".local", "bin", "claude");
}

/** One `claude -p` reply, prompt on stdin; a failure resolves ok: false. */
function claudeOnce(prompt: string, model: string, signal: AbortSignal): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  return new Promise((done) => {
    try {
      const child = execFile(
        claudeBinary(),
        ["-p", "--model", model, "--output-format", "text"],
        { cwd: tmpdir(), signal, timeout: 45_000, maxBuffer: 1024 * 1024, env: setupEnv(process.env) },
        (error, stdout, stderr) => {
          if (error) {
            done({ ok: false, error: clip(stderr.trim().split("\n")[0] || error.message, 500) });
            return;
          }
          done({ ok: true, text: clip(stdout, 2000) });
        },
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end(prompt);
    } catch (error) {
      done({ ok: false, error: clip(error instanceof Error ? error.message : String(error), 500) });
    }
  });
}

/** The running `claude auth login`, if any: one at a time. */
let signInChild: ChildProcess | null = null;

/**
 * Start `claude auth login`: it opens the browser's sign-in tab itself and
 * takes the OAuth callback on localhost. stdout and stderr go nowhere (never
 * piped, read or written to a file), so no token or code can be captured
 * here. stdin is a pipe held open and never written: a "paste the code"
 * prompt waits instead of reading end-of-file. A second call stops the
 * first, so clicking again reopens the tab; a sign-in nobody finishes is
 * stopped after SIGN_IN_TIMEOUT_MS.
 */
function claudeSignIn(): Promise<{ ok: boolean; error: string | null }> {
  const dirs = signInPathDirs(process.env.PATH, homedir());
  const found = dirs.map((dir) => join(dir, "claude")).find((candidate) => existsSync(candidate));
  signInChild?.kill("SIGTERM");
  signInChild = null;
  return new Promise((done) => {
    let child: ChildProcess;
    try {
      child = spawn(found ?? "claude", [...SIGN_IN_ARGS], {
        cwd: homedir(),
        stdio: ["pipe", "ignore", "ignore"],
        env: { ...setupEnv(process.env), PATH: dirs.join(delimiter) },
      });
    } catch (error) {
      done({ ok: false, error: signInSpawnError((error as NodeJS.ErrnoException).code) });
      return;
    }
    signInChild = child;
    const timer = setTimeout(() => child.kill("SIGTERM"), SIGN_IN_TIMEOUT_MS);
    timer.unref();
    const over = () => {
      clearTimeout(timer);
      if (signInChild === child) signInChild = null;
    };
    child.stdin?.on("error", () => {});
    child.once("spawn", () => done({ ok: true, error: null }));
    child.once("error", (error) => {
      over();
      done({ ok: false, error: signInSpawnError((error as NodeJS.ErrnoException).code) });
    });
    child.once("exit", over);
    child.unref();
  });
}

/** When the local Jev server last refused the connection: no fetch for JEV_BACKOFF_MS after it. */
let jevDownAt: number | null = null;

/**
 * Watch only: ask the local Jev server (local.json, jev/local/) or else the
 * box `jev up` recorded (jevwatch.ts askJev holds the rules). A local server
 * that is not running is "down": the server is told "off" (the jevAsk contract
 * has no "down", and "off" writes no row), and for the next 5 minutes it is
 * "off" with no fetch (the server only backs off on a recorded failure, so
 * that back-off is kept here).
 */
async function jevAskOnce(title: string, brief: string, signal: AbortSignal) {
  if (downGate(Date.now(), jevDownAt)) return { ok: false as const, kind: "off" as const };
  const dir = join(homedir(), ".config", "jev");
  const read = (name: string) => readFile(join(dir, name), "utf8").catch(() => null);
  const reply = await askJev(
    {
      readLocal: () => read("local.json"),
      readState: () => read("state.json"),
      readClients: () => read("clients.env"),
      fetch: (url, init) => fetch(url, init),
      now: () => Date.now(),
    },
    { title, brief },
    signal,
  );
  if (!reply.ok && reply.kind === "down") {
    jevDownAt = Date.now();
    return { ok: false as const, kind: "off" as const };
  }
  return reply;
}

/** The key as last read, per repo checkout, and when: re-read at most once a minute (typesafe.ts keyStale). */
const jevKeys = new Map<string, { at: number; state: KeyReading }>();

/** A key file's text and mode, or null when there is no such file. Never more than KEY_FILE_MAX_CHARS. */
async function keyFile(file: string): Promise<KeySource> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return null;
    return { text: (await readFile(file, "utf8")).slice(0, KEY_FILE_MAX_CHARS), mode: info.mode };
  } catch {
    return null;
  }
}

/**
 * The TypeSafe key (typesafe.ts jevKey): ~/.config/the-orchestrator/jev.env
 * when it is there, else `.env` in The Orchestrator's main checkout (the
 * server names it from its land: "main" project; never a worktree), refused
 * when others can read it or git tracks it (`git ls-files --error-unmatch`;
 * a check that fails counts as tracked). The key is never logged, never put
 * in an error, never returned to the server: only the file's path is.
 */
async function readJevKey(checkout: string | null): Promise<KeyReading> {
  const now = Date.now();
  const cacheKey = checkout ?? "";
  const cached = jevKeys.get(cacheKey);
  if (cached !== undefined && !keyStale(now, cached.at)) return cached.state;
  const home = await keyFile(join(homedir(), ...JEV_KEY_PATH));
  const repoPath = home === null ? repoEnvPath(checkout) : null;
  let repo: (NonNullable<KeySource> & { tracked: boolean | null }) | null = null;
  if (repoPath !== null && checkout !== null) {
    const found = await keyFile(repoPath);
    if (found !== null) {
      const tracked = await gitYesNo(["ls-files", "--error-unmatch", "--", ".env"], checkout, AbortSignal.timeout(10_000)).catch(() => null);
      repo = { ...found, tracked };
    }
  }
  const state = jevKey({ home, repo, repoPath });
  jevKeys.set(cacheKey, { at: now, state });
  return state;
}

/** Jev picks an agent's model (modelroute.ts): TypeSafe only, one POST, never the local server or the box. */
async function modelRouteOnce(state: string, checkout: string | null, signal: AbortSignal) {
  return askRoute({ key: await readJevKey(checkout), fetch: (url, init) => fetch(url, init), now: () => Date.now() }, state, signal);
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function defaultBranch(cwd: string, signal: AbortSignal) {
  try {
    const ref = await run(
      "git",
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      cwd,
      signal,
    );
    return ref.trim().replace(/^origin\//, "") || "main";
  } catch {
    return "main";
  }
}

async function originUrl(cwd: string, signal: AbortSignal): Promise<string | null> {
  try {
    return (await run("git", ["remote", "get-url", "origin"], cwd, signal)).trim() || null;
  } catch {
    return null;
  }
}

async function worktreesByBranch(cwd: string, signal: AbortSignal) {
  const out = await run("git", ["worktree", "list", "--porcelain"], cwd, signal);
  const map = new Map<string, string>();
  let path: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    if (line.startsWith("branch refs/heads/") && path !== null) {
      map.set(line.slice("branch refs/heads/".length), path);
    }
  }
  return map;
}

async function readBranches(
  cwd: string,
  base: string,
  signal: AbortSignal,
): Promise<Branch[]> {
  const out = await run(
    "git",
    [
      "for-each-ref",
      "refs/heads",
      "--sort=-committerdate",
      `--count=${BRANCH_LIMIT}`,
      "--format=%(refname:short)%09%(objectname)%09%(committerdate:unix)%09%(subject)",
    ],
    cwd,
    signal,
  );
  const worktrees = await worktreesByBranch(cwd, signal);
  const rows = out
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .filter(([name]) => name !== base);
  return Promise.all(
    rows.map(async ([name = "", sha = "", date = "0", subject = ""]) => {
      let ahead = 0;
      let behind = 0;
      try {
        const counts = await run(
          "git",
          ["rev-list", "--left-right", "--count", `${base}...${name}`],
          cwd,
          signal,
        );
        const [left, right] = counts.trim().split(/\s+/).map(Number);
        behind = left ?? 0;
        ahead = right ?? 0;
      } catch {
        // A branch with no common history with base still gets listed.
      }
      return {
        name: clip(name, 250),
        sha: sha.slice(0, 64),
        committedAt: Number(date) * 1000,
        subject: clip(subject, 300),
        ahead,
        behind,
        worktreePath: worktrees.get(name) ?? null,
      };
    }),
  );
}

interface GhCheck {
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
}

const FAILED = new Set([
  "FAILURE",
  "ERROR",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);

function summarizeChecks(checks: GhCheck[] | null): {
  checks: Checks;
  failing: string[];
  /** The failed checks' outcomes (FAILURE, CANCELLED, …), for ci.ts to tell real failures from cancelled runs. */
  outcomes: string[];
} {
  if (checks === null || checks.length === 0) return { checks: "none", failing: [], outcomes: [] };
  let pending = false;
  const failing: string[] = [];
  const outcomes: string[] = [];
  for (const check of checks) {
    const outcome = check.conclusion || check.state || "";
    if (FAILED.has(outcome)) {
      failing.push(clip(check.name || check.context || "check", 200));
      outcomes.push(outcome);
      continue;
    }
    const done =
      check.status === undefined
        ? outcome !== "PENDING" && outcome !== "EXPECTED"
        : check.status === "COMPLETED";
    if (!done) pending = true;
  }
  if (failing.length > 0) return { checks: "failing", failing, outcomes };
  return { checks: pending ? "pending" : "passing", failing, outcomes };
}

const prState = (state: string): "open" | "closed" | "merged" =>
  state === "MERGED" ? "merged" : state === "CLOSED" ? "closed" : "open";

const mergeable = (value: string): "mergeable" | "conflicting" | "unknown" =>
  value === "MERGEABLE" ? "mergeable" : value === "CONFLICTING" ? "conflicting" : "unknown";

interface GhPullRequest {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  headRefName: string;
  headRefOid?: string;
  updatedAt: string;
  mergeable: string;
  mergeStateStatus?: string;
  labels: { name: string }[];
  statusCheckRollup: GhCheck[] | null;
}

interface GhComment {
  body?: string;
  created_at?: string;
}

async function readComments(
  cwd: string,
  slug: string,
  number: number,
  signal: AbortSignal,
): Promise<PrComment[]> {
  const out = await run(
    "gh",
    ["api", `repos/${slug}/issues/${number}/comments?per_page=100`],
    cwd,
    signal,
  );
  const parsed = JSON.parse(out) as GhComment[];
  return parsed.slice(-100).map((comment) => ({
    body: clip(comment.body ?? "", 20_000),
    createdAt: Date.parse(comment.created_at ?? "") || 0,
  }));
}

async function readPullRequests(
  cwd: string,
  slug: string,
  previewMarker: string | null,
  signal: AbortSignal,
): Promise<PullRequest[]> {
  const out = await run(
    "gh",
    [
      "pr",
      "list",
      "--state",
      "all",
      "--limit",
      String(PR_LIMIT),
      "--json",
      "number,title,url,state,isDraft,headRefName,headRefOid,updatedAt,mergeable,mergeStateStatus,labels,statusCheckRollup",
    ],
    cwd,
    signal,
  );
  const parsed = JSON.parse(out) as GhPullRequest[];
  const prs: PullRequest[] = parsed.map((pr) => {
    const checks = summarizeChecks(pr.statusCheckRollup);
    return {
      number: pr.number,
      title: clip(pr.title, 300),
      url: pr.url.slice(0, 500),
      state: prState(pr.state),
      isDraft: pr.isDraft,
      headRefName: clip(pr.headRefName, 250),
      headRefOid: (pr.headRefOid ?? "").slice(0, 64),
      updatedAt: Date.parse(pr.updatedAt) || 0,
      checks: checks.checks,
      failedConclusions: checks.outcomes.slice(0, 50).map((outcome) => clip(outcome, 40)),
      mergeable: mergeable(pr.mergeable),
      mergeStateStatus: clip(pr.mergeStateStatus ?? "UNKNOWN", 40),
      labels: pr.labels.slice(0, 30).map((label) => clip(label.name, 80)),
      previewSha: null,
    };
  });
  if (previewMarker !== null) {
    const open = prs.filter((pr) => pr.state === "open").slice(0, PREVIEW_LOOKUPS);
    await Promise.all(
      open.map(async (pr) => {
        try {
          const comment = stickyComment(
            await readComments(cwd, slug, pr.number, signal),
            previewMarker,
          );
          pr.previewSha = comment === null ? null : builtFromSha(comment.body);
        } catch {
          // No preview sha just means no stale warning for this PR.
        }
      }),
    );
  }
  return prs;
}

async function inspectWorktree(
  worktreePath: string,
  baseRef: string,
  signal: AbortSignal,
): Promise<WorktreeInspection> {
  if (!existsSync(worktreePath)) return { exists: false, dirty: false, unpushed: 0 };
  const status = await run("git", ["status", "--porcelain"], worktreePath, signal);
  const links = await untrackedSymlinks(worktreePath, status);
  let range = `${baseRef}..HEAD`;
  try {
    await run("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], worktreePath, signal);
    range = "@{upstream}..HEAD";
  } catch {
    // Never pushed: everything past the base exists only here.
  }
  let unpushed = 0;
  try {
    unpushed = Number((await run("git", ["rev-list", "--count", range], worktreePath, signal)).trim()) || 0;
  } catch {
    unpushed = 0;
  }
  return { exists: true, dirty: porcelainDirty(status, links), unpushed };
}

/** The untracked entries of `status` that are symlinks (lstat, never followed). */
async function untrackedSymlinks(worktreePath: string, status: string): Promise<Set<string>> {
  const links = new Set<string>();
  for (const entry of untrackedPaths(status)) {
    try {
      if ((await lstat(join(worktreePath, entry))).isSymbolicLink()) links.add(entry);
    } catch {
      // Unreadable or quoted by git: stays dirty.
    }
  }
  return links;
}

/** The worktree paths git has registered for this repo, as listed and as real paths. */
async function registeredWorktrees(repoPath: string, signal: AbortSignal): Promise<Set<string>> {
  const out = await run("git", ["worktree", "list", "--porcelain"], repoPath, signal);
  const paths = new Set<string>();
  for (const line of out.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const listed = line.slice("worktree ".length);
    paths.add(listed);
    try {
      paths.add(await realpath(listed));
    } catch {
      // A prunable entry whose folder is gone.
    }
  }
  return paths;
}

async function isRegistered(registered: Set<string>, dir: string): Promise<boolean> {
  if (registered.has(dir)) return true;
  try {
    return registered.has(await realpath(dir));
  } catch {
    return false;
  }
}

/** No files anywhere below `dir`: only directories, possibly nested. A symlink counts as a file. */
async function holdsNoFiles(dir: string): Promise<boolean> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) return false;
    if (!(await holdsNoFiles(join(dir, entry.name)))) return false;
  }
  return true;
}

/**
 * Remove a tree of empty directories bottom-up with rmdir, which refuses any
 * directory that still holds something: a file that appeared since the check
 * stops the removal instead of being deleted.
 */
async function removeEmptyTree(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await removeEmptyTree(join(dir, entry.name));
  }
  await rmdir(dir);
}

/**
 * Does any process have its cwd inside `dir`? `lsof -d cwd -Fn` lists every
 * process's cwd as `n<path>` lines. lsof exits 1 when some process could not
 * be read; its output still counts. No output at all fails closed (in use).
 */
function cwdInside(dir: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("lsof", ["-d", "cwd", "-Fn"], { signal, timeout: 25_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error && stdout.trim() === "") {
        resolve(true);
        return;
      }
      resolve(
        stdout
          .split("\n")
          .filter((line) => line.startsWith("n"))
          .some((line) => {
            const cwd = line.slice(1);
            return cwd === dir || cwd.startsWith(`${dir}/`);
          }),
      );
    });
  });
}

/** The latest mtime of a worktree's git admin index or HEAD and of its folder. */
async function lastActiveAt(worktreePath: string, signal: AbortSignal): Promise<number> {
  const gitDir = (await run("git", ["rev-parse", "--absolute-git-dir"], worktreePath, signal)).trim();
  let latest = (await stat(worktreePath)).mtimeMs;
  for (const name of ["index", "HEAD"]) {
    try {
      latest = Math.max(latest, (await stat(join(gitDir, name))).mtimeMs);
    } catch {
      // No index yet: HEAD and the folder decide.
    }
  }
  return latest;
}

/**
 * `git cherry <ref> HEAD` against the default branch, local and on origin,
 * whichever exist (worktrees.ts unlandedCommits reads them).
 */
async function cherryAgainstMain(repoPath: string, worktreePath: string, signal: AbortSignal): Promise<string[]> {
  const main = await defaultBranch(repoPath, signal);
  const outputs: string[] = [];
  for (const ref of [`refs/heads/${main}`, `refs/remotes/origin/${main}`]) {
    if (!(await gitYesNo(["show-ref", "--verify", "--quiet", ref], repoPath, signal))) continue;
    outputs.push(await run("git", ["cherry", ref, "HEAD"], worktreePath, signal));
  }
  return outputs;
}

/**
 * Not --force: git refuses a worktree with changes, which is the point. The
 * exceptions are what porcelainDirty tolerates (the caller has just re-read
 * the status and checked it): deleted tracked files, whose content HEAD still
 * holds, and untracked symlinks. `git worktree remove --force` unlinks a
 * symlink; it never follows it, so the node_modules it points at stays.
 */
function forceFor(status: string): string[] {
  return status.trim() === "" ? [] : ["--force"];
}

/** A leading "bb" runs the CLI bb launched this host with, when it says so. */
function binary(command: string): string {
  return command === "bb" && process.env.BB_CLI ? process.env.BB_CLI : command;
}

/** Where runAfterLand's reload records its outcome for reloadOutcome. */
function reloadFiles(reloadId: string) {
  if (!/^task_[a-z0-9]+$/.test(reloadId)) throw new Error(`Refusing reload id ${reloadId}.`);
  const dir = join(tmpdir(), "the-orchestrator-reload");
  return { dir, out: join(dir, `${reloadId}.out`), exit: join(dir, `${reloadId}.exit`) };
}

/** gh as the owner's user with their keyring; never a terminal prompt. */
function runGh(args: string[], cwd: string, signal: AbortSignal): Promise<string> {
  return new Promise((done, fail) => {
    execFile(
      "gh",
      args,
      { cwd, signal, timeout: 60_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout, stderr) => {
        if (error) fail(new Error(`${stderr}\n${stdout}`.trim().split("\n").slice(-10).join("\n") || error.message));
        else done(stdout);
      },
    );
  });
}

/** An unauthenticated lookup, so a private repo reads as 404. */
async function publicVisibility(owner: string, slug: string, signal: AbortSignal): Promise<Visibility> {
  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${slug}`, {
      signal,
      headers: { accept: "application/vnd.github+json", "user-agent": "the-orchestrator" },
    });
    return visibilityFromStatus(response.status);
  } catch {
    return "unknown";
  }
}

async function pathTaken(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** The repo's main checkout itself: not a linked worktree, not a subdirectory. */
async function assertMainCheckout(repoPath: string, signal: AbortSignal) {
  if (!isAbsolute(repoPath) || resolve(repoPath) !== repoPath.replace(/\/+$/, "")) {
    throw new Error(`Refusing ${repoPath}: not an absolute, normalised path.`);
  }
  const top = (await run("git", ["rev-parse", "--show-toplevel"], repoPath, signal)).trim();
  if ((await realpath(top)) !== (await realpath(repoPath))) {
    throw new Error(`Refusing ${repoPath}: not the top of its repository.`);
  }
  const gitDir = (await run("git", ["rev-parse", "--absolute-git-dir"], repoPath, signal)).trim();
  const common = (await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], repoPath, signal)).trim();
  if ((await realpath(gitDir)) !== (await realpath(common))) {
    throw new Error(`Refusing ${repoPath}: a linked worktree, not the main checkout.`);
  }
}

/** A branch name we will hand to git as an argument: no options, no oddities. */
function assertSafeBranch(branch: string) {
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.startsWith("-") || branch.includes("..")) {
    throw new Error(`Refusing unusual branch name: ${branch}`);
  }
}

/** The branch is the worktree's own, and not a default branch. */
async function assertTaskBranch(worktreePath: string, branch: string, signal: AbortSignal) {
  assertSafeBranch(branch);
  const base = await defaultBranch(worktreePath, signal);
  if (branch === base || branch === "main" || branch === "master") {
    throw new Error(`Refusing to push ${branch}: it is a default branch.`);
  }
  const current = (
    await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], worktreePath, signal)
  ).trim();
  if (current !== branch) {
    throw new Error(`The worktree is on ${current}, not ${branch}.`);
  }
}

/** Commits of `ref` past `baseRef`, or null when git cannot count them. */
async function commitsPast(baseRef: string, ref: string, cwd: string, signal: AbortSignal): Promise<number | null> {
  try {
    const count = Number((await run("git", ["rev-list", "--count", `${baseRef}..${ref}`], cwd, signal)).trim());
    return Number.isInteger(count) ? count : null;
  } catch {
    return null;
  }
}

/** A worktree folder left by an earlier attempt, for leftoverDecision. */
async function worktreeLeftover(worktreePath: string, baseRef: string, signal: AbortSignal): Promise<LeftoverFacts> {
  let current: string | null = null;
  try {
    // A plain folder inside the repo would answer for the main checkout: only its own top level counts.
    const top = (await run("git", ["rev-parse", "--show-toplevel"], worktreePath, signal)).trim();
    if ((await realpath(top)) === (await realpath(worktreePath))) {
      current = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], worktreePath, signal)).trim();
    }
  } catch {
    current = null;
  }
  if (current === null) return { kind: "worktree", current: null, dirty: true, ahead: null };
  const status = await run("git", ["status", "--porcelain"], worktreePath, signal);
  // Deleted tracked files are not reusable either (porcelainDirty forgives them for removal only).
  const dirty = porcelainDirty(status, await untrackedSymlinks(worktreePath, status)) || /^( D|D |DD) /m.test(status);
  return { kind: "worktree", current, dirty, ahead: await commitsPast(baseRef, "HEAD", worktreePath, signal) };
}

/** A local branch left by an earlier attempt (no worktree folder), for leftoverDecision. */
async function branchLeftover(repoPath: string, branch: string, baseRef: string, signal: AbortSignal): Promise<LeftoverFacts> {
  const list = await run("git", ["worktree", "list", "--porcelain"], repoPath, signal);
  return {
    kind: "branch",
    checkedOut: branchCheckedOut(list, branch),
    ahead: await commitsPast(baseRef, `refs/heads/${branch}`, repoPath, signal),
  };
}

// ------------------------------------------------------------ on-device voice

/** A new helper source or plist compiles a new binary beside the old one. */
const HELPER_KEY = createHash("sha256")
  .update(HELPER_SOURCE)
  .update("\0")
  .update(HELPER_INFO_PLIST)
  .digest("hex")
  .slice(0, 16);
const HELPER_DIR = join(homedir(), "Library", "Caches", "the-orchestrator", "voice", HELPER_KEY);

/** Run a child to completion within `timeoutMs`; never rejects. */
function runStep(command: string, args: string[], timeoutMs: number, signal: AbortSignal): Promise<StepResult> {
  if (timeoutMs <= 0 || signal.aborted) return Promise.resolve({ kind: "timeout" });
  return new Promise((done) => {
    execFile(
      command,
      args,
      { signal, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) return done({ kind: "ok", stdout });
        const failed = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string | null };
        if (failed.code === "ENOENT") return done({ kind: "missing" });
        if (failed.killed || failed.name === "AbortError" || signal.aborted) return done({ kind: "timeout" });
        done({ kind: "exit", code: typeof failed.code === "number" ? failed.code : null, stderr: `${stderr}` });
      },
    );
  });
}

/**
 * Compile the helper once into HELPER_DIR: build in a scratch folder, then
 * rename into place, so a concurrent compile (another worker) never leaves a
 * half-written binary. Calls in this worker share one promise; a failure
 * clears it so the next call tries again.
 */
let helperBuild: Promise<string> | null = null;
function voiceHelper(): Promise<string> {
  helperBuild ??= buildVoiceHelper().catch((error: unknown) => {
    helperBuild = null;
    throw error;
  });
  return helperBuild;
}

async function buildVoiceHelper(): Promise<string> {
  const binary = join(HELPER_DIR, HELPER_NAME);
  if (existsSync(binary)) return binary;
  await mkdir(HELPER_DIR, { recursive: true });
  const work = await mkdtemp(join(HELPER_DIR, "build-"));
  try {
    const source = join(work, "main.swift");
    const plist = join(work, "Info.plist");
    const output = join(work, HELPER_NAME);
    await writeFile(source, HELPER_SOURCE);
    await writeFile(plist, HELPER_INFO_PLIST);
    const never = new AbortController().signal;
    for (const [command, args] of [
      ["/usr/bin/swiftc", swiftcArgs(source, output, plist, join(work, "module-cache"))],
      ["/usr/bin/codesign", codesignArgs(output)],
    ] as const) {
      const step = await runStep(command, [...args], 5 * 60_000, never);
      if (step.kind !== "ok") {
        throw new Error(
          step.kind === "exit"
            ? `${command} failed: ${step.stderr.trim() || `exit ${step.code}`}`
            : `${command}: ${step.kind === "missing" ? "not found" : "timed out"}`,
        );
      }
    }
    await rename(output, binary);
    return binary;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Resolve `promise`, or "timeout" once `ms` pass or the request is cancelled. */
function withinDeadline<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T | "timeout"> {
  return new Promise((done, fail) => {
    const timer = setTimeout(() => done("timeout"), ms);
    const cancel = () => done("timeout");
    signal.addEventListener("abort", cancel, { once: true });
    promise.then(done, fail).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
    });
  });
}

/**
 * The chat mic's recording → text, on this Mac: decode to a temp file, ffmpeg
 * to 16 kHz mono WAV, then the Swift helper. Temp files go in a fresh folder
 * under os.tmpdir(), removed whatever happens. The "ai.voice.transcribe"
 * handler is exactly this.
 */
export async function transcribeVoice(
  input: AiVoiceTranscribeInput,
  signal: AbortSignal,
): Promise<AiVoiceTranscribeOutput> {
  const problem = voiceRequestProblem(input);
  if (problem !== null) return problem;
  const deadline = Date.now() + input.timeoutMs;
  const left = () => remainingMs(deadline, Date.now());
  const ffmpeg = ffmpegCandidates(process.env.PATH).find((candidate) => existsSync(candidate));
  if (ffmpeg === undefined) return { ok: false, code: "service_unavailable", message: FFMPEG_MISSING };

  const work = await mkdtemp(join(tmpdir(), "orchestrator-voice-"));
  try {
    const audio = join(work, `recording.${audioExtension(input.mimeType, input.filename)}`);
    const wav = join(work, "speech.wav");
    await writeFile(audio, Buffer.from(input.audioBase64, "base64"));
    const converted = ffmpegFailure(
      await runStep(ffmpeg, ffmpegArgs(audio, wav), left(), signal),
      input.timeoutMs,
      input.mimeType,
    );
    if (converted !== null) return converted;

    let helper: string | "timeout";
    try {
      helper = await withinDeadline(voiceHelper(), left(), signal);
    } catch (error) {
      return compileFailure(error instanceof Error ? error.message : String(error));
    }
    if (helper === "timeout") return timeoutFailure(input.timeoutMs);
    return helperOutcome(await runStep(helper, [wav], left(), signal), input.timeoutMs);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** recovery.ts: the last-good build, `dist/` and its `sha`, under the plugin's data dir. */
const LAST_GOOD = "last-good";
const SHA_PATTERN = /^[0-9a-f]{7,64}$/;

/** Git's global user.name, for the owner's first name (owner.ts); null when unset or git fails. Never throws. */
function gitUserName(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile("git", ["config", "--global", "user.name"], { timeout: 5_000 }, (error, stdout) => {
        const name = error ? "" : String(stdout).trim().slice(0, 200);
        resolve(name === "" ? null : name);
      });
    } catch {
      resolve(null);
    }
  });
}

/** The local config file's text, cut just past the cap; null when there is no such file. */
async function readLocalConfigText(home: string): Promise<string | null> {
  try {
    return (await readFile(join(home, ...LOCAL_CONFIG_PATH), "utf8")).slice(0, LOCAL_CONFIG_MAX_CHARS + 1);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Where Add project makes new folders: the config's projectsDir, checked
 * against the real home directory, else ~/Documents/Github. A file with a
 * problem is an empty config here as everywhere, so the default.
 */
async function projectsDirOnHost(home: string): Promise<string> {
  const configDir = parseLocalConfig(await readLocalConfigText(home)).config.projectsDir;
  const check = projectsDirInForce(configDir, home);
  if (!check.ok) throw new Error(check.reason);
  // The default folder is used as it always was; one the config names must also really be inside home.
  if (configDir !== null && !(await insideRealHome(check.path, home))) {
    throw new Error(`${check.path} leads outside your home folder.`);
  }
  return check.path;
}

/**
 * `dir`, followed through any symlinks, is still inside the real home
 * directory. A folder that is not there yet is judged by its nearest parent
 * that is (which may be home itself).
 */
async function insideRealHome(dir: string, home: string): Promise<boolean> {
  const realHome = await realpath(home);
  let at = dir;
  for (;;) {
    let real: string;
    try {
      real = await realpath(at);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(at);
      if (parent === at) return false;
      at = parent;
      continue;
    }
    if (real.startsWith(`${realHome}/`)) return true;
    return at !== dir && real === realHome;
  }
}

/** The setup wizard's list (contract `listRepos`): immediate subfolders only, nothing followed, nothing written. */
async function listReposIn(dir: string, home: string) {
  const check = validateProjectsDir(dir, home);
  if (!check.ok) throw new Error(check.reason);
  const found = await lstat(check.path).catch(() => null);
  if (found === null) return { dir: check.path, exists: false, entries: [] as RepoEntry[], truncated: false };
  if (!(await insideRealHome(check.path, home))) throw new Error(`${check.path} leads outside your home folder.`);
  if (!(await stat(check.path)).isDirectory()) throw new Error(`${check.path} is not a folder.`);
  // isDirectory() is false for a symlink, so none is followed out of the folder.
  const names = (await readdir(check.path, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name.length <= 255)
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  const entries: RepoEntry[] = [];
  for (const name of names.slice(0, REPO_LIST_CAP)) {
    const gitDir = join(check.path, name, ".git");
    const git = (await lstat(gitDir).catch(() => null))?.isDirectory() ?? false;
    let remote: string | null = null;
    if (git) {
      const config = join(gitDir, "config");
      const info = await lstat(config).catch(() => null);
      if (info !== null && info.isFile() && info.size <= 1024 * 1024) {
        remote = originUrlOf((await readFile(config, "utf8").catch(() => "")).slice(0, GIT_CONFIG_MAX_CHARS));
      }
    }
    entries.push({ name, git, remote });
  }
  return { dir: check.path, exists: true, entries, truncated: names.length > REPO_LIST_CAP };
}

/**
 * The setup wizard's save (contract `saveSetup`). Everything is checked and
 * the new text is made before anything is created; a config file with a
 * problem stops it there. The file is written beside itself and renamed into
 * place, 0600; a config that is a symlink keeps being one.
 */
async function saveSetupTo(
  input: { projectsDir: string; ownerName?: string | null | undefined },
  home: string,
  dataDir: string,
): Promise<{ ok: true; projectsDir: string; created: boolean } | { ok: false; reason: string }> {
  const no = (reason: string) => ({ ok: false as const, reason: clip(reason, 1000) });
  const check = validateProjectsDir(input.projectsDir, home);
  if (!check.ok) return no(check.reason);
  try {
    const found = await lstat(check.path).catch(() => null);
    if (!(await insideRealHome(check.path, home))) return no(`${check.path} leads outside your home folder.`);
    if (found !== null && !(await stat(check.path)).isDirectory()) return no(`${check.path} is not a folder.`);
    const merged = mergeSetupIntoConfig(await readLocalConfigText(home), {
      projectsDir: check.path,
      ...(input.ownerName !== undefined ? { ownerName: input.ownerName } : {}),
    });
    if (!merged.ok) return no(merged.reason);
    if (found === null) await mkdir(check.path, { recursive: true });
    const file = join(home, ...LOCAL_CONFIG_PATH);
    await mkdir(dirname(file), { recursive: true });
    const target = await realpath(file).catch(() => file);
    const next = `${target}.next-${process.pid}`;
    await rm(next, { force: true });
    await writeFile(next, merged.text, { mode: 0o600, flag: "wx" });
    await rename(next, target);
    await keepLocalConfigCopy(merged.text, dataDir);
    return { ok: true, projectsDir: check.path, created: found === null };
  } catch (error) {
    return no(errorText(error));
  }
}

/** How a read-only check ended (setupwizard.ts CommandEnd). Never throws; stdout is kept only long enough to read the answer. */
function commandEnd(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<CommandEnd> {
  return new Promise((done) => {
    try {
      execFile(command, args, { cwd: tmpdir(), timeout: 15_000, maxBuffer: 1024 * 1024, env }, (error, stdout, stderr) => {
        const raw = error === null ? 0 : (error as { code?: unknown }).code;
        const code = raw === "ENOENT" ? "ENOENT" : typeof raw === "number" ? raw : null;
        done({ stdout: String(stdout).slice(0, 20_000), stderr: String(stderr).slice(0, 2_000), code });
      });
    } catch {
      done({ stdout: "", stderr: "", code: null });
    }
  });
}

/** The setup wizard's facts (contract `setupFacts`): home, and who gh and Claude say is signed in. */
async function setupFacts() {
  const [gh, claude] = await Promise.all([
    commandEnd("gh", [...GH_LOGIN_ARGS], { ...process.env, GIT_TERMINAL_PROMPT: "0" }),
    commandEnd(claudeBinary(), ["auth", "status"], setupEnv(process.env)),
  ]);
  return { home: homedir(), gh: ghSignIn(gh, parseGhLogin), claude: claudeSignInState(claude) };
}

/**
 * Keep a copy of a valid local config at <dataDir>/local-config.last-good.json
 * when it differs from the copy there: the file is in no repo, so this is the
 * only other copy on the machine. Written beside it and renamed. Best effort:
 * a failed copy never fails the read.
 */
async function keepLocalConfigCopy(text: string, dataDir: string) {
  const target = join(dataDir, LOCAL_CONFIG_LAST_GOOD);
  try {
    const kept = await readFile(target, "utf8").catch(() => null);
    if (kept === text) return;
    await mkdir(dataDir, { recursive: true });
    const next = `${target}.next-${process.pid}`;
    await writeFile(next, text, { mode: 0o600 });
    await rename(next, target);
  } catch {
    // The config itself was read; the next read tries the copy again.
  }
}

/**
 * Copy the main checkout's dist/ to <dataDir>/last-good. Built beside it and
 * swapped in whole (old away, new in, old removed), so a half-copied build is
 * never last-good.
 */
async function keepLastGood(repoPath: string, sha: string, dataDir: string, signal: AbortSignal) {
  await assertMainCheckout(repoPath, signal);
  if (!SHA_PATTERN.test(sha)) throw new Error(`Refusing sha ${sha}.`);
  const dist = join(repoPath, "dist");
  if (!(await stat(dist)).isDirectory()) throw new Error(`${dist} is not a folder.`);
  await mkdir(dataDir, { recursive: true });
  const target = join(dataDir, LAST_GOOD);
  const next = await mkdtemp(join(dataDir, `${LAST_GOOD}.next-`));
  const old = `${target}.old`;
  try {
    await cp(dist, join(next, "dist"), { recursive: true });
    await writeFile(join(next, "sha"), `${sha}\n`);
    await rm(old, { recursive: true, force: true });
    if (await pathTaken(target)) await rename(target, old);
    await rename(next, target);
  } catch (error) {
    await rm(next, { recursive: true, force: true });
    throw error;
  }
  await rm(old, { recursive: true, force: true });
}

/**
 * Put <dataDir>/last-good/dist back as <repo>/dist: copied to
 * dist.rollback-tmp, then the current dist moved to dist.bad, the copy moved
 * in and dist.bad removed. Touches nothing but <repo>/dist* and last-good.
 */
async function restoreLastGood(
  repoPath: string,
  dataDir: string,
  signal: AbortSignal,
): Promise<{ restored: boolean; sha: string | null; reason: string | null }> {
  await assertMainCheckout(repoPath, signal);
  const source = join(dataDir, LAST_GOOD);
  let sha: string;
  try {
    sha = (await readFile(join(source, "sha"), "utf8")).trim();
    if (!(await stat(join(source, "dist"))).isDirectory()) throw new Error("no dist");
  } catch {
    return { restored: false, sha: null, reason: "no last-good build has been kept yet (one is kept after the next good reload)" };
  }
  if (!SHA_PATTERN.test(sha)) return { restored: false, sha: null, reason: `the last-good sha file is unreadable (${clip(sha, 80)})` };
  const dist = join(repoPath, "dist");
  const tmp = join(repoPath, "dist.rollback-tmp");
  const bad = join(repoPath, "dist.bad");
  await rm(tmp, { recursive: true, force: true });
  await rm(bad, { recursive: true, force: true });
  try {
    await cp(join(source, "dist"), tmp, { recursive: true });
  } catch (error) {
    await rm(tmp, { recursive: true, force: true });
    return { restored: false, sha: null, reason: clip(`copying the last-good build failed: ${errorText(error)}`, 1000) };
  }
  const hadDist = await pathTaken(dist);
  if (hadDist) await rename(dist, bad);
  try {
    await rename(tmp, dist);
  } catch (error) {
    if (hadDist) await rename(bad, dist);
    await rm(tmp, { recursive: true, force: true });
    return { restored: false, sha: null, reason: clip(`moving the last-good build in failed: ${errorText(error)}`, 1000) };
  }
  await rm(bad, { recursive: true, force: true });
  return { restored: true, sha, reason: null };
}

/** landguard.ts: a guard's tests, run in the task's worktree. */
function runGuardTests(worktreePath: string, files: string[], signal: AbortSignal): Promise<{ ok: boolean; output: string }> {
  return new Promise((done) => {
    execFile(
      "npx",
      ["--no", "--", "vitest", "run", ...files],
      { cwd: worktreePath, signal, timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024, env: setupEnv(process.env) },
      (error, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`.trim();
        const tail = output.length > 3000 ? `…${output.slice(-2999)}` : output;
        done({ ok: error === null, output: tail || (error?.message ?? "").slice(0, 3000) });
      },
    );
  });
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    "ai.voice.transcribe": (input, { signal }) => transcribeVoice(input, signal),

    claudeSignIn: () => claudeSignIn(),

    "ai.inference.complete": () => ({
      ok: false as const,
      code: "request_failed" as const,
      message: "The Orchestrator's local service only transcribes voice; choose another service in Settings → AI services.",
    }),

    repoSnapshot: async ({ repoPath, previewMarker }, context): Promise<RepoSnapshot> => {
      const { signal } = context;
      const base = await defaultBranch(repoPath, signal);
      const remote = await originUrl(repoPath, signal);
      const slug = githubSlug(remote);
      const [branches, prs] = await Promise.all([
        readBranches(repoPath, base, signal),
        slug === null
          ? Promise.resolve({
              pullRequests: [] as PullRequest[],
              error:
                remote === null
                  ? "No git remote, so no pull requests."
                  : "The remote is not on GitHub.",
            })
          : readPullRequests(repoPath, slug, previewMarker, signal).then(
              (pullRequests) => ({ pullRequests, error: null }),
              (error: unknown) => ({
                pullRequests: [] as PullRequest[],
                error: clip(error instanceof Error ? error.message : String(error), 500),
              }),
            ),
      ]);
      return {
        defaultBranch: base,
        branches,
        pullRequests: prs.pullRequests,
        pullRequestError: prs.error,
        githubUrl: slug === null ? null : `https://github.com/${slug}`,
      };
    },

    prFacts: async ({ repoPath, number }, { signal }) => {
      const slug = githubSlug(await originUrl(repoPath, signal));
      if (slug === null) throw new Error("This project has no GitHub remote.");
      const out = await run(
        "gh",
        [
          "pr",
          "view",
          String(number),
          "--json",
          "number,url,state,isDraft,headRefName,headRefOid,mergeable,mergeStateStatus,labels,statusCheckRollup,files,body",
        ],
        repoPath,
        signal,
      );
      const pr = JSON.parse(out) as GhPullRequest & {
        files: { path: string }[] | null;
        body: string | null;
      };
      const checks = summarizeChecks(pr.statusCheckRollup);
      return {
        number: pr.number,
        url: pr.url.slice(0, 500),
        state: prState(pr.state),
        isDraft: pr.isDraft,
        headRefName: clip(pr.headRefName, 250),
        headRefOid: (pr.headRefOid ?? "").slice(0, 64),
        checks: checks.checks,
        failingChecks: checks.failing.slice(0, 50),
        mergeable: mergeable(pr.mergeable),
        mergeStateStatus: clip(pr.mergeStateStatus ?? "UNKNOWN", 40),
        labels: pr.labels.slice(0, 30).map((label) => clip(label.name, 80)),
        files: (pr.files ?? []).slice(0, 3000).map((file) => clip(file.path, 500)),
        body: clip(pr.body ?? "", 30_000),
        comments: await readComments(repoPath, slug, number, signal),
      };
    },

    worktreeState: async ({ worktreePath, baseRef }, { signal }) => {
      const branch = (
        await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], worktreePath, signal)
      ).trim();
      const headSha = (await run("git", ["rev-parse", "HEAD"], worktreePath, signal)).trim();
      const status = await run("git", ["status", "--porcelain"], worktreePath, signal);
      let ahead = 0;
      try {
        ahead = Number(
          (await run("git", ["rev-list", "--count", `${baseRef}..HEAD`], worktreePath, signal)).trim(),
        );
      } catch {
        ahead = 0;
      }
      let files: string[] = [];
      try {
        files = (await run("git", ["diff", "--name-only", "--no-renames", `${baseRef}...HEAD`], worktreePath, signal))
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "")
          .slice(0, 2000)
          .map((file) => clip(file, 500));
      } catch {
        files = [];
      }
      return {
        branch: branch === "HEAD" ? null : clip(branch, 250),
        headSha: headSha.slice(0, 64),
        dirty: status.trim() !== "",
        ahead: Number.isFinite(ahead) ? ahead : 0,
        files,
      };
    },

    branchFate: async ({ repoPath, branch, headSha, base }, { signal }) => {
      assertSafeBranch(branch);
      assertSafeBranch(base);
      const local = await gitYesNo(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoPath, signal);
      const remote = await gitYesNo(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], repoPath, signal);
      if (headSha === null) return { local, remote, headOnBase: null };
      if (!/^[0-9a-f]{4,64}$/.test(headSha)) throw new Error(`Refusing unusual sha: ${headSha}`);
      const hasOrigin = await gitYesNo(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${base}`], repoPath, signal);
      let headOnBase = false;
      try {
        headOnBase = await gitYesNo(["merge-base", "--is-ancestor", headSha, hasOrigin ? `origin/${base}` : base], repoPath, signal);
      } catch {
        // An unknown sha (gc'd, never fetched) is not on the base.
      }
      return { local, remote, headOnBase };
    },

    mainCommits: async ({ repoPath, since, branches = [] }, { signal }) => {
      const base = await defaultBranch(repoPath, signal);
      assertSafeBranch(base);
      // A task's own build: the local tip of its branch, when it still exists.
      const tips: { branch: string; sha: string }[] = [];
      for (const branch of new Set(branches)) {
        try {
          assertSafeBranch(branch);
        } catch {
          continue;
        }
        try {
          const sha = (await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoPath, signal)).trim();
          if (/^[0-9a-f]{40,64}$/.test(sha)) tips.push({ branch, sha });
        } catch {
          // No such branch here: nothing of it to match.
        }
      }
      const refs: string[] = [];
      for (const ref of [`refs/heads/${base}`, `refs/remotes/origin/${base}`]) {
        if (await gitYesNo(["show-ref", "--verify", "--quiet", ref], repoPath, signal)) refs.push(ref);
      }
      if (refs.length === 0) return { base, commits: [], tips };
      const out = await run(
        "git",
        ["log", `--max-count=${MAIN_COMMIT_LIMIT}`, `--since=@${Math.floor(since / 1000)}`, "--format=%H%x1f%ct%x1f%B%x1e", ...refs, "--"],
        repoPath,
        signal,
      );
      const commits = out
        .split("\x1e")
        .map((record) => record.replace(/^\n+/, ""))
        .filter((record) => record.trim() !== "")
        .map((record) => {
          const [sha = "", seconds = "0", message = ""] = record.split("\x1f");
          return { sha: sha.trim().slice(0, 64), committedAt: Number(seconds) * 1000, message: clip(message.trim(), 4000) };
        })
        .filter((commit) => /^[0-9a-f]{40,64}$/.test(commit.sha));
      return { base, commits, tips };
    },

    pushBranch: async ({ worktreePath, branch, target, expectedOld }, { signal }) => {
      await assertTaskBranch(worktreePath, branch, signal);
      if (target !== undefined && target !== branch) {
        assertSafeBranch(target);
        const base = await defaultBranch(worktreePath, signal);
        if (target === base || target === "main" || target === "master") {
          throw new Error(`Refusing to push to ${target}: it is a default branch.`);
        }
        await run("git", ["fetch", "origin", `refs/heads/${target}:refs/remotes/origin/${target}`], worktreePath, signal);
        const remoteSha = (await run("git", ["rev-parse", `refs/remotes/origin/${target}`], worktreePath, signal)).trim();
        if (expectedOld !== undefined && remoteSha !== expectedOld) {
          throw new Error(
            `origin/${target} is at ${remoteSha.slice(0, 7)}, not ${expectedOld.slice(0, 7)} as the PR reported: pushed nothing.`,
          );
        }
        const fastForward = await gitYesNo(["merge-base", "--is-ancestor", remoteSha, "HEAD"], worktreePath, signal);
        if (!fastForward) {
          throw new Error(
            `${branch} does not contain origin/${target} (${remoteSha.slice(0, 7)}): pushing it would not be a fast-forward, so nothing was pushed. Rebase ${branch} onto origin/${target} first.`,
          );
        }
        // Never --force: git itself rejects anything but a fast-forward here too.
        await run("git", ["push", "origin", `HEAD:refs/heads/${target}`], worktreePath, signal);
        const headSha = (await run("git", ["rev-parse", "HEAD"], worktreePath, signal)).trim();
        return { headSha: headSha.slice(0, 64) };
      }
      // Never --force: a rejected push is information, not an obstacle.
      await run(
        "git",
        ["push", "--set-upstream", "origin", `refs/heads/${branch}:refs/heads/${branch}`],
        worktreePath,
        signal,
      );
      const headSha = (await run("git", ["rev-parse", "HEAD"], worktreePath, signal)).trim();
      return { headSha: headSha.slice(0, 64) };
    },

    createPullRequest: async ({ worktreePath, branch, base, title, body }, { signal }) => {
      await assertTaskBranch(worktreePath, branch, signal);
      assertSafeBranch(base);
      const out = await run(
        "gh",
        ["pr", "create", "--head", branch, "--base", base, "--title", title, "--body-file", "-"],
        worktreePath,
        signal,
        body,
      );
      const url = out.trim().split("\n").pop() ?? "";
      const number = Number(url.match(/\/pull\/(\d+)/)?.[1]);
      if (!Number.isInteger(number)) {
        throw new Error(`gh pr create printed no PR URL: ${clip(out, 200)}`);
      }
      return { number, url: url.slice(0, 500) };
    },

    prepareWorktree: async ({ repoPath, worktreePath, pluginRoot, branch, baseRef, include, productionEnv, reuse, prHead }, { signal }) => {
      if (!isRepoWorktreePath(repoPath, worktreePath)) {
        throw new Error(`Refusing a worktree outside ${repoPath}/${WORKTREES_DIR}.`);
      }
      assertSafeBranch(branch);
      assertSafeBranch(baseRef);
      const relative = worktreePath.slice(repoPath.replace(/\/+$/, "").length + 1);
      try {
        await run("git", ["check-ignore", "-q", relative], repoPath, signal);
      } catch {
        throw new Error(
          `.claude/ is not gitignored in ${repoPath}. Add it to that repo's .gitignore (on a branch) before building there.`,
        );
      }
      // What this call creates, and so removes again if a later step fails.
      let createdWorktree = false;
      let createdBranch = false;
      if (existsSync(worktreePath)) {
        if (reuse) {
          await assertTaskBranch(worktreePath, branch, signal);
        } else {
          const decision = leftoverDecision(await worktreeLeftover(worktreePath, baseRef, signal), {
            worktreePath,
            branch,
            baseRef,
          });
          if (decision.action === "refuse") throw new Error(decision.reason);
        }
      } else {
        let branchExists = false;
        let fromOrigin = false;
        try {
          await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoPath, signal);
          branchExists = true;
        } catch {
          branchExists = false;
        }
        let resetBranch = false;
        if (branchExists && !reuse) {
          const decision = leftoverDecision(await branchLeftover(repoPath, branch, baseRef, signal), {
            worktreePath,
            branch,
            baseRef,
          });
          if (decision.action === "refuse") throw new Error(decision.reason);
          resetBranch = true;
        }
        if (!branchExists && reuse) {
          // A follow-up round on a PR whose branch is only on origin now:
          // recreate the local branch from it, not from the base.
          try {
            await run("git", ["fetch", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`], repoPath, signal);
          } catch {
            // Offline or gone: the check below decides.
          }
          if (await gitYesNo(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], repoPath, signal)) {
            await run("git", ["worktree", "add", "-b", branch, worktreePath, `origin/${branch}`], repoPath, signal);
            createdWorktree = true;
            createdBranch = true;
            branchExists = true;
            fromOrigin = true;
          }
        }
        if (!fromOrigin) {
          if (baseRef.startsWith("origin/")) {
            try {
              await run("git", ["fetch", "origin", baseRef.slice("origin/".length)], repoPath, signal);
            } catch {
              // Offline: cut from the last fetched origin ref rather than failing.
            }
          }
          await run(
            "git",
            resetBranch
              ? ["worktree", "add", "-B", branch, worktreePath, baseRef]
              : branchExists
                ? ["worktree", "add", worktreePath, branch]
                : ["worktree", "add", "-b", branch, worktreePath, baseRef],
            repoPath,
            signal,
          );
          createdWorktree = true;
          createdBranch = !branchExists;
        }
      }

      try {
        if (prHead !== undefined) {
          if (!/^[0-9a-f]{7,64}$/.test(prHead)) throw new Error(`Refusing unusual sha: ${prHead}`);
          try {
            await run("git", ["fetch", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`], worktreePath, signal);
          } catch {
            // Offline: the sha may already be here; the checks below decide.
          }
          if (!(await gitYesNo(["merge-base", "--is-ancestor", prHead, "HEAD"], worktreePath, signal))) {
            if (!(await gitYesNo(["merge-base", "--is-ancestor", "HEAD", prHead], worktreePath, signal))) {
              throw new Error(
                `${branch} in ${worktreePath} has diverged from its PR's head ${prHead.slice(0, 7)}: rebase it onto origin/${branch} before building again.`,
              );
            }
            await run("git", ["merge", "--ff-only", prHead], worktreePath, signal);
          }
        }

        let fromRepo: string[] = [];
        try {
          fromRepo = parseWorktreeInclude(await readFile(join(repoPath, ".worktreeinclude"), "utf8"));
        } catch {
          // No .worktreeinclude: the profile's list stands alone.
        }
        // A productionEnv profile copies no env file, whichever list names it.
        const patterns = mergeWorktreeInclude(include, fromRepo, productionEnv);
        let copied = 0;
        const unmatched: string[] = [];
        for (const pattern of patterns) {
          const matcher = includeMatcher(pattern);
          if (matcher === null) {
            unmatched.push(pattern);
            continue;
          }
          let names: string[] = [];
          try {
            const entries = await readdir(join(repoPath, matcher.dir), { withFileTypes: true });
            names = entries.filter((entry) => entry.isFile() && matcher.matches(entry.name)).map((entry) => entry.name);
          } catch {
            names = [];
          }
          if (names.length === 0) unmatched.push(pattern);
          for (const name of names) {
            const to = join(worktreePath, matcher.dir, name);
            await mkdir(dirname(to), { recursive: true });
            try {
              // COPYFILE_EXCL: never replace what the worktree already tracks.
              await copyFile(join(repoPath, matcher.dir, name), to, fsConstants.COPYFILE_EXCL);
              copied += 1;
            } catch {
              // Already present in the checkout (tracked): leave it.
            }
          }
        }
        await writeBuilderGuard(pluginRoot, repoPath, worktreePath, patterns);
        return { copied, unmatched: unmatched.slice(0, 50), guarded: true as const };
      } catch (error) {
        for (const argv of cleanupAfterFailedPrepare({ createdWorktree, createdBranch }, { worktreePath, branch })) {
          try {
            await run("git", argv, repoPath, AbortSignal.timeout(30_000));
          } catch {
            // Best effort: whatever stays is a leftover the next attempt's leftoverDecision judges.
          }
        }
        throw error;
      }
    },

    memoryStatus: async (_input, { signal }) => readMemory(signal),

    retireLegacyRoute: async (input, { signal }) => retireLegacyRoute(input, signal),

    localConfig: async (_input, { experimental_paths }) => {
      const text = await readLocalConfigText(homedir());
      if (text === null) return { text: null, gitUserName: await gitUserName() };
      if (parseLocalConfig(text).problem === null) await keepLocalConfigCopy(text, experimental_paths.dataDir);
      return { text, gitUserName: await gitUserName() };
    },

    setupFacts: () => setupFacts(),

    listRepos: ({ dir }) => listReposIn(dir, homedir()),

    saveSetup: (input, { experimental_paths }) => saveSetupTo(input, homedir(), experimental_paths.dataDir),

    summarizeTitle: async ({ prompt, model }, { signal }) => claudeOnce(prompt, model, signal),

    jevAsk: async ({ title, brief }, { signal }) => jevAskOnce(title, brief, signal),

    modelRoute: async ({ state, checkout }, { signal }) => modelRouteOnce(state, checkout, signal),

    routeKeyStatus: async ({ checkout }) => {
      const key = await readJevKey(checkout);
      return key.ok ? { present: true as const, file: clip(key.file, 1000) } : { present: false as const, problem: key.problem, file: key.file === null ? null : clip(key.file, 1000) };
    },

    killProcess: async (input, { signal }) => {
      const result = await killAgentProcess(input, signal);
      return { killed: result.killed, detail: clip(result.detail, 300) };
    },

    killWorktreeProcesses: async ({ repoPath, worktreePath }) => {
      if (!isRepoWorktreePath(repoPath, worktreePath)) {
        throw new Error(`Refusing to kill processes outside ${repoPath}/${WORKTREES_DIR}.`);
      }
      await experimental_killProcessesWithCwdUnder({ directory: worktreePath });
      return { ok: true as const };
    },

    runSetup: async ({ worktreePath, commands }, { signal }) => {
      for (const argv of commands) {
        const [command, ...args] = argv;
        if (command === undefined) continue;
        try {
          await runLong(command, args, worktreePath, signal);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return { ok: false, failure: clip(`${argv.join(" ")}\n${detail}`, 3000) };
        }
      }
      return { ok: true, failure: null };
    },

    inspectWorktree: async ({ worktreePath, baseRef }, { signal }) =>
      inspectWorktree(worktreePath, baseRef, signal),

    removeWorktree: async ({ repoPath, worktreePath, baseRef }, { signal }) => {
      if (!isRepoWorktreePath(repoPath, worktreePath)) {
        throw new Error(`Refusing to remove a path outside ${repoPath}/${WORKTREES_DIR}.`);
      }
      const decision = cleanupDecision(await inspectWorktree(worktreePath, baseRef, signal), {
        exists: existsSync(repoPath),
      });
      if (!decision.remove) {
        if (decision.gone) {
          try {
            await run("git", ["worktree", "prune"], repoPath, signal);
          } catch {
            // The folder is gone either way; git's own record goes on its next prune.
          }
        }
        return { removed: false, gone: decision.gone, reason: decision.reason };
      }
      await experimental_killProcessesWithCwdUnder({ directory: worktreePath });
      const status = await run("git", ["status", "--porcelain"], worktreePath, signal);
      if (porcelainDirty(status, await untrackedSymlinks(worktreePath, status))) {
        return { removed: false, gone: false, reason: "Worktree has uncommitted changes: kept." };
      }
      await run("git", ["worktree", "remove", ...forceFor(status), worktreePath], repoPath, signal);
      return { removed: true, gone: false, reason: null };
    },

    listWorktreeDirs: async ({ repoPath }, { signal }) => {
      const root = join(repoPath, WORKTREES_DIR);
      if (!existsSync(root)) return [];
      const registered = await registeredWorktrees(repoPath, signal);
      const dirs = [];
      for (const entry of await readdir(root, { withFileTypes: true })) {
        const dir = worktreePathFor(repoPath, entry.name);
        if (!entry.isDirectory() || !isRepoWorktreePath(repoPath, dir)) continue;
        dirs.push({ slug: entry.name, registered: await isRegistered(registered, dir), empty: await holdsNoFiles(dir) });
        if (dirs.length >= 500) break;
      }
      return dirs;
    },

    removeOrphanWorktree: async ({ repoPath, worktreePath }, { signal }) => {
      if (!isRepoWorktreePath(repoPath, worktreePath)) {
        throw new Error(`Refusing to remove a path outside ${repoPath}/${WORKTREES_DIR}.`);
      }
      // A real folder, not a symlink out of the repo.
      const info = await lstat(worktreePath).catch(() => null);
      if (info === null) return { removed: false, reason: null };
      if (!info.isDirectory()) return { removed: false, reason: "Not a folder: kept." };
      const registered = await isRegistered(await registeredWorktrees(repoPath, signal), worktreePath);
      if (!registered) {
        const decision = orphanDecision({ registered, empty: await holdsNoFiles(worktreePath) });
        if (decision.action === "keep") return { removed: false, reason: decision.reason };
        try {
          await removeEmptyTree(worktreePath);
        } catch (error) {
          return { removed: false, reason: clip(`Could not remove the empty folder: ${errorText(error)}`, 300) };
        }
        return { removed: true, reason: null };
      }
      // A folder that lost its .git file would have git answer for the main
      // checkout instead: it must be its own worktree's top level.
      const real = await realpath(worktreePath);
      const top = await run("git", ["rev-parse", "--show-toplevel"], worktreePath, signal).catch(() => "");
      if ((await realpath(top.trim() || "/").catch(() => "")) !== real) {
        return { removed: false, reason: "Not a working git worktree: kept." };
      }
      // Activity first, and status without optional locks: our own look must
      // not refresh the index and read as activity.
      const active = await lastActiveAt(worktreePath, signal);
      const status = await run("git", ["--no-optional-locks", "status", "--porcelain"], worktreePath, signal);
      const unlanded = unlandedCommits(await cherryAgainstMain(repoPath, worktreePath, signal));
      const decision = orphanDecision({
        registered,
        dirty: porcelainDirty(status, await untrackedSymlinks(worktreePath, status)),
        unlanded: unlanded === null ? null : unlanded.length,
        inUse: await cwdInside(real, signal),
        lastActiveAt: active,
        now: Date.now(),
      });
      if (decision.action === "keep") return { removed: false, reason: decision.reason };
      // No process is killed for an orphan. Re-read the status right before
      // removing; the branch is left alone.
      const again = await run("git", ["--no-optional-locks", "status", "--porcelain"], worktreePath, signal);
      if (porcelainDirty(again, await untrackedSymlinks(worktreePath, again))) {
        return { removed: false, reason: "Uncommitted changes: kept." };
      }
      try {
        await run("git", ["worktree", "remove", ...forceFor(again), worktreePath], repoPath, signal);
      } catch (error) {
        return { removed: false, reason: clip(`git worktree remove failed: ${errorText(error)}`, 300) };
      }
      return { removed: true, reason: null };
    },

    landBranch: async ({ repoPath, worktreePath, branch, target }, { signal }) => {
      if (!isRepoWorktreePath(repoPath, worktreePath)) {
        throw new Error(`Refusing a worktree outside ${repoPath}/${WORKTREES_DIR}.`);
      }
      assertSafeBranch(target);
      await assertTaskBranch(worktreePath, branch, signal);
      if ((await run("git", ["status", "--porcelain"], worktreePath, signal)).trim() !== "") {
        throw new Error("The worktree has uncommitted changes: the builder must commit first.");
      }
      const current = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], repoPath, signal)).trim();
      if (current !== target) throw new Error(`The main checkout is on ${current}, not ${target}.`);
      const tracked = (await run("git", ["status", "--porcelain", "--untracked-files=no"], repoPath, signal)).trim();
      if (tracked !== "") {
        throw new Error(`The main checkout has uncommitted changes, so nothing was landed:\n${tracked.split("\n").slice(0, 10).join("\n")}`);
      }
      try {
        await run("git", ["rebase", target], worktreePath, signal);
      } catch (error) {
        try {
          await run("git", ["rebase", "--abort"], worktreePath, signal);
        } catch {
          // Nothing to abort: the rebase never started.
        }
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${branch} does not rebase cleanly onto ${target}; rebase aborted, nothing landed. ${detail}`);
      }
      const commits = Number((await run("git", ["rev-list", "--count", `${target}..${branch}`], repoPath, signal)).trim()) || 0;
      if (commits === 0) throw new Error(`${branch} has nothing ${target} does not already have.`);
      await run("git", ["merge", "--ff-only", branch], repoPath, signal);
      const headSha = (await run("git", ["rev-parse", "HEAD"], repoPath, signal)).trim();
      return { headSha, commits };
    },

    pushBackup: async ({ repoPath, remote, branch }, { signal }) => {
      await assertMainCheckout(repoPath, signal);
      assertSafeBranch(branch);
      if (!/^[A-Za-z0-9._-]+$/.test(remote) || remote.startsWith("-")) {
        throw new Error(`Refusing unusual remote name: ${remote}`);
      }
      // Never --force: a rejected non-fast-forward is reported, not overridden.
      // No terminal prompt: missing credentials fail now instead of hanging.
      return new Promise((done) => {
        execFile(
          "git",
          ["push", remote, `${branch}:${branch}`],
          { cwd: repoPath, signal, timeout: 55_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
          (error, stdout, stderr) => {
            const output = `${stdout}\n${stderr}`.trim().split("\n").slice(-25).join("\n");
            if (error) done({ ok: false, output: "", error: clip(output || error.message, 3000) });
            else done({ ok: true, output: clip(output, 3000), error: null });
          },
        );
      });
    },

    runAfterLand: async ({ repoPath, commands, reloadId }, { signal }) => {
      await assertMainCheckout(repoPath, signal);
      for (const argv of commands) {
        if (argv[0] !== "bb") throw new Error(`Refusing ${argv.join(" ")}: after land only runs bb.`);
      }
      const build = commands.slice(0, -1);
      const last = commands[commands.length - 1]!;
      let output = "";
      for (const argv of build) {
        const [command = "", ...args] = argv;
        try {
          output = await runLong(binary(command), args, repoPath, signal);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          return { ok: false, output: "", error: clip(`${argv.join(" ")}\n${detail}`, 3000), outcomeDir: null };
        }
      }
      // The last command reloads this very plugin, host included: start it
      // detached, a second from now, so the land reply gets out first. With a
      // reloadId it records its output, then its exit code (atomically, last),
      // for reloadOutcome: nobody else would learn whether the reload worked.
      const [command = "", ...args] = last;
      let script = 'sleep 1; exec "$0" "$@"';
      let env = setupEnv(process.env);
      let outcomeDir: string | null = null;
      if (reloadId !== undefined) {
        const files = reloadFiles(reloadId);
        await mkdir(files.dir, { recursive: true });
        await Promise.all([files.out, files.exit, `${files.exit}.tmp`].map((file) => rm(file, { force: true })));
        script = 'sleep 1; "$0" "$@" >"$OUT" 2>&1; echo $? >"$EXIT.tmp" && mv "$EXIT.tmp" "$EXIT"';
        env = { ...env, OUT: files.out, EXIT: files.exit };
        outcomeDir = files.dir;
      }
      const child = spawn("/bin/sh", ["-c", script, binary(command), ...args], {
        cwd: repoPath,
        detached: true,
        stdio: "ignore",
        env,
      });
      child.on("error", () => {
        // Nothing to report to: with a reloadId, the missing .exit file times out.
      });
      child.unref();
      const tail = output.trim().split("\n").slice(-25).join("\n");
      return { ok: true, output: clip(tail, 3000), error: null, outcomeDir };
    },

    reloadOutcome: async ({ reloadId }) => {
      const files = reloadFiles(reloadId);
      const read = async (file: string) => {
        try {
          return await readFile(file, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
      };
      // The exit file first: once it is there, the output is complete.
      const exit = await read(files.exit);
      const output = (await read(files.out)) ?? "";
      const code = exit === null ? null : Number.parseInt(exit.trim(), 10);
      const trimmed = output.trim();
      return {
        exitCode: code === null || Number.isNaN(code) ? null : code,
        output: trimmed.length > 3000 ? `…${trimmed.slice(-2999)}` : trimmed,
      };
    },

    keepLastGood: async ({ repoPath, sha }, { signal, experimental_paths }) => {
      try {
        await keepLastGood(repoPath, sha, experimental_paths.dataDir, signal);
        return { ok: true, error: null };
      } catch (error) {
        return { ok: false, error: clip(errorText(error), 1000) };
      }
    },

    restoreLastGood: async ({ repoPath }, { signal, experimental_paths }) =>
      restoreLastGood(repoPath, experimental_paths.dataDir, signal),

    runGuardTests: async ({ repoPath, worktreePath, files }, { signal }) => {
      if (!isRepoWorktreePath(repoPath, worktreePath)) {
        throw new Error(`Refusing a worktree outside ${repoPath}/${WORKTREES_DIR}.`);
      }
      for (const file of files) {
        if (!/^[A-Za-z0-9_-]+\.test\.ts$/.test(file)) throw new Error(`Refusing test file ${file}.`);
      }
      return runGuardTests(worktreePath, files, signal);
    },

    pluginStatus: async ({ pluginId }, { signal }) => {
      const out = await runLong(binary("bb"), ["plugin", "list", "--json"], tmpdir(), signal);
      return pluginStatusOf(out, pluginId);
    },

    createProject: async ({ name, slug, registeredPaths }, { signal }) => {
      if (!SLUG_PATTERN.test(slug)) throw new Error(`Refusing folder name ${slug}: letters, digits and dashes only.`);
      const parent = await projectsDirOnHost(homedir());
      // The server checked names; the path is only known here.
      const check = validateNewProject(name, { names: [], paths: registeredPaths }, parent);
      if (!check.ok) throw new Error(check.reason);
      if (check.slug !== slug) throw new Error(`Refusing folder name ${slug}: ${name} makes ${check.slug}.`);
      const path = check.path;
      const parentStat = await lstat(parent).catch(() => null);
      if (parentStat === null) {
        try {
          await mkdir(parent, { recursive: true });
        } catch (error) {
          throw new Error(`Could not create ${parent}: ${errorText(error)}`);
        }
      } else if (!parentStat.isDirectory()) throw new Error(`${parent} is not a folder.`);
      // lstat, so a symlink counts as taken too.
      if (await pathTaken(path)) throw new Error(folderExistsReason(path));
      const step = async (what: string, work: () => Promise<unknown>) => {
        try {
          await work();
        } catch (error) {
          throw new Error(`${what} failed: ${errorText(error)}. What was made so far is in ${path}; nothing was deleted.`);
        }
      };
      try {
        await mkdir(path);
      } catch (error) {
        throw new Error(`Could not create ${path}: ${errorText(error)}`);
      }
      await step("Writing the first files", async () => {
        for (const file of firstCommitFiles(name)) await writeFile(join(path, file.path), file.content, { flag: "wx" });
      });
      await step("git init", () => run("git", ["init", "-b", "main"], path, signal));
      await step("git add", () => run("git", ["add", "-A"], path, signal));
      await step("The first commit", () => run("git", ["commit", "-m", firstCommitMessage(name)], path, signal));

      // From here on the local project exists: a gh failure is reported, not thrown.
      // The owner is whoever gh is signed in as on this machine.
      let owner: string | null;
      let ownerError = "gh did not name an account";
      try {
        owner = parseGhLogin(await runGh([...GH_LOGIN_ARGS], path, signal));
      } catch (error) {
        owner = null;
        ownerError = errorText(error);
      }
      if (owner === null) {
        return {
          path,
          github: {
            ok: false as const,
            error: clip(`GitHub CLI is not signed in, so no repo was created: ${ownerError}`, 3000),
            retry: "gh auth login",
          },
        };
      }
      const retry = ghRetryCommand(owner, slug, path);
      try {
        await runGh(ghCreateArgs(owner, slug, path), path, signal);
      } catch (error) {
        return { path, github: { ok: false as const, error: clip(errorText(error), 3000), retry: clip(retry, 2000) } };
      }
      const repo = `${owner}/${slug}`;
      const url = `https://github.com/${repo}`;
      let visibility = await publicVisibility(owner, slug, signal);
      if (visibility === "public") {
        try {
          await runGh(["repo", "edit", repo, "--visibility", "private", "--accept-visibility-change-consequences"], path, signal);
        } catch (error) {
          return {
            path,
            github: {
              ok: false as const,
              error: clip(`${url} was created PUBLIC and could not be made private: ${errorText(error)}`, 3000),
              retry: `gh repo edit ${repo} --visibility private --accept-visibility-change-consequences`,
            },
          };
        }
        visibility = await publicVisibility(owner, slug, signal);
        if (visibility === "public") {
          return {
            path,
            github: {
              ok: false as const,
              error: `${url} is still PUBLIC after gh repo edit.`,
              retry: `gh repo edit ${repo} --visibility private --accept-visibility-change-consequences`,
            },
          };
        }
      }
      if (visibility === "unknown") {
        return {
          path,
          github: {
            ok: false as const,
            error: `${url} was created with --private, but the check from outside got no clear answer, so it is not confirmed private.`,
            retry: `gh repo view ${repo} --json visibility`,
          },
        };
      }
      return { path, github: { ok: true as const, url, visibility } };
    },

    applyLabel: async ({ repoPath, number, label, readd }, { signal }) => {
      if (readd) {
        try {
          await run("gh", ["pr", "edit", String(number), "--remove-label", label], repoPath, signal);
        } catch {
          // Not on the PR any more: adding it below is what matters.
        }
      }
      await run("gh", ["pr", "edit", String(number), "--add-label", label], repoPath, signal);
      return { ok: true };
    },
  },
});
