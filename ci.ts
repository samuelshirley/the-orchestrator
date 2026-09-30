// Red CI is never left sitting. Once per PR head, a PR whose checks really
// failed gets an owner: the task whose PR it is is told to fix it, and an open
// PR no task owns gets a "Fix failing CI" task of its own. Both wait behind the
// same gates as any new work (usage, memory) and are deferred, never dropped.
// A cancelled or skipped run is not a failure. Pure; ci.test.ts pins it.
import { owner, owners } from "./owner";
import type { PullRequest } from "./contract";
import { prForTask, untrackedPullRequests } from "./model";
import { prCounts } from "./release";
import type { Task } from "./store";

/**
 * Outcomes that make a check red on the board but are not a failure to fix.
 * Concurrency groups cancel a run when a newer push lands; that must not start
 * fix tasks.
 */
export const NOT_A_FAILURE = new Set(["CANCELLED", "SKIPPED", "NEUTRAL", "STALE"]);

/** A backlog of stale red PRs must not start a burst of threads: one new task per pass. */
export const MAX_CI_STARTS_PER_PASS = 1;

const TITLE_MAX = 120;

const short = (sha: string) => sha.slice(0, 7);

/** Open, red, with a head we can key on, and at least one check that really failed. */
export function isCiFailure(
  pr: Pick<PullRequest, "state" | "checks" | "headRefOid" | "failedConclusions">,
): boolean {
  return (
    pr.state === "open" &&
    pr.checks === "failing" &&
    pr.headRefOid !== "" &&
    pr.failedConclusions.some((conclusion) => !NOT_A_FAILURE.has(conclusion.toUpperCase()))
  );
}

/** Meta key set once a red head has been acted on (told or started). */
export function ciFailedKey(projectId: string, prNumber: number, sha: string): string {
  return `ci_failed:${projectId}:${prNumber}:${sha}`;
}

/** Meta key noting a red head waits on a gate, so the wait is logged once. */
export function ciDeferredKey(key: string): string {
  return `ci_deferred:${key}`;
}

export type CiAction =
  | { kind: "tell"; taskId: string; threadId: string; key: string; message: string }
  | { kind: "start"; projectId: string; prNumber: number; key: string; title: string; brief: string }
  | { kind: "defer"; key: string; prNumber: number; taskId: string | null; reason: string };

function clipTitle(title: string): string {
  return title.length <= TITLE_MAX ? title : `${title.slice(0, TITLE_MAX - 1)}…`;
}

function realFailures(pr: PullRequest): string[] {
  return [...new Set(pr.failedConclusions.map((c) => c.toUpperCase()))];
}

export function ownerMessage(pr: PullRequest): string {
  return (
    `[The Orchestrator] CI is failing on your PR #${pr.number} ("${pr.title}") at ${short(pr.headRefOid)}. ` +
    `It is yours to fix: read the failing checks (gh pr checks ${pr.number}; gh run view --log-failed), ` +
    `fix the cause on the PR's branch through build, then open_pr and ready_for_review. ` +
    `Do not weaken a test to pass. Merging stays ${owners()}.`
  );
}

export function fixTitle(pr: PullRequest): string {
  return clipTitle(`Fix failing CI on PR #${pr.number}: ${pr.title}`);
}

export function fixBrief(pr: PullRequest, projectName: string): string {
  return [
    `CI is failing on PR #${pr.number} "${pr.title}" in ${projectName}.`,
    `Branch ${pr.headRefName}, head ${short(pr.headRefOid)}, ${pr.url}. Failed conclusions: ${realFailures(pr).join(", ")}.`,
    `No open task owns this PR, so this task does.`,
    `Investigate: gh pr checks ${pr.number}; gh run view --log-failed.`,
    `Fix the real cause on the PR's own branch: this task records PR #${pr.number}, so build continues that branch and open_pr pushes to it.`,
    `If it is not a code problem (a flaky runner, a missing secret, infrastructure), say so with the evidence and ask_sam as a decision or a command only ${owner()} can run.`,
    `Never weaken a test to pass. Merging stays ${owners()}.`,
  ].join("\n");
}

/**
 * What to do about this project's red PRs, ordered by PR number: one action per
 * red head not yet acted on. `acted` says a key was already handled (persisted
 * or in flight). `gate` is why new work must wait now (usage, memory), or null.
 * `startsLeft` is how many new tasks this pass may still start.
 */
export function ciFailureActions({
  projectId,
  projectName,
  pullRequests,
  openTasks,
  acted,
  gate,
  startsLeft,
}: {
  projectId: string;
  projectName: string;
  pullRequests: readonly PullRequest[];
  /** This project's open tasks. */
  openTasks: readonly Task[];
  acted: (key: string) => boolean;
  gate: string | null;
  startsLeft: number;
}): CiAction[] {
  const actions: { prNumber: number; action: CiAction }[] = [];
  const seen = new Set<string>();
  const owned = new Set<number>();

  for (const task of openTasks) {
    const pr = prForTask(task, pullRequests);
    if (pr === null || !prCounts(task, pr)) continue;
    owned.add(pr.number);
    if (task.threadId === null || !isCiFailure(pr)) continue;
    const key = ciFailedKey(projectId, pr.number, pr.headRefOid);
    if (seen.has(key) || acted(key)) continue;
    seen.add(key);
    actions.push({
      prNumber: pr.number,
      action:
        gate !== null
          ? { kind: "defer", key, prNumber: pr.number, taskId: task.id, reason: gate }
          : { kind: "tell", taskId: task.id, threadId: task.threadId, key, message: ownerMessage(pr) },
    });
  }

  let starts = startsLeft;
  const unowned = untrackedPullRequests(pullRequests, openTasks).sort((a, b) => a.number - b.number);
  for (const pr of unowned) {
    if (owned.has(pr.number) || pr.isDraft || !isCiFailure(pr)) continue;
    const key = ciFailedKey(projectId, pr.number, pr.headRefOid);
    if (seen.has(key) || acted(key)) continue;
    if (gate !== null) {
      seen.add(key);
      actions.push({ prNumber: pr.number, action: { kind: "defer", key, prNumber: pr.number, taskId: null, reason: gate } });
      continue;
    }
    if (starts <= 0) continue;
    starts -= 1;
    seen.add(key);
    actions.push({
      prNumber: pr.number,
      action: {
        kind: "start",
        projectId,
        prNumber: pr.number,
        key,
        title: fixTitle(pr),
        brief: fixBrief(pr, projectName),
      },
    });
  }

  return actions.sort((a, b) => a.prNumber - b.prNumber).map((entry) => entry.action);
}

export type CiPassDeps = {
  /** The key was already handled: persisted, or in flight right now. */
  acted: (key: string) => boolean;
  /** A wait on this key was already noted (and logged). */
  deferredNoted: (key: string) => boolean;
  /** Persist the key: only after the action succeeded. */
  markActed: (key: string) => void;
  noteDeferred: (key: string, reason: string) => void;
  tell: (action: Extract<CiAction, { kind: "tell" }>) => Promise<void>;
  /** Throws to mean "not started, try later". */
  start: (action: Extract<CiAction, { kind: "start" }>) => Promise<void>;
  log: (message: string) => void;
};

/**
 * One pass over every project's red PRs: act on what ciFailureActions says.
 * The start budget is shared by the whole pass, and a start that fails still
 * spent it. A key is set only once its action succeeded, so a failed tell or
 * start is tried again next pass; a wait is noted and logged once.
 */
export async function runCiPass({
  projects,
  openTasks,
  gate,
  deps,
}: {
  projects: readonly { projectId: string; projectName: string; pullRequests: readonly PullRequest[] }[];
  /** All open tasks; each project gets its own. */
  openTasks: readonly Task[];
  /** Why new work must wait in this project now (usage, memory), or null. */
  gate: (projectId: string) => string | null;
  deps: CiPassDeps;
}): Promise<{ told: number; started: number; deferred: number; failed: number }> {
  const result = { told: 0, started: 0, deferred: 0, failed: 0 };
  let startsLeft = MAX_CI_STARTS_PER_PASS;
  const noteOnce = (key: string, reason: string, line: string) => {
    if (deps.deferredNoted(key)) return;
    deps.noteDeferred(key, reason);
    deps.log(line);
  };

  for (const project of projects) {
    const actions = ciFailureActions({
      projectId: project.projectId,
      projectName: project.projectName,
      pullRequests: project.pullRequests,
      openTasks: openTasks.filter((task) => task.projectId === project.projectId),
      acted: deps.acted,
      gate: gate(project.projectId),
      startsLeft,
    });
    for (const action of actions) {
      if (action.kind === "defer") {
        result.deferred += 1;
        noteOnce(action.key, action.reason, `ci: PR #${action.prNumber} waits: ${action.reason}`);
        continue;
      }
      if (action.kind === "tell") {
        try {
          await deps.tell(action);
          deps.markActed(action.key);
          result.told += 1;
        } catch (error) {
          result.failed += 1;
          deps.log(`ci: telling ${action.taskId} about red CI failed, retried next pass: ${errorText(error)}`);
        }
        continue;
      }
      if (startsLeft <= 0) continue;
      startsLeft -= 1;
      try {
        await deps.start(action);
        deps.markActed(action.key);
        result.started += 1;
      } catch (error) {
        result.failed += 1;
        const message = errorText(error);
        noteOnce(action.key, message, `ci: PR #${action.prNumber} not started, retried next pass: ${message}`);
      }
    }
  }
  return result;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
