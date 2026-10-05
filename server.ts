// The Orchestrator — backend entry.
//
// One project manager, Patches, runs tasks across every project. She has a
// chat per project, and no other; every chat reads the one dossier and
// shares the build cap (chats.ts). Each task is a long-lived thread under
// the chat that started it, in its own project; research and build threads
// hang under the task. This file
// owns the dossier (SQLite), the agent tools that move a task through
// Research → Build → PR → You, and the RPC the board reads. Policy lives in
// the pure modules: chats.ts, claims.ts, validation.ts, model.ts, prompts.ts,
// worktrees.ts.
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineRpcContract, type BbPluginApi, type MessageDispatchHookContext, type MessageDispatchHookDecision } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  ACTIVITY_EVENT_ROWS,
  ACTIVITY_EVENT_TYPES,
  activityLines,
  unreadableLine,
  whichThreads,
} from "./activity.js";
import { closedCounts, closedTaskPage, closedTaskSummary } from "./archive.js";
import { BUILD_FAILURE_LIMIT, SAM_ONLY_REASONS, buildFailedMessage, validateAsk, type Ask } from "./attention.js";
import {
  RETIRED_ANY_CHAT_KEY,
  chatKey,
  chatOfThreadKey,
  chatRefusal,
  chatTasks,
  claimedChat,
  focusedProject,
  isUnread,
  parentFixes,
  reattachedMessage,
  replyAtKey,
  seenAtKey,
  shouldStartChat,
  unheardReason,
  type ParentFix,
} from "./chats.js";
import { pluginSourceRoot } from "./builderguard.js";
import { CHECKOUT_PROVIDER, pickCheckoutEnvironment } from "./checkout.js";
import { ciDeferredKey, runCiPass } from "./ci.js";
import { claimWaitKey, claimWaitsToWake, outsideClaims, outsideClaimsRefusal, planClaims, type ClaimWait } from "./claims.js";
import { hostContract, repoSnapshotSchema, type PrFacts, type PullRequest, type RepoSnapshot } from "./contract.js";
import { BUILD_CAP, MAX_OPEN_QUESTIONS, answeredTaskPatch, buildsInFlight, prForTask } from "./model.js";
import { createMemoryGuard } from "./guard.js";
import {
  WAIT_RETRY_MS,
  WATCHDOG_INTERVAL_MS,
  buildRefusal,
  describeReading,
  dispatchDecision,
  stoppedMessage,
  type AgentRole,
  type MemoryReading,
  type RunningAgent,
} from "./memory.js";
import { leaseDecision } from "./browser.js";
import {
  LIVENESS_INTERVAL_MS,
  agentLiveness,
  chatTrouble,
  livenessActions,
  taskLiveness,
  type AgentRole as LiveRole,
  type Hold,
  type Kill,
  type LivenessAction,
  type LimitWait,
  type Probe,
  type ProbeStatus,
} from "./liveness.js";
import { OWNER_NAME_KEY, OWNER_NAME_MAX, Owner, owner, ownerFirstName, owners, setOwner } from "./owner.js";
import { plumbingRefusal } from "./plumbing.js";
import { INITIAL_LOCAL_CONFIG, configBlocks, nextLocalConfig, type LocalConfigState } from "./localconfig.js";
import { backupPush, buildBaseRef, profileFor, worktreeIncludeOf, type ProjectProfile } from "./profiles.js";
import { headShaUpdate, prCounts, staleReason, type BranchFate } from "./release.js";
import { threadRole } from "./roles.js";
import {
  closeHeldKey,
  closeHold,
  heldCloseMessage,
  holdWhat,
  type CloseHold,
  releaseCloseRefusal,
  withdrawDecision,
  withdrawnByPatchesMessage,
  withdrawnWhat,
} from "./tickets.js";
import { landCandidate, landedClose, REPORT_MAX, reportKey } from "./landed.js";
import {
  REPORT_FOLLOW_UP_MAX,
  REPORT_SUMMARY_MAX,
  REPORT_TITLE_MAX,
  followUpRefusal,
  reportFollowUpMessage,
  reportReviewedMessage,
  reportReviewedNote,
  reportSubmittedReply,
  reportSummary,
  reportTitleRefusal,
  reportToldMessage,
  type ReportRef,
} from "./report.js";
import {
  decideReload,
  parsePendingReload,
  RELOAD_CHECK_MS,
  RELOAD_PREFIX,
  reloadedMessage,
  reloadedNote,
  reloadFailureReason,
  reloadKey,
  type PendingReload,
  type PluginStatus,
  type ReloadOutcome,
} from "./reload.js";
import {
  migrationPending,
  shouldKeepLastGood,
  SNAPSHOT_KEEP,
  snapshotDue,
  snapshotName,
  snapshotsToPrune,
  withRollback,
  type RollbackResult,
  type SnapshotReason,
} from "./recovery.js";
import { guardTestRule } from "./landguard.js";
import { reviewLabel, reviewStale, reviewVoidedMessage } from "./review.js";
import {
  ARCHIVE_CLOSED_KEY,
  archiveDue,
  archiveEnabled,
  doneBlocker,
  doneNote,
  followUpDue,
  followUpItem,
  followUpMessage,
  followUpOf,
  followUpOfBlocker,
  followUpToldKey,
  idleKey,
  landedFollowUpMessage,
  threadsArchivedKey,
  type DoneArgs,
} from "./done.js";
import { taskThreads } from "./scope.js";
import { threadListProviderId } from "./sidebar.js";
import {
  CLAUDE_USAGE_PLUGIN,
  USAGE_GET_METHOD,
  USAGE_LIST_METHOD,
  addPaused,
  clock,
  limitHitOf,
  mayWake,
  notResumedMessage,
  parseUsage,
  recordHit,
  restartRefusal,
  resumeStep,
  startRefusal,
  usageStatusLine,
  usageView,
  wakeMessage,
  wantsRefresh,
  type HitRole,
  type LimitHit,
  type PausedStart,
  type StartKind,
  type UsageReading,
} from "./usage.js";
import {
  signinHoldReason,
  SIGNIN_RETRY_REASON,
  isSignedOut,
  isWaiting,
  recordSignedOut,
  signInBack,
  SIGN_IN_COMMAND,
  signInHold,
  signInRestartRefusal,
  signInStartRefusal,
  signInStatusLine,
  signInStep,
  signInWakeMessage,
  signedOutOf,
  signedOutView,
  wantsSignInRefresh,
  type SignedOut,
} from "./signin.js";
import {
  PATCHES,
  buildPrompt,
  builderInstructions,
  dossierSummary,
  patchesInstructions,
  researchInstructions,
  researchPrompt,
  taskDetail,
  taskInstructions,
  newTaskPrompt,
  taskPrompt,
} from "./prompts.js";
import { validateNewProject } from "./newproject.js";
import {
  DEFAULT_PROJECTS_DIR,
  GH_SIGN_IN_COMMAND,
  needsSetup,
  ownerNameToSave,
  pickRepos,
  repoChoices,
  type SignIn,
} from "./setupwizard.js";
import { newTaskBlock, parentChatFor, parseSummaryTitle, summaryTitlePrompt, taskFromAsk, TITLE_MODEL } from "./newtask.js";
import { UI_OTHER_AGENTS_OPEN_KEY, closedTaskThreadIds, looseCandidates, savedFlag } from "./others.js";
import { VOICE_DISPLAY_NAME, VOICE_MODEL, VOICE_SERVICE_ID, VOICE_TIMEOUT_MS } from "./voice.js";
import { MIGRATIONS, Store, type BuildRequest, type SqlDb, type Task } from "./store.js";
import { JEV_TIMEOUT_MS, agreementReport, askRecord, failedAsk, shouldCall, type JevAskReply } from "./jevwatch.js";
import {
  ROUTE_TIMEOUT_MS,
  ROUTE_WINDOW_MS,
  ownerPickedModel,
  routeBackoff,
  routeDecision,
  routeFailed,
  routePause,
  routeSkip,
  routeState,
  skippedRoute,
  spawnModel,
  type RouteRecord,
  type RouteRole,
} from "./modelroute.js";
import { ERROR_SUMMARY_PREFIX, outcomeLogLine, routeOutcomes, staleFate, type TaskFate } from "./routeoutcome.js";
import { deriveTestList, howToOpenGap, validatePr } from "./validation.js";
import { flag, text as textArg } from "./toolargs.js";
import {
  buildWaitsForReload,
  keepOpenAfterLand,
  parseMore,
  parseSteps,
  serializeSteps,
  stepKeptReply,
  stepLanded,
  stepLandedMessage,
  stepReleaseReason,
  stepsKey,
  type StepsRecord,
} from "./steps.js";
import { branchFor, isRepoWorktreePath, recordAfterCleanup, sweepTargets, taskSlug, worktreePathFor } from "./worktrees.js";
import { followUpBuild, prPushPlan, pushReachedPr } from "./prbranch.js";

/** A repo snapshot shells out to git and gh; open windows share one. */
const REPO_CACHE_MS = 20_000;
const FOCUS_KEY = "focus_project_id";
/** How long after the plugin starts its first host calls wait: bb refuses them while it is still registering. */
const FIRST_HOST_CALL_MS = 1_000;
/** Patches' provider, as the app's chat composer defaults to (app.tsx PATCHES_PROVIDER). */
const PATCHES_PROVIDER = "claude-code";
const DOSSIER_CHANNEL = "dossier";
const WORKTREE_PROVIDER = "git-worktree";
const SETUP_TIMEOUT_MS = 20 * 60_000;
/** The server runs from <repo>/dist; the host from bb's artifacts copy, so the host is told this. */
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = pluginSourceRoot(SERVER_DIR);
/** Meta key: when the last daily dossier snapshot was taken, ms. */
const SNAPSHOT_AT_KEY = "dossier_snapshot_at";
const SNAPSHOT_CHECK_MS = 60 * 60_000;

// ------------------------------------------------------------ dossier snapshots
// recovery.ts decides; these do the I/O. VACUUM INTO writes a consistent copy
// even while the dossier is in use (never a file copy), into snapshots/ beside
// data.db, which stays on this Mac and is never pushed anywhere.

type SnapshotDb = ReturnType<BbPluginApi["storage"]["database"]>;

/** Snapshot the dossier, then prune to SNAPSHOT_KEEP; returns the new file. */
function snapshotDossier(db: SnapshotDb, reason: SnapshotReason): string {
  const rows = db.prepare("PRAGMA database_list").all() as { name: string; file: string }[];
  const file = rows.find((row) => row.name === "main")?.file ?? "";
  if (file === "") throw new Error("the dossier has no file to snapshot beside");
  const dir = join(dirname(file), "snapshots");
  mkdirSync(dir, { recursive: true });
  const target = join(dir, snapshotName(Date.now(), reason));
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  for (const name of snapshotsToPrune(readdirSync(dir), SNAPSHOT_KEEP)) rmSync(join(dir, name), { force: true });
  return target;
}

/** Migrations bb.storage.migrate has applied (_bb_migrations rows); null for a dossier with no tables yet. */
function appliedMigrations(db: SnapshotDb): number | null {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  if (tables.length === 0) return null;
  if (!tables.some((table) => table.name === "_bb_migrations")) return 0;
  return (db.prepare("SELECT COUNT(*) AS n FROM _bb_migrations").get() as { n: number }).n;
}

// ------------------------------------------------------------------ RPC shapes

const projectViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  isPersonal: z.boolean(),
  path: z.string().nullable(),
  hostId: z.string().nullable(),
  color: z.string().nullable(),
  hidden: z.boolean(),
  profile: z.string(),
  /** The label a proven PR must keep for its review ticket to hold (review.ts). */
  reviewLabel: z.string().nullable(),
});

const taskViewSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  stage: z.enum(["research", "build", "pr", "you", "done"]),
  threadId: z.string().nullable(),
  branch: z.string().nullable(),
  worktreePath: z.string().nullable(),
  worktreeNote: z.string().nullable(),
  buildState: z.enum(["none", "preparing", "running", "failed"]),
  buildError: z.string().nullable(),
  buildFailures: z.number(),
  buildRequest: z
    .object({ touches: z.array(z.string()), branch: z.string().nullable(), instructions: z.string() })
    .nullable(),
  prNumber: z.number().nullable(),
  prUrl: z.string().nullable(),
  headSha: z.string().nullable(),
  verdict: z
    .object({ kind: z.string(), reasons: z.array(z.string()), headSha: z.string().nullable(), at: z.number() })
    .nullable(),
  verifiedSha: z.string().nullable(),
  decisions: z.array(z.object({ question: z.string(), decision: z.string() })),
  testList: z.array(z.string()),
  note: z.string().nullable(),
  claims: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
  closedAt: z.number().nullable(),
  brief: z.string(),
  baseRef: z.string().nullable(),
  /** A done report's remaining item (done.ts followUpOf); the board shows "Done, with a follow-up". */
  followUp: z.string().nullable(),
  /** Steps left after the task's last land (steps.ts); the board shows "Step landed, N left". */
  stepsLeft: z.number(),
});

/** A stale tool schema may send an object argument as its JSON text: parse it. */
function parseJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** ask_sam's input and the board's view of it; attention.ts holds the rules. */
const askSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("decision"),
    question: z.string().min(10).max(1500),
    options: z.array(z.string().min(1).max(300)).min(2).max(5),
    recommended: z.number().int().min(0).describe("Index of the option you recommend."),
  }),
  z.object({
    kind: z.literal("command"),
    question: z.string().min(10).max(1500).describe("What it does and why only the owner can run it."),
    command: z.string().min(1).max(2000),
    cwd: z.string().max(1000).nullable(),
    reason: z.enum(SAM_ONLY_REASONS),
  }),
]);

const ticketViewSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  kind: z.enum(["questions", "review", "report"]),
  /** A report ticket's file, title and summary (report.ts); null on other kinds. */
  report: z.object({ path: z.string(), title: z.string(), summary: z.string().nullable() }).nullable().optional(),
  questions: z.array(z.string()),
  asks: z.array(askSchema),
  answers: z.array(z.string()).nullable(),
  status: z.enum(["open", "closed"]),
  createdAt: z.number(),
  closedAt: z.number().nullable(),
});

const childViewSchema = z.object({
  threadId: z.string(),
  taskId: z.string(),
  kind: z.enum(["research", "build"]),
  label: z.string(),
  summary: z.string().nullable(),
  createdAt: z.number(),
});

const patchesChatSchema = z.object({
  projectId: z.string(),
  threadId: z.string(),
  unread: z.boolean(),
});

const jevQuestionReportSchema = z.object({
  compared: z.number(),
  agree: z.number(),
  rate: z.number().nullable(),
  confusion: z.record(z.string(), z.record(z.string(), z.number())),
  errors: z.number(),
  timeouts: z.number(),
});
const jevReportSchema = z.object({
  rows: z.number(),
  open: z.number(),
  kind: jevQuestionReportSchema,
  tier: jevQuestionReportSchema,
  riskyMiss: z.number(),
  errors: z.number(),
  timeouts: z.number(),
  p50LatencyMs: z.number().nullable(),
});

/** One sign-in for the wizard: the state, who, and the command that fixes it. */
const signInViewSchema = z.object({
  state: z.enum(["in", "out", "missing", "unknown"]),
  account: z.string().nullable(),
  command: z.string(),
});

export const boardStateSchema = z.object({
  patchesChats: z.array(patchesChatSchema),
  focusProjectId: z.string().nullable(),
  /** The owner's first name (owner.ts): the app's copy of it for the board's words. */
  ownerName: z.string(),
  /** First run (setupwizard.ts needsSetup): the board opens the setup wizard by itself. */
  needsSetup: z.boolean(),
  /** Where Add project makes new folders: the local config's projectsDir, else ~/Documents/Github. */
  projectsDir: z.string(),
  primaryHostId: z.string().nullable(),
  projects: z.array(projectViewSchema),
  tasks: z.array(taskViewSchema),
  tickets: z.array(ticketViewSchema),
  children: z.array(childViewSchema),
  /** Closed tasks per project, for the Completed header; the list itself is closed_tasks (archive.ts). */
  closedCounts: z.record(z.string(), z.number()),
  buildsInFlight: z.number(),
  buildCap: z.number(),
  /** Our sidebar list's provider id, and whether the one-time switch to it happened. */
  sidebar: z.object({ provider: z.string(), adopted: z.boolean() }),
  /** "Archive chats of done tasks after 10 min" (done.ts). */
  archiveClosedChats: z.boolean(),
  /** Threads of every closed task and their children: not "other agents" (others.ts). */
  closedThreadIds: z.array(z.string()),
  /** The owner's saved board choices; null where they have not chosen. */
  ui: z.object({ otherAgentsOpen: z.boolean().nullable() }),
  /** Jev's watch-only agreement per project (jevwatch.ts); a project with no rows is absent. */
  jevWatch: z.array(z.object({ projectId: z.string(), report: jevReportSchema })),
  /** How each agent's model and effort were picked (modelroute.ts): the last 14 days and every open task's threads. */
  modelRoutes: z.array(
    z.object({
      threadId: z.string(),
      projectId: z.string(),
      role: z.string(),
      routedAt: z.number(),
      model: z.string().nullable(),
      reason: z.string(),
      probability: z.number().nullable(),
      /** The Jev version that answered. */
      answeredBy: z.string().nullable(),
      effort: z.string().nullable(),
      effortReason: z.string().nullable(),
      effortProbability: z.number().nullable(),
      /** What the agent came to (routeoutcome.ts); "open" while it has not. */
      outcome: z.object({
        kind: z.enum(["landed", "ok", "failed", "abandoned", "errored", "open"]),
        buildFailures: z.number(),
        questions: z.number(),
      }),
    }),
  ),
  /** Jev's back-off after a failed route (modelroute.ts routePause): when it ends and why; null when it does not hold. */
  modelRoutePause: z.object({ until: z.number(), reason: z.string() }).nullable(),
  /** Whether the host has a usable TypeSafe key, and the file it is in or about (presence and a path only, typesafe.ts jevKey); null when it cannot say. */
  modelRouteKey: z
    .union([
      z.object({ present: z.literal(true), file: z.string() }),
      z.object({ present: z.literal(false), problem: z.enum(["missing", "open", "tracked"]), file: z.string().nullable() }),
    ])
    .nullable(),
  /** Claude is signed out (signin.ts signedOutView): the one Needs you item; null when signed in. */
  signedOut: z.object({ since: z.number(), waiting: z.number(), latest: z.number(), command: z.string() }).nullable(),
});
export type BoardState = z.infer<typeof boardStateSchema>;
export type ProjectView = z.infer<typeof projectViewSchema>;
export type TaskView = z.infer<typeof taskViewSchema>;

/** A Completed row: light, so a page of them never carries briefs or decisions. */
const closedTaskRowSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    title: z.string(),
    threadId: z.string().nullable(),
    note: z.string().nullable(),
    prNumber: z.number().nullable(),
    prUrl: z.string().nullable(),
    closedAt: z.number().nullable(),
  })
  .strict();
export type ClosedTaskRow = z.infer<typeof closedTaskRowSchema>;

const closedTaskViewSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    title: z.string(),
    brief: z.string(),
    note: z.string().nullable(),
    branch: z.string().nullable(),
    prNumber: z.number().nullable(),
    prUrl: z.string().nullable(),
    createdAt: z.number(),
    closedAt: z.number().nullable(),
    how: z.string(),
    sha: z.string().nullable(),
    decisions: z.array(z.object({ question: z.string(), decision: z.string() }).strict()),
    questions: z.array(z.object({ question: z.string(), answer: z.string().nullable(), askedAt: z.number() }).strict()),
    withdrawals: z.array(
      z.object({ questions: z.array(z.string()), reason: z.string(), by: z.enum(["task", "patches"]), at: z.number() }).strict(),
    ),
    releases: z.array(
      z
        .object({ paths: z.array(z.string()), reason: z.string(), by: z.enum(["patches", "auto"]), closed: z.boolean(), at: z.number() })
        .strict(),
    ),
    threads: z.array(
      z
        .object({
          threadId: z.string(),
          kind: z.enum(["task", "research", "build"]),
          label: z.string(),
          summary: z.string().nullable(),
          /** "archived" can be read; "gone" (deleted, or the host no longer knows it) cannot. */
          state: z.enum(["live", "archived", "gone"]),
        })
        .strict(),
    ),
    /** Its newest report, readable after archiving (report_read). */
    report: z.object({ ticketId: z.string(), title: z.string(), path: z.string() }).strict().nullable(),
  })
  .strict();
export type ClosedTaskView = z.infer<typeof closedTaskViewSchema>;
export type PatchesChatView = z.infer<typeof patchesChatSchema>;

export const reposSchema = z.object({
  fetchedAt: z.number(),
  repos: z.array(
    z.object({
      projectId: z.string(),
      repo: repoSnapshotSchema.nullable(),
      error: z.string().nullable(),
    }),
  ),
});
export type Repos = z.infer<typeof reposSchema>;

const ok = z.object({ ok: z.literal(true) });

const roleSchema = z.enum(["task", "research", "build"]);
export const livenessSchema = z.object({
  /** When the server's last check finished; null before the first. */
  checkedAt: z.number().nullable(),
  /** Why the last check failed; null when it worked. */
  error: z.string().nullable(),
  tasks: z.array(
    z.object({
      taskId: z.string(),
      working: z.boolean(),
      waiting: z.string().nullable(),
      /** Why Patches is not told when its thread goes idle (liveness.ts TaskLiveness.unheard). */
      unheard: z.string().nullable(),
      trouble: z.array(
        z.object({
          kind: z.enum(["error", "blocked", "stale", "dead-build", "killed"]),
          threadId: z.string().nullable(),
          role: roleSchema,
          reason: z.string(),
          samMustAct: z.boolean(),
        }),
      ),
      agents: z.array(
        z.object({
          threadId: z.string(),
          role: roleSchema,
          state: z.enum(["working", "waiting", "idle", "blocked", "stale", "error", "gone"]),
          reason: z.string().nullable(),
        }),
      ),
    }),
  ),
  /** Why the owner's local config is not in use (localconfig.ts), for the board's red line; null when it is fine. */
  configProblem: z.string().nullable(),
  /** Patches chats in trouble (liveness.ts chatTrouble): the board's alert line. */
  chats: z.array(z.object({ projectId: z.string().nullable(), threadId: z.string(), trouble: z.string() })),
  /** Loose threads outside every task and chat (others.ts looseCandidates): display only. */
  others: z.array(
    z.object({
      threadId: z.string(),
      state: z.enum(["working", "waiting", "idle", "blocked", "stale", "error", "gone"]),
      reason: z.string().nullable(),
    }),
  ),
  /** Claude usage's fullest window (usage.ts usageView); null before the first reading. */
  usage: z
    .object({
      level: z.enum(["ok", "near", "limit"]),
      percent: z.number(),
      label: z.string(),
      resetsAt: z.number().nullable(),
      observedAt: z.number().nullable(),
    })
    .nullable(),
});
export type LivenessView = z.infer<typeof livenessSchema>;

/** The Live box (activity.ts): one pane per working thread of a task, its newest lines last. */
const taskActivitySchema = z.object({
  panes: z.array(
    z.object({
      threadId: z.string(),
      kind: z.enum(["task", "research", "build"]),
      label: z.string(),
      working: z.boolean(),
      lines: z.array(
        z.object({
          id: z.string(),
          at: z.number(),
          kind: z.enum(["command", "read", "edit", "tool", "message", "other"]),
          text: z.string(),
          output: z.string().nullable(),
          running: z.boolean(),
        }),
      ),
    }),
  ),
  checkedAt: z.number(),
});
export type TaskActivity = z.infer<typeof taskActivitySchema>;

export const rpcContract = defineRpcContract({
  board_state: { input: z.object({}).strict(), output: boardStateSchema },
  repos_snapshot: { input: z.object({ force: z.boolean() }).strict(), output: reposSchema },
  project_prefs: {
    input: z
      .object({
        projectId: z.string().min(1).max(100),
        color: z.string().max(20).nullable().optional(),
        hidden: z.boolean().optional(),
      })
      .strict(),
    output: ok,
  },
  project_add: {
    input: z
      .object({
        hostId: z.string().min(1).max(100),
        path: z.string().min(1).max(1000),
        name: z.string().min(1).max(100),
      })
      .strict(),
    output: z.object({ projectId: z.string() }),
  },
  /**
   * Add project: a new folder under the projects folder (the local config's
   * projectsDir, else ~/Documents/Github) with a first commit, a
   * private GitHub repo and its own Patches chat (newproject.ts). A gh failure
   * still registers the project and returns why, with the command to retry.
   */
  project_create: {
    input: z.object({ hostId: z.string().min(1).max(100), name: z.string().min(1).max(100) }).strict(),
    output: z.object({
      projectId: z.string(),
      path: z.string(),
      github: z.union([
        z.object({ ok: z.literal(true), url: z.string(), visibility: z.enum(["private", "public", "unknown"]) }),
        z.object({ ok: z.literal(false), error: z.string(), retry: z.string() }),
      ]),
    }),
  },
  /**
   * The setup wizard (setupwizard.ts): whether it opens by itself, the folder
   * it suggests, the home directory its inline check needs (null: no host
   * answered), the owner's name, and whether GitHub and Claude are signed in.
   */
  setup_state: {
    input: z.object({}).strict(),
    output: z.object({
      needsSetup: z.boolean(),
      home: z.string().nullable(),
      projectsDir: z.string().nullable(),
      suggestedDir: z.string(),
      ownerName: z.string(),
      /** Why the config file cannot be saved to right now; null when it can. */
      configProblem: z.string().nullable(),
      signIn: z.object({
        gh: signInViewSchema,
        claude: signInViewSchema,
      }),
    }),
  },
  /** The folders in `dir` and which can be ticked (setupwizard.ts repoChoices). Read-only. */
  setup_list: {
    input: z.object({ dir: z.string().min(1).max(600) }).strict(),
    output: z.object({
      dir: z.string(),
      exists: z.boolean(),
      choices: z.array(
        z.object({
          name: z.string(),
          path: z.string(),
          remote: z.string().nullable(),
          added: z.boolean(),
          selectable: z.boolean(),
          reason: z.string().nullable(),
        }),
      ),
      note: z.string().nullable(),
    }),
  },
  /**
   * Save the folder (and the name, when it was changed) into the local config,
   * then add each ticked repo as a project the way Add existing folder… does.
   * A refused save throws and adds nothing; one repo failing does not stop the rest.
   */
  setup_save: {
    input: z
      .object({
        projectsDir: z.string().min(1).max(600),
        ownerName: z.string().max(200),
        repos: z.array(z.string().min(1).max(255)).max(200),
      })
      .strict(),
    output: z.object({
      projectsDir: z.string(),
      created: z.boolean(),
      results: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string(), projectId: z.string().nullable() })),
    }),
  },
  /** Removes the bb project itself — only with its name typed back. Files are never touched. */
  project_remove: {
    input: z
      .object({ projectId: z.string().min(1).max(100), confirmName: z.string().max(100) })
      .strict(),
    output: ok,
  },
  /** A new Patches chat: a project's own. */
  orchestrator_register: {
    input: z.object({ threadId: z.string().min(1).max(100), projectId: z.string().min(1).max(100) }).strict(),
    output: ok,
  },
  /** The owner has the chat on screen: its replies so far are read. */
  chat_seen: {
    input: z.object({ projectId: z.string().min(1).max(100) }).strict(),
    output: ok,
  },
  focus_set: {
    input: z.object({ projectId: z.string().min(1).max(100) }).strict(),
    output: ok,
  },
  /** The app switched the sidebar to our list (or found the owner's own pick): never again. */
  sidebar_adopted: { input: z.object({}).strict(), output: ok },
  ticket_answer: {
    input: z
      .object({
        ticketId: z.string().min(1).max(100),
        answers: z.array(z.string().max(4000)).max(20),
        note: z.string().max(4000),
      })
      .strict(),
    output: ok,
  },
  ticket_close: {
    input: z.object({ ticketId: z.string().min(1).max(100) }).strict(),
    output: ok,
  },
  /**
   * A report's markdown for the board (report.ts): the ticket's path checked
   * again by the host, same rules and 2 MB cap. Read-only; closed tickets too
   * (Completed's Report link).
   */
  report_read: {
    input: z.object({ ticketId: z.string().min(1).max(100) }).strict(),
    output: z.object({ title: z.string(), path: z.string(), text: z.string(), hostId: z.string() }).strict(),
  },
  /** The owner's Mark reviewed: the report ticket closes, and the task with it ("Report reviewed by <owner>"). */
  report_reviewed: {
    input: z.object({ ticketId: z.string().min(1).max(100) }).strict(),
    output: z.object({ closed: z.boolean() }).strict(),
  },
  /** The owner's Follow up: their note goes to the task thread; the report ticket stays open. */
  report_follow_up: {
    input: z.object({ ticketId: z.string().min(1).max(100), note: z.string().max(REPORT_FOLLOW_UP_MAX) }).strict(),
    output: ok,
  },
  /** The owner's Retry on a failed build: the same touches and instructions again. */
  build_retry: {
    input: z.object({ taskId: z.string().min(1).max(100) }).strict(),
    output: z.object({ message: z.string() }),
  },
  /** The owner's Dismiss: forget the failed build; the task hears it was dropped. */
  build_dismiss: {
    input: z.object({ taskId: z.string().min(1).max(100) }).strict(),
    output: ok,
  },
  /** The owner's board choices, kept in the dossier: Other agents open or closed. */
  ui_pref: {
    input: z.object({ otherAgentsOpen: z.boolean() }).strict(),
    output: ok,
  },
  /** The Sign in with Claude button: the primary host starts `claude auth login`, which opens the browser's sign-in tab. */
  claude_sign_in: {
    input: z.object({}).strict(),
    output: z.object({ ok: z.boolean(), error: z.string().nullable() }),
  },
  /** The last liveness check (liveness.ts): cached, so polling it costs nothing. */
  liveness: { input: z.object({}).strict(), output: livenessSchema },
  /** The owner's Restart on a task thread in trouble: retry its failed turn, or stop a silent one and tell it to carry on. */
  agent_restart: {
    input: z.object({ taskId: z.string().min(1).max(100) }).strict(),
    output: z.object({ message: z.string() }),
  },
  /** The owner's "+": a task in its own clean chat, their first message its brief (newtask.ts). */
  task_new: {
    input: z
      .object({
        projectId: z.string().min(1).max(100),
        // The composer's PromptInput parts, forwarded to spawn unchanged.
        input: z.array(z.any()).min(1).max(20),
        providerId: z.string().max(100).optional(),
        model: z.string().max(200).optional(),
        reasoningLevel: z.enum(["none", "low", "medium", "high", "xhigh", "max", "ultra", "ultracode"]).optional(),
        permissionMode: z.enum(["accept-edits", "auto", "full"]).optional(),
        serviceTier: z.enum(["default", "fast"]).optional(),
        executionInputSources: z
          .object({
            providerId: z.enum(["client-preference", "explicit"]).optional(),
            model: z.enum(["client-preference", "explicit"]).optional(),
            reasoningLevel: z.enum(["client-preference", "explicit"]).optional(),
            permissionMode: z.enum(["client-preference", "explicit"]).optional(),
            serviceTier: z.enum(["client-preference", "explicit"]).optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    output: z.object({ taskId: z.string(), threadId: z.string() }),
  },
  /**
   * The owner's ×: close the task, archive its chats (restorable), remove its
   * worktree only if nothing is uncommitted or unpushed. PRs and branches stay.
   */
  task_delete: {
    input: z.object({ taskId: z.string().min(1).max(100) }).strict(),
    output: z.object({ worktree: z.enum(["none", "removed", "kept"]), reason: z.string().optional() }),
  },
  /** Read (no `enabled`) or set "Archive chats of done tasks after 10 min". */
  archive_closed_chats: {
    input: z.object({ enabled: z.boolean().optional() }).strict(),
    output: z.object({ enabled: z.boolean() }),
  },
  /** One page of a project's closed tasks, searched, newest first (archive.ts closedTaskPage). Read-only. */
  closed_tasks: {
    input: z
      .object({
        projectId: z.string().min(1).max(100),
        query: z.string().max(200).optional(),
        offset: z.number().optional(),
        limit: z.number().optional(),
      })
      .strict(),
    output: z.object({ rows: z.array(closedTaskRowSchema), total: z.number() }).strict(),
  },
  /**
   * A closed task's dossier summary (archive.ts closedTaskSummary) and whether
   * each of its chats is still there. Read-only: never unarchives or messages.
   */
  closed_task: {
    input: z.object({ taskId: z.string().min(1).max(100) }).strict(),
    output: closedTaskViewSchema,
  },
  /**
   * What a task's agents are doing (activity.ts): its working threads' newest
   * commands, file reads and edits, tool calls and messages, secrets masked.
   * Read-only: never sends, stops or changes a thread.
   */
  task_activity: {
    input: z.object({ taskId: z.string().min(1).max(100) }).strict(),
    output: taskActivitySchema,
  },
});
export type SetupState = z.infer<typeof rpcContract.setup_state.output>;
export type SetupList = z.infer<typeof rpcContract.setup_list.output>;
export type SetupSaved = z.infer<typeof rpcContract.setup_save.output>;

// ----------------------------------------------------------------- the plugin

export default async function plugin(bb: BbPluginApi) {
  /** A reload is live only once an instance started after it says so (reload.ts). */
  const INSTANCE_STARTED_AT = Date.now();
  const db = bb.storage.database();
  // A snapshot before any pending migration; its failure never blocks loading.
  try {
    const applied = appliedMigrations(db);
    if (applied !== null && migrationPending(applied, MIGRATIONS.length)) {
      bb.log.info(`dossier snapshot before migrating: ${snapshotDossier(db, "migration")}`);
    }
  } catch (error) {
    bb.log.warn(`dossier snapshot before migrating failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  bb.storage.migrate(db, [...MIGRATIONS]);
  const store = new Store(db as unknown as SqlDb);
  // The name as of the last local config load, so what is built during
  // registration (tool descriptions) already has it; loadLocalConfig keeps it current.
  setOwner(store.getMeta(OWNER_NAME_KEY));

  function dailySnapshot() {
    try {
      const raw = store.getMeta(SNAPSHOT_AT_KEY);
      if (!snapshotDue(raw === null ? null : Number(raw), Date.now())) return;
      bb.log.info(`daily dossier snapshot: ${snapshotDossier(db, "daily")}`);
      store.setMeta(SNAPSHOT_AT_KEY, String(Date.now()));
    } catch (error) {
      bb.log.warn(`daily dossier snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  dailySnapshot();
  const snapshotTimer = setInterval(dailySnapshot, SNAPSHOT_CHECK_MS);
  bb.onDispose(() => clearInterval(snapshotTimer));
  const host = bb.hosts.experimental_client({ contract: hostContract });

  // The chat mic transcribes on this Mac: with this service chosen for voice
  // (Settings → AI services), recordings go to host.ts's "ai.voice.transcribe"
  // (Apple Speech, voice.ts).
  bb.experimental_aiServices.register({
    id: VOICE_SERVICE_ID,
    displayName: VOICE_DISPLAY_NAME,
    transcribe: async (audio, { hint }) => {
      const hostId = (await bb.sdk.system.config()).primaryHostId ?? null;
      if (hostId === null) throw new Error("no host is connected");
      const result = await host.call(
        "ai.voice.transcribe",
        {
          serviceId: VOICE_SERVICE_ID,
          model: VOICE_MODEL,
          audioBase64: Buffer.from(await audio.arrayBuffer()).toString("base64"),
          mimeType: audio.type || "audio/webm",
          filename: audio.name || "recording.webm",
          prompt: hint,
          timeoutMs: VOICE_TIMEOUT_MS,
        },
        { hostId, timeoutMs: VOICE_TIMEOUT_MS },
      );
      if (!result.ok) throw new Error(result.message);
      return result.text;
    },
  });

  const publish = () => bb.realtime.publish(DOSSIER_CHANNEL, { at: Date.now() });
  const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

  // The owner's local config (localconfig.ts): the profiles of their own
  // projects and their Chrome account, from a file on this machine. Read at
  // start and again on every liveness beat. A failed host call keeps what was
  // read last; a file that is wrong empties the config and is said out loud
  // (the board's red line, and configRefusal below), never a quiet default.
  let localConfig: LocalConfigState = INITIAL_LOCAL_CONFIG;
  /** False until the first read has been tried: the board says nothing before it. */
  let localConfigTried = false;
  let localConfigWarned: string | null = null;
  const profileOf = (project: { name: string; gitRemoteUrl?: string | null }) => profileFor(project, localConfig.config.profiles);
  /** Why build, open_pr and ready_for_review refuse for this profile now, or null. */
  const configRefusal = (profile: ProjectProfile) => configBlocks(localConfig.problem, profile.key);
  /** Git's user.name as of the last load that had it: the wizard's "the name git gives". */
  let gitName: string | null = null;
  /**
   * Read the file. With `quietBeforeReady`, a host that is not callable yet
   * (the plugin is still registering) changes nothing, logs nothing and
   * returns false: the caller tries again.
   */
  async function loadLocalConfig(quietBeforeReady = false): Promise<boolean> {
    let answer: { text: string | null; gitUserName?: string | null } | null = null;
    let failure: string | null = null;
    try {
      const hostId = (await bb.sdk.system.config()).primaryHostId ?? null;
      if (hostId === null) failure = "no host is connected";
      else answer = await host.call("localConfig", {}, { hostId, timeoutMs: 15_000 });
    } catch (error) {
      failure = describeError(error);
    }
    if (quietBeforeReady && failure !== null && failure.includes("factory registration")) return false;
    if (answer !== null && answer.gitUserName !== undefined) gitName = answer.gitUserName;
    localConfig = nextLocalConfig(localConfig, answer);
    localConfigTried = true;
    // The owner's first name (owner.ts), only from a host that answered: a
    // failed call keeps the name in force, and so does a host still running
    // the code from before it returned git's name.
    if (answer !== null && (answer.gitUserName !== undefined || localConfig.config.ownerName !== null)) {
      const name = ownerFirstName(localConfig.config.ownerName, answer.gitUserName);
      setOwner(name);
      if (store.getMeta(OWNER_NAME_KEY) !== name) store.setMeta(OWNER_NAME_KEY, name);
    }
    const said = failure !== null ? `reading it failed (${failure}); ${localConfig.read ? "keeping the last one read" : localConfig.problem}` : localConfig.problem;
    if (said !== null && said !== localConfigWarned) bb.log.warn(`local config: ${said}`);
    localConfigWarned = said;
    return true;
  }
  // Not during registration: host calls fail there ("unavailable during
  // factory registration"), and a 0 ms timer still fires inside it. bb has no
  // ready signal, so the first host call waits the second the memory guard's
  // first tick waits (which has not logged that since), and an answer that
  // still says "registering" is tried again, quietly, a few times. The
  // liveness beat reads the file again after that.
  let firstLocalConfig: ReturnType<typeof setTimeout> | null = null;
  const firstLoad = (triesLeft: number) => {
    firstLocalConfig = setTimeout(() => {
      void loadLocalConfig(triesLeft > 0).then((ready) => {
        if (!ready) firstLoad(triesLeft - 1);
      });
    }, FIRST_HOST_CALL_MS);
  };
  firstLoad(5);
  bb.onDispose(() => {
    if (firstLocalConfig !== null) clearTimeout(firstLocalConfig);
  });

  /** First run: the wizard opens by itself (setupwizard.ts needsSetup). Never before the file was read, or over a file with a problem. */
  const setupNeeded = (projects: readonly BbProject[]) =>
    needsSetup({
      projectsDir: localConfig.config.projectsDir,
      projectCount: projects.filter((project) => project.kind !== "personal").length,
      configReady: localConfig.read && localConfig.problem === null,
    });

  // What the liveness check knows that the host does not (liveness.ts): turns
  // held by the memory guard or told to wait for the browser, and threads the
  // memory guard stopped or killed a process of. In memory: a reload forgets
  // them, and the next check sees only the host's truth.
  const holds = new Map<string, Hold>();
  const kills = new Map<string, Kill>();

  // ---------------------------------------------------------------- projects
  type BbProject = Awaited<ReturnType<typeof bb.sdk.projects.list>>[number];

  /** Names for configure(), which is synchronous and cannot ask the SDK. */
  const projectNames = new Map<string, string>();

  async function allProjects(): Promise<BbProject[]> {
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    for (const project of projects) projectNames.set(project.id, project.name);
    return projects;
  }

  function sourceOf(project: BbProject) {
    const source = project.sources.find((candidate) => candidate.isDefault) ?? project.sources[0];
    return source !== undefined && source.type === "local_path" ? source : null;
  }

  async function projectById(projectId: string): Promise<BbProject> {
    const project = (await allProjects()).find((candidate) => candidate.id === projectId);
    if (project === undefined) throw new Error(`No project ${projectId}.`);
    return project;
  }

  /** A project named by id or (case-insensitive) name; the calling chat's own when omitted. */
  async function resolveProject(arg: string | undefined, chatProjectId: string): Promise<BbProject> {
    const projects = (await allProjects()).filter((project) => project.kind !== "personal");
    const wanted = arg?.trim() ?? "";
    if (wanted === "") {
      const picked = projects.find((project) => project.id === chatProjectId);
      if (picked === undefined) {
        throw new Error(`This chat's project is gone. Name the project. Projects: ${projects.map((p) => p.name).join(", ")}.`);
      }
      return picked;
    }
    const match =
      projects.find((project) => project.id === wanted) ??
      projects.find((project) => project.name.toLowerCase() === wanted.toLowerCase());
    if (match === undefined) {
      throw new Error(`No project ${JSON.stringify(wanted)}. Projects: ${projects.map((p) => p.name).join(", ")}.`);
    }
    return match;
  }

  // ------------------------------------------------------------------ repos
  const repoCache = new Map<string, { at: number; repo: RepoSnapshot | null; error: string | null }>();
  let reposInflight: Promise<Repos> | null = null;

  async function readRepos(force: boolean): Promise<Repos> {
    return (await snapshotRepos(force)).repos;
  }

  /** Read every repo and reconcile tasks against it; `checks` are the branch-fate lookups it started. */
  async function snapshotRepos(force: boolean): Promise<{ repos: Repos; checks: Promise<void>[] }> {
    const projects = (await allProjects()).filter((project) => project.kind !== "personal");
    const hidden = new Set(store.projectPrefs().filter((p) => p.hidden).map((p) => p.projectId));
    const repos = await Promise.all(
      projects
        .filter((project) => !hidden.has(project.id))
        .map(async (project) => {
          const cached = repoCache.get(project.id);
          if (!force && cached !== undefined && Date.now() - cached.at < REPO_CACHE_MS) {
            return { projectId: project.id, repo: cached.repo, error: cached.error };
          }
          const source = sourceOf(project);
          let repo: RepoSnapshot | null = null;
          let error: string | null = null;
          if (source === null) {
            error = `${project.name} has no local checkout.`;
          } else {
            try {
              repo = await host.call(
                "repoSnapshot",
                { repoPath: source.path, previewMarker: profileOf(project).markers.preview },
                { hostId: source.hostId, timeoutMs: 60_000 },
              );
            } catch (cause) {
              error = describeError(cause);
              bb.log.warn(`repo snapshot for ${project.name} failed: ${error}`);
            }
          }
          repoCache.set(project.id, { at: Date.now(), repo, error });
          return { projectId: project.id, repo, error };
        }),
    );
    const checks = reconcile(repos);
    void checkCi(repos);
    return { repos: { fetchedAt: Date.now(), repos }, checks };
  }

  /** Branch-fate lookups in flight, one per task. */
  const fateInflight = new Map<string, Promise<void>>();

  /**
   * Close tasks whose work is finished (release.ts says when): the PR merged
   * or closed, or the branch is gone with its commits on the default branch.
   * Remembers each branch tip with work on it, so a branch deleted after a
   * merge through another task's PR can still be traced. Returns the
   * branch-fate lookups it started, for callers that want to wait on them.
   */
  function reconcile(repos: Repos["repos"]): Promise<void>[] {
    const checks: Promise<void>[] = [];
    for (const open of store.tasks({ includeClosed: false })) {
      const repo = repos.find((entry) => entry.projectId === open.projectId)?.repo;
      if (repo == null) continue;
      let task = open;
      const sha = headShaUpdate(task, repo.branches.find((b) => b.name === task.branch));
      if (sha !== null) task = store.updateTask(task.id, { headSha: sha });
      const found = prForTask(task, repo.pullRequests);
      const pr = found !== null && prCounts(task, found) ? found : null;
      const finished = pr !== null && pr.state !== "open";
      if (
        !finished &&
        task.branch !== null &&
        task.headSha !== null &&
        !repo.branches.some((b) => b.name === task.branch)
      ) {
        let check = fateInflight.get(task.id);
        if (check === undefined) {
          check = checkBranchFate(task, pr, repo.defaultBranch).finally(() => fateInflight.delete(task.id));
          fateInflight.set(task.id, check);
        }
        checks.push(check);
        continue;
      }
      closeIfStale(task.id, pr, null);
      voidReviewIfStale(task.id, pr);
    }
    return checks;
  }

  /**
   * A review ticket holds only while the PR is what ready_for_review proved
   * (review.ts). Otherwise it is closed, the reason goes in the verdict, and
   * the task hears it once: closing the ticket is what makes it once.
   */
  function voidReviewIfStale(taskId: string, pr: PullRequest | null) {
    const task = store.task(taskId);
    if (task === null || task.closedAt !== null) return;
    if (store.openTicket(task.id, "review") === null) return;
    void projectById(task.projectId)
      .then((project) => {
        const current = store.task(taskId);
        if (current === null || current.closedAt !== null) return;
        // A local config that is not in use says nothing about this project's label.
        if (configRefusal(profileOf(project)) !== null) return;
        const reason = reviewStale({ task: current, pr, aiTestsLabel: reviewLabel(profileOf(project)) });
        if (reason === null) return;
        voidReview(current, reason, pr?.headRefOid ?? null);
      })
      .catch((error: unknown) => bb.log.warn(`review check for ${taskId} failed: ${describeError(error)}`));
  }

  function voidReview(task: Task, reason: string, headSha: string | null) {
    if (store.closeReview(task.id) === null) return;
    changed(
      store.updateTask(task.id, {
        stage: task.stage === "you" ? "pr" : task.stage,
        verdict: { kind: "stale", reasons: [`Review hand-off void: ${reason}.`], headSha, at: Date.now() },
      }),
    );
    if (task.threadId !== null) {
      void tellThread(task.threadId, reviewVoidedMessage(task, reason)).catch((error: unknown) =>
        bb.log.warn(`could not tell ${task.id} its review is void: ${describeError(error)}`),
      );
    }
  }

  /** Tasks mid-land(): their branch may already be gone and on main. */
  const landing = new Set<string>();

  async function checkBranchFate(task: Task, pr: PullRequest | null, base: string) {
    try {
      const project = await projectById(task.projectId);
      const source = sourceOf(project);
      if (source === null || task.branch === null) return;
      const fate: BranchFate = await host.call(
        "branchFate",
        { repoPath: source.path, branch: task.branch, headSha: task.headSha, base },
        { hostId: source.hostId, timeoutMs: 60_000 },
      );
      closeIfStale(task.id, pr, fate);
    } catch (error) {
      bb.log.warn(`branch check for ${task.id} failed: ${describeError(error)}`);
    }
  }

  function closeIfStale(taskId: string, pr: PullRequest | null, fate: BranchFate | null) {
    // Re-read: a lookup may have finished after the task moved on.
    const task = store.task(taskId);
    if (task === null) return;
    // A land's branch is gone and on main too: its reload closes it (reload.ts).
    if (landing.has(task.id) || store.getMeta(reloadKey(task.id)) !== null) return;
    const reason = staleReason({ task, pr, fate });
    if (reason === null) return;
    const hold = closeHoldFor(task.id);
    if (hold !== null) {
      if (holdClose(task, hold, reason)) void tellHeld(task, hold, reason);
      return;
    }
    // Held before: the answer went back to its thread, so close once it is done with it.
    if (store.getMeta(closeHeldKey(task.id)) !== null) {
      void closeAfterHold(task.id, pr, fate);
      return;
    }
    closeStale(task.id, reason);
  }

  function closeStale(taskId: string, reason: string) {
    closeTask(taskId, reason, staleFate(reason));
    store.setMeta(closeHeldKey(taskId), null);
    void cleanupWorktree(taskId);
    publish();
  }

  async function closeAfterHold(taskId: string, pr: PullRequest | null, fate: BranchFate | null) {
    try {
      const busy = await busyThreads();
      const task = store.task(taskId);
      if (task === null || taskThreadIds(task).some((id) => busy.has(id))) return;
      if (landing.has(task.id) || store.getMeta(reloadKey(task.id)) !== null || closeHoldFor(task.id) !== null) return;
      const reason = staleReason({ task, pr, fate });
      if (reason !== null) closeStale(task.id, reason);
    } catch (error) {
      bb.log.warn(`closing ${taskId} after its held close failed: ${describeError(error)}`);
    }
  }

  // ------------------------------------------------------------ steps left
  // steps.ts: a task that landed a step with `more` stays open. Its record is
  // one meta row, read only for open tasks and dropped when the task closes.

  /** The task's steps record; an unreadable row is logged and dropped. */
  function stepsOf(taskId: string): StepsRecord | null {
    const raw = store.getMeta(stepsKey(taskId));
    if (raw === null) return null;
    const record = parseSteps(raw);
    if (record === null) {
      bb.log.warn(`dropping unreadable steps record of ${taskId}`);
      store.setMeta(stepsKey(taskId), null);
    }
    return record;
  }

  /** Every close goes through here: a closed task leaves no steps row, and its routed agents' outcomes are kept. */
  function closeTask(taskId: string, note: string, fate: TaskFate) {
    store.closeTask(taskId, note);
    store.setMeta(stepsKey(taskId), null);
    noteOutcomes(taskId, fate);
  }

  /** How the task closed, on its routes, and one log line per routed agent next to its route. Bookkeeping: never fails a close. */
  function noteOutcomes(taskId: string, fate: TaskFate) {
    try {
      store.setRouteTaskFate(taskId, fate);
      const routes = store.taskModelRoutes(taskId);
      if (routes.length === 0) return;
      const outcomes = routeOutcomes(
        routes,
        store.children().filter((child) => child.taskId === taskId),
        store.tickets({ status: "all" }).filter((ticket) => ticket.taskId === taskId),
      );
      for (const route of routes) {
        const outcome = outcomes.get(route.threadId);
        if (outcome !== undefined) bb.log.info(`${taskId}: outcome: ${outcomeLogLine(route, outcome)}`);
      }
    } catch (error) {
      bb.log.warn(`${taskId}: recording route outcomes failed: ${describeError(error)}`);
    }
  }

  /**
   * A step landed and is live, with steps left: the claims and build slot go
   * back and the task is ready to build again, not closed. land wrote the
   * steps record already.
   */
  function keepOpenAfterStep(task: Task, sha: string, left: readonly string[]) {
    store.transaction(() => {
      store.releaseTask(task.id, { reason: stepReleaseReason(sha, left.length), by: "auto", close: false });
      // No branch: the landed one is on main, and the next build cuts its own.
      store.updateTask(task.id, { stage: "research", buildState: "none", branch: null });
    });
    store.setMeta(closeHeldKey(task.id), null);
    bb.log.info(`${task.id} kept open: ${stepReleaseReason(sha, left.length)}`);
    changed(store.task(task.id) ?? task);
  }

  // ------------------------------------------------------------ held closes
  // tickets.ts: an open questions or report ticket holds every automatic close.
  // The task gives its claims back and stays open; it closes once the owner
  // answers (or marks the report reviewed) or the ticket is withdrawn
  // (landed.ts, closeIfStale), never taking it along.

  /** The open questions or report ticket holding an automatic close of this task, or null. */
  function closeHoldFor(taskId: string) {
    return closeHold(store.tickets({ status: "open" }).filter((ticket) => ticket.taskId === taskId));
  }

  /**
   * Hold an automatic close: the claims and build slot go back (only while it
   * still has claims, so polling adds no release rows). True the first time
   * this ticket holds the task, so the caller tells its thread once.
   */
  function holdClose(task: Task, hold: CloseHold, reason: string): boolean {
    if (store.claimsFor(task.id).length > 0) {
      store.releaseTask(task.id, { reason: `${reason} Kept open: ${hold.ticketId} ${holdWhat(hold)}.`, by: "auto", close: false });
      changed(store.task(task.id) ?? task);
    }
    if (store.getMeta(closeHeldKey(task.id)) === hold.ticketId) return false;
    store.setMeta(closeHeldKey(task.id), hold.ticketId);
    bb.log.info(`${task.id} kept open (${reason}): ${hold.ticketId} ${holdWhat(hold)}`);
    return true;
  }

  async function tellHeld(task: Task, hold: CloseHold, what: string) {
    if (task.threadId === null) return;
    try {
      await tellThread(task.threadId, heldCloseMessage(task.id, hold, what));
    } catch (error) {
      bb.log.warn(`telling ${task.id} its close is held failed: ${describeError(error)}`);
    }
  }

  // ---------------------------------------------------------- landed on main
  // land() closes its own task once its reload is live. landed.ts catches work
  // that reached main any other way: the commit carries the task's trailer or
  // is its own build (branch tip, verifiedSha), git says it is on main, and
  // nothing of the task is still open. A sha its report mentions never counts.
  const LANDED_CHECK_MS = 60_000;
  const landedQueue = new Map<string, Promise<void>>();
  const landedAt = new Map<string, number>();

  function checkLanded(projectId: string, force: boolean): Promise<void> {
    if (!force && Date.now() - (landedAt.get(projectId) ?? 0) < LANDED_CHECK_MS) return Promise.resolve();
    landedAt.set(projectId, Date.now());
    const next = (landedQueue.get(projectId) ?? Promise.resolve())
      .then(() => closeLanded(projectId))
      .then(() => closeDone(projectId));
    landedQueue.set(projectId, next);
    void next.finally(() => {
      if (landedQueue.get(projectId) === next) landedQueue.delete(projectId);
    });
    return next;
  }

  async function closeLanded(projectId: string) {
    try {
      const candidates = store.tasks({ includeClosed: false }).filter((task) => task.projectId === projectId && landCandidate(task));
      if (candidates.length === 0) return;
      const source = sourceOf(await projectById(projectId));
      if (source === null) return;
      const branches = [...new Set(candidates.flatMap((task) => (task.branch === null ? [] : [task.branch])))];
      const { base, commits, tips } = await host.call(
        "mainCommits",
        { repoPath: source.path, since: Math.min(...candidates.map((task) => task.createdAt)), branches },
        { hostId: source.hostId, timeoutMs: 60_000 },
      );
      const tipOf = new Map(tips.map((tip) => [tip.branch, tip.sha]));
      const running = new Set((await bb.sdk.threads.listRunning()).map((thread) => thread.id));
      const children = store.children();
      const tickets = store.tickets({ status: "open" });
      for (const candidate of candidates) {
        // Re-read: the task may have moved on while git answered.
        const task = store.task(candidate.id);
        if (task === null) continue;
        const threadIds = [task.threadId, ...children.filter((child) => child.taskId === task.id).map((child) => child.threadId)];
        // The task's own build only; its report is never evidence of a land.
        const tip = task.branch === null ? undefined : tipOf.get(task.branch);
        const ownShas = [tip, task.verifiedSha].filter((sha): sha is string => typeof sha === "string" && sha !== "");
        const note = landedClose({
          task,
          ownShas,
          commits,
          base,
          openTickets: tickets.filter((ticket) => ticket.taskId === task.id).length,
          running: threadIds.some((id) => id !== null && running.has(id)),
          // Mid-land counts too: its build runs before the pending reload is recorded.
          reloadPending: landing.has(task.id) || store.getMeta(reloadKey(task.id)) !== null,
          stepsLeft: stepsOf(task.id)?.left.length ?? 0,
        });
        if (note === null) continue;
        // Read before closing, which drops it. The whole last report: task.note
        // keeps only its last line. It only feeds the follow-up below.
        const report = store.getMeta(reportKey(task.id)) ?? task.note;
        closeTask(task.id, note, "landed");
        store.setMeta(closeHeldKey(task.id), null);
        bb.log.info(`${task.id} closed: ${note}`);
        void cleanupWorktree(task.id);
        publish();
        // Landed still closes; work its report names as left goes to Patches.
        const item = followUpItem(report);
        if (item !== null) await tellFollowUp(task, item, landedFollowUpMessage(task, item));
      }
    } catch (error) {
      bb.log.warn(`landed check for ${projectId} failed: ${describeError(error)}`);
    }
  }

  // ------------------------------------------------------------ done, idle
  // done.ts: a research task with no commit or PR closes on its own "done",
  // once the dossier shows nothing of it open and its thread sat idle 30 min.
  const doneKept = new Map<string, string>();

  /** Threads mid-turn or with a message queued. */
  async function busyThreads(): Promise<Set<string>> {
    const busy = new Set((await bb.sdk.threads.listRunning()).map((thread) => thread.id));
    for (const row of await bb.sdk.threads.queue.list()) busy.add(row.threadId);
    return busy;
  }

  /** A thread's last activity, for task threads idle since before task_idle_at was recorded. */
  async function lastActivity(threadId: string): Promise<number | null> {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      const [event] = await bb.sdk.threads.events.list({ threadId, order: "desc", limit: "1" });
      return event?.createdAt ?? thread.updatedAt;
    } catch (error) {
      bb.log.warn(`done check: reading ${threadId}'s last activity failed: ${describeError(error)}`);
      return null;
    }
  }

  /** Tell the task's Patches chat about work its report names as left, once per item. */
  async function tellFollowUp(task: Task, item: string, message: string) {
    const toldKey = followUpToldKey(task.id);
    if (!followUpDue({ item, told: store.getMeta(toldKey) })) return;
    try {
      // Its own project's chat, started with this message when it has none yet.
      const chat = await ensureChat(await projectById(task.projectId), message);
      if (!chat.started) await tellThread(chat.threadId, message);
      store.setMeta(toldKey, item);
      bb.log.info(`follow-up of ${task.id} told to Patches (${chat.threadId}): ${item}`);
    } catch (error) {
      bb.log.warn(`telling Patches the follow-up of ${task.id} failed: ${describeError(error)}`);
    }
  }

  async function closeDone(projectId: string) {
    try {
      const candidates = store
        .tasks({ includeClosed: false })
        .filter((task) => task.projectId === projectId && task.stage === "research");
      if (candidates.length === 0) return;
      const busy = await busyThreads();
      const children = store.children();
      const tickets = store.tickets({ status: "open" });
      for (const candidate of candidates) {
        const task = store.task(candidate.id);
        if (task === null) continue;
        const threadIds = [task.threadId, ...children.filter((child) => child.taskId === task.id).map((child) => child.threadId)];
        const args: DoneArgs = {
          task,
          report: store.getMeta(reportKey(task.id)) ?? task.note,
          openTickets: tickets.filter((ticket) => ticket.taskId === task.id).length,
          running: threadIds.some((id) => id !== null && busy.has(id)),
          claims: store.claimsFor(task.id).length,
          idleSince: metaTime(idleKey(task.id)),
          now: Date.now(),
          stepsLeft: stepsOf(task.id)?.left.length ?? 0,
        };
        // A land waiting on its reload is open work (landed.ts openWork);
        // done.ts does not see the meta row, so it is checked here.
        let kept = landing.has(task.id) || store.getMeta(reloadKey(task.id)) !== null ? "a reload is pending" : doneBlocker(args);
        // Idle since before this was recorded: bb's last activity, read once.
        if (kept === "idle time unknown" && task.threadId !== null) {
          const since = await lastActivity(task.threadId);
          if (since !== null) {
            store.setMeta(idleKey(task.id), String(since));
            kept = doneBlocker({ ...args, idleSince: since });
          }
        }
        if (kept !== null) {
          if (doneKept.get(task.id) !== kept) bb.log.info(`done check: kept ${task.id}: ${kept}`);
          doneKept.set(task.id, kept);
          const item = followUpOfBlocker(kept);
          if (item !== null) await tellFollowUp(task, item, followUpMessage(task, item));
          continue;
        }
        doneKept.delete(task.id);
        const note = doneNote(args.report);
        closeTask(task.id, note, "done");
        store.setMeta(idleKey(task.id), null);
        bb.log.info(`${task.id} closed: ${note}`);
        void cleanupWorktree(task.id);
        publish();
      }
    } catch (error) {
      bb.log.warn(`done check for ${projectId} failed: ${describeError(error)}`);
    }
  }

  // ---------------------------------------------------- archive closed chats
  let archivingClosed = false;

  /** A task's own thread and its research and build threads. */
  function taskThreadIds(task: Task): string[] {
    const ids = store.children().filter((child) => child.taskId === task.id).map((child) => child.threadId);
    return task.threadId === null ? ids : [task.threadId, ...ids];
  }

  /** Archive the threads that are not working; true when none is left. Gone or archived ones are quietly done. */
  async function archiveThreads(threadIds: readonly string[], busy: ReadonlySet<string>): Promise<boolean> {
    let left = false;
    for (const threadId of threadIds) {
      if (busy.has(threadId)) {
        left = true;
        continue;
      }
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
        await bb.sdk.threads.archive({ threadId });
      } catch (error) {
        if (notFound(error)) continue;
        bb.log.warn(`archiving ${threadId} failed: ${describeError(error)}`);
        left = true;
      }
    }
    return left === false;
  }

  /** Closed tasks' chats, archived 10 min after the close when the setting is on; a working one waits. */
  async function archiveClosedChats() {
    const enabled = archiveEnabled(store.getMeta(ARCHIVE_CLOSED_KEY));
    if (!enabled || archivingClosed) return;
    archivingClosed = true;
    try {
      const now = Date.now();
      const due = store.tasks({ includeClosed: true }).filter((task) =>
        archiveDue({ closedAt: task.closedAt, now, enabled, alreadyArchived: store.getMeta(threadsArchivedKey(task.id)) !== null }),
      );
      if (due.length === 0) return;
      const busy = await busyThreads();
      for (const task of due) {
        if (await archiveThreads(taskThreadIds(task), busy)) {
          store.setMeta(threadsArchivedKey(task.id), String(Date.now()));
          bb.log.info(`${task.id}'s chats archived (closed ${Math.round((now - (task.closedAt ?? now)) / 60_000)} min ago)`);
        }
      }
    } catch (error) {
      bb.log.warn(`archiving closed tasks' chats failed: ${describeError(error)}`);
    } finally {
      archivingClosed = false;
    }
  }

  // ----------------------------------------------------------- Patches chats
  function chatThread(projectId: string): string | null {
    return store.getMeta(chatKey(projectId));
  }

  function registerChat(projectId: string, threadId: string) {
    store.setMeta(chatKey(projectId), threadId);
    store.setMeta(chatOfThreadKey(threadId), projectId);
  }

  function clearChat(projectId: string) {
    const threadId = chatThread(projectId);
    store.setMeta(chatKey(projectId), null);
    if (threadId !== null) store.setMeta(chatOfThreadKey(threadId), null);
  }

  /**
   * The Patches chat a thread is, or null. The retired Any-project chat is
   * not one: its reverse-index mark ("*") names no project's chat.
   */
  function chatOf(threadId: string): { projectId: string } | null {
    const projectId = store.getMeta(chatOfThreadKey(threadId));
    if (projectId === null) return null;
    return chatThread(projectId) === threadId ? { projectId } : null;
  }

  const startingChats = new Map<string, Promise<string>>();

  /**
   * A project's own Patches chat, started when it has none yet: in its main
   * checkout, as the owner's "Start" in the app does, with `first` as its opening
   * message (a thread cannot start without one). Never another project's chat.
   */
  async function ensureChat(project: BbProject, first: string): Promise<{ threadId: string; started: boolean }> {
    const existing = chatThread(project.id);
    if (existing !== null) return { threadId: existing, started: false };
    const pending = startingChats.get(project.id);
    if (pending !== undefined) return { threadId: await pending, started: false };
    const starting = (async () => {
      const thread = await bb.sdk.threads.spawn({
        projectId: project.id,
        environment: await checkoutEnvironment(project),
        providerId: PATCHES_PROVIDER,
        title: `${PATCHES} · ${project.name}`,
        input: [{ type: "text", text: first, mentions: [] }],
        pluginMetadata: { role: "orchestrator", projectId: project.id },
      });
      registerChat(project.id, thread.id);
      bb.log.info(`started ${project.name}'s Patches chat (${thread.id})`);
      publish();
      return thread.id;
    })();
    startingChats.set(project.id, starting);
    try {
      return { threadId: await starting, started: true };
    } finally {
      startingChats.delete(project.id);
    }
  }

  /**
   * The owner opened a project: start its Patches chat if it has none (shouldStartChat),
   * without holding up the rpc on the spawn.
   */
  function startChatOnOpen(projectId: string) {
    void (async () => {
      const project = await projectById(projectId);
      const start = shouldStartChat({
        hasChat: chatThread(project.id) !== null,
        hasCheckout: sourceOf(project) !== null,
        kind: project.kind === "personal" ? "personal" : "standard",
      });
      if (!start) return;
      await ensureChat(
        project,
        `[The Orchestrator] ${Owner()} opened ${project.name}. Read its CLAUDE.md and task_status, then tell them in two lines where ${project.name} stands.`,
      );
    })().catch((error) => bb.log.warn(`starting the Patches chat for ${projectId} failed: ${describeError(error)}`));
  }

  const metaTime = (key: string) => {
    const value = store.getMeta(key);
    return value === null ? null : Number(value);
  };

  function markSeen(projectId: string | null) {
    if (projectId === null) return;
    store.setMeta(seenAtKey(projectId), String(Date.now()));
  }

  /** Every registered project's local path. */
  const registeredPaths = (projects: readonly BbProject[]) =>
    projects.flatMap((project) => project.sources.flatMap((source) => (source.type === "local_path" ? [source.path] : [])));

  /**
   * Add existing folder…: register the folder as a project (or un-hide the
   * project it already is). `open` puts the board on it and starts its
   * Patches chat, as the owner opening it does.
   */
  async function addExistingProject(hostId: string, path: string, name: string, open: boolean): Promise<string> {
    const existing = (await allProjects()).find((project) =>
      project.sources.some((source) => source.type === "local_path" && source.path === path),
    );
    const project =
      existing ?? (await bb.sdk.projects.create({ name, source: { type: "local_path", hostId, path } }));
    if (existing !== undefined) store.setProjectPrefs(existing.id, { hidden: false });
    if (open) {
      markSeen(store.getMeta(FOCUS_KEY));
      markSeen(project.id);
      store.setMeta(FOCUS_KEY, project.id);
    }
    publish();
    if (open) startChatOnOpen(project.id);
    return project.id;
  }

  // ---------------------------------------------------------------- threads
  async function syncTaskMetadata(task: Task) {
    if (task.threadId === null) return;
    try {
      await bb.sdk.threads.updatePluginMetadata({
        threadId: task.threadId,
        pluginId: bb.pluginId,
        set: {
          role: "task",
          taskId: task.id,
          stage: task.stage,
          branch: task.branch,
          worktreePath: task.worktreePath,
          prNumber: task.prNumber,
          claims: store.claimsFor(task.id),
        },
      });
    } catch (error) {
      bb.log.warn(`metadata sync for ${task.id} failed: ${describeError(error)}`);
    }
  }

  function changed(task: Task) {
    publish();
    void syncTaskMetadata(task);
  }

  /**
   * The project's main checkout, named explicitly. `project-default` can
   * resolve to a bb-managed worktree, and tasks and research must read the
   * real checkout without creating anything. An existing checkout environment
   * is reused: a provider spawn makes bb provision, which binds the shared
   * environment to the new thread, and if bb restarts before the thread
   * attaches that lock sticks and every other thread there gets HTTP 409
   * "Cannot checkout branch while another thread is using this workspace".
   */
  async function checkoutEnvironment(project: BbProject) {
    const source = sourceOf(project);
    if (source === null) throw new Error(`${project.name} has no local checkout.`);
    const provider = {
      type: "provider" as const,
      environmentProviderId: CHECKOUT_PROVIDER,
      inputs: { path: source.path },
      machine: { type: "existing" as const, hostId: source.hostId },
    };
    try {
      const envs = await bb.sdk.environments.list({ projectId: project.id, hostId: source.hostId });
      const environmentId = pickCheckoutEnvironment(envs, {
        projectId: project.id,
        hostId: source.hostId,
        path: source.path,
      });
      return environmentId === null ? provider : { type: "reuse" as const, environmentId };
    } catch (error) {
      bb.log.warn(`listing ${project.name}'s environments failed, provisioning its checkout: ${describeError(error)}`);
      return provider;
    }
  }

  /**
   * Children run on their requester's provider: a project's remembered
   * default can be one that is not signed in, which fails the child at once.
   */
  async function providerOf(threadId: string | null): Promise<{ providerId?: string }> {
    if (threadId === null) return {};
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      return { providerId: thread.providerId };
    } catch {
      return {};
    }
  }

  async function tellThread(threadId: string, text: string) {
    await bb.sdk.threads.send({
      threadId,
      mode: "queue-if-active",
      input: [{ type: "text", text, mentions: [] }],
    });
  }

  // ------------------------------------------------------------ worktrees
  async function cleanupWorktree(taskId: string) {
    const task = store.task(taskId);
    if (task === null || task.worktreePath === null) return;
    try {
      for (const child of store.children().filter((c) => c.taskId === taskId && c.kind === "build")) {
        try {
          await bb.sdk.threads.archive({ threadId: child.threadId });
          await bb.sdk.threads.stop({ threadId: child.threadId });
        } catch {
          // Already archived or gone: the worktree check below is what matters.
        }
      }
      const project = await projectById(task.projectId);
      const source = sourceOf(project);
      if (source === null) return;
      const result = await host.call(
        "removeWorktree",
        { repoPath: source.path, worktreePath: task.worktreePath, baseRef: task.baseRef ?? "origin/main" },
        { hostId: source.hostId, timeoutMs: 60_000 },
      );
      changed(store.updateTask(taskId, recordAfterCleanup(task.worktreePath, result)));
    } catch (error) {
      changed(store.updateTask(taskId, { worktreeNote: `Cleanup failed: ${describeError(error)}` }));
    }
  }

  /**
   * Retry cleanup for closed tasks whose worktree outlived them (an aborted
   * removal, a host that was down), and remove orphans: folders under
   * <repo>/.claude/worktrees no task records. worktrees.ts sweepTargets
   * decides what to try; the host's removeWorktree and removeOrphanWorktree
   * still refuse anything that holds work found nowhere else. Every kept
   * orphan is logged, once per sweep.
   */
  let sweeping = false;
  async function sweepWorktrees() {
    if (sweeping) return;
    sweeping = true;
    try {
      const projects = (await allProjects()).filter((project) => project.kind !== "personal");
      const tasks = store.tasks({ includeClosed: true });
      const cleaned = new Set<string>();
      for (const project of projects) {
        const source = sourceOf(project);
        if (source === null) continue;
        try {
          const dirs = await host.call("listWorktreeDirs", { repoPath: source.path }, { hostId: source.hostId, timeoutMs: 60_000 });
          // Another project's task recording a worktree in this repo still owns it.
          const targets = sweepTargets({
            tasks: tasks.filter(
              (task) =>
                task.projectId === project.id ||
                (task.worktreePath !== null && isRepoWorktreePath(source.path, task.worktreePath)),
            ),
            dirSlugs: dirs.map((dir) => dir.slug),
            repoPath: source.path,
          });
          for (const id of targets.tasks) {
            if (cleaned.has(id)) continue;
            cleaned.add(id);
            await cleanupWorktree(id);
          }
          for (const worktreePath of targets.orphans) {
            try {
              const result = await host.call(
                "removeOrphanWorktree",
                { repoPath: source.path, worktreePath },
                { hostId: source.hostId, timeoutMs: 60_000 },
              );
              if (result.removed) bb.log.info(`worktree sweep: removed ${worktreePath}`);
              else if (result.reason !== null) bb.log.info(`worktree sweep: kept ${worktreePath}: ${result.reason}`);
            } catch (error) {
              bb.log.warn(`worktree sweep: kept ${worktreePath}: could not check it: ${describeError(error)}`);
            }
          }
        } catch (error) {
          bb.log.warn(`worktree sweep of ${project.name} failed: ${describeError(error)}`);
        }
      }
    } catch (error) {
      bb.log.warn(`worktree sweep failed: ${describeError(error)}`);
    } finally {
      sweeping = false;
    }
  }
  const firstSweep = setTimeout(() => void sweepWorktrees(), 10_000);
  const sweepTimer = setInterval(() => void sweepWorktrees(), 60 * 60_000);
  bb.onDispose(() => {
    clearTimeout(firstSweep);
    clearInterval(sweepTimer);
  });

  // ------------------------------------------------------------ callers
  type Caller = { kind: "orchestrator"; projectId: string } | { kind: "task"; task: Task };

  function caller(threadId: string): Caller | null {
    const chat = chatOf(threadId);
    if (chat !== null) return { kind: "orchestrator", projectId: chat.projectId };
    const task = store.taskByThread(threadId);
    if (task !== null && task.closedAt === null) return { kind: "task", task };
    return null;
  }

  /** The task a tool acts on: any of its project's for Patches, only its own for a task thread. */
  function taskFor(threadId: string, taskArg: string | undefined): Task {
    const who = caller(threadId);
    if (who === null) throw new Error("Only Patches and task threads can use this tool.");
    if (who.kind === "task") {
      if (taskArg !== undefined && taskArg !== "" && taskArg !== who.task.id) {
        throw new Error(`You own ${who.task.id}; you cannot act on ${taskArg}.`);
      }
      return who.task;
    }
    if (taskArg === undefined || taskArg === "") throw new Error("Name the task id (task_status lists them).");
    const task = store.task(taskArg);
    if (task === null) throw new Error(`No task ${taskArg}.`);
    const refusal = chatRefusal(who.projectId, task, projectNames.get(task.projectId) ?? task.projectId);
    if (refusal !== null) throw new Error(refusal);
    if (task.closedAt !== null) throw new Error(`${task.id} is closed.`);
    return task;
  }

  const text = (value: string) => value;
  const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

  // ----------------------------------------------------------------- tools
  const taskId = z.string().max(40).optional().describe("Task id. A task thread may omit it (its own task).");

  /**
   * A task row and its thread under `parentThreadId`. A task opened for an
   * existing PR records it before the thread starts, so its build continues
   * that PR's branch.
   */
  async function spawnTask(
    project: BbProject,
    parentThreadId: string,
    title: string,
    brief: string,
    pr: { number: number; url: string } | null,
  ): Promise<{ task: Task; threadId: string }> {
    let task = store.createTask({ projectId: project.id, title, brief });
    void jevWatchTask(task, sourceOf(project)?.hostId ?? null);
    if (pr !== null) task = store.updateTask(task.id, { prNumber: pr.number, prUrl: pr.url });
    const provider = await providerOf(parentThreadId);
    const route = await routeFor({
      role: "task",
      providerId: provider.providerId,
      hostId: sourceOf(project)?.hostId ?? null,
      state: () => routeState({ role: "task", title, brief }),
    });
    const thread = await bb.sdk.threads.spawn({
      projectId: project.id,
      parentThreadId,
      environment: await checkoutEnvironment(project),
      ...provider,
      ...spawnModel("task", route),
      title,
      prompt: taskPrompt(task, project.name),
      pluginMetadata: { role: "task", taskId: task.id },
    });
    noteRoute(thread.id, task, "task", route);
    const saved = store.updateTask(task.id, { threadId: thread.id });
    changed(saved);
    return { task: saved, threadId: thread.id };
  }

  bb.agents.registerTool({
    name: "start_task",
    description:
      `Patches only. Open a task: records its dossier and starts a visible task thread under you, in the project's main checkout. The task plans, researches and builds through its own tools. New work, including when ${owner()} asks what questions you have: start the task first; it asks through ask_sam.`,
    parameters: z.object({
      project: z
        .string()
        .max(100)
        .optional()
        .describe("Omit: always this chat's project. A chat starts tasks only in its own project."),
      title: z.string().min(3).max(120),
      brief: z
        .string()
        .min(10)
        .max(20_000)
        .describe(`Everything the task needs: what ${owner()} asked for, in their words, plus context you know.`),
    }),
    presentation: { label: { pending: "Starting a task", completed: "Started a task" } },
    async execute({ project, title, brief }, ctx) {
      const who = caller(ctx.threadId);
      if (who?.kind !== "orchestrator") return fail("Only Patches starts tasks.");
      try {
        const target = await resolveProject(project, who.projectId);
        if (target.id !== who.projectId) {
          return fail(`${target.name} has its own Patches chat: start ${target.name}'s tasks there.`);
        }
        const profile = profileOf(target);
        const { task, threadId } = await spawnTask(target, ctx.threadId, title, brief, null);
        return text(
          `Started ${task.id} "${title}" in ${target.name} (thread ${threadId}). It plans first; you will hear when it finishes a turn.${profile.build === "flux-prompts" ? ` Flux project: it pastes prompts into Flux itself in ${owners()} Chrome and asks ${owner()} before spending ACUs.` : ""}`,
        );
      } catch (error) {
        return fail(`Could not start the task: ${describeError(error)}`);
      }
    },
  });

  bb.agents.registerTool({
    name: "research",
    description:
      "Spawn a read-only research thread under a task, in the project's main checkout. It answers one question with evidence and reports back to the task.",
    parameters: z.object({ task: taskId, question: z.string().min(10).max(8000) }),
    presentation: { label: { pending: "Starting research", completed: "Started research" } },
    async execute({ task: arg, question }, ctx) {
      try {
        const task = taskFor(ctx.threadId, arg);
        if (task.threadId === null) return fail(`${task.id} has no task thread.`);
        const paused = signInPause(task, "research") ?? usagePause(task, "research");
        if (paused !== null) return fail(paused);
        const label = question.length > 60 ? `${question.slice(0, 59)}…` : question;
        const project = await projectById(task.projectId);
        const provider = await providerOf(task.threadId);
        const route = await routeFor({
          role: "research",
          providerId: provider.providerId,
          hostId: sourceOf(project)?.hostId ?? null,
          state: () => routeState({ role: "research", taskTitle: task.title, question }),
        });
        const thread = await bb.sdk.threads.spawn({
          projectId: task.projectId,
          parentThreadId: task.threadId,
          environment: await checkoutEnvironment(project),
          ...provider,
          ...spawnModel("research", route),
          title: `Research: ${label}`,
          prompt: researchPrompt(question),
          pluginMetadata: { role: "research", taskId: task.id },
        });
        noteRoute(thread.id, task, "research", route);
        store.addChild({ threadId: thread.id, taskId: task.id, kind: "research", label });
        changed(store.updateTask(task.id, {}));
        return text(`Research thread ${thread.id} started for ${task.id}. Its answer comes back to the task thread.`);
      } catch (error) {
        return fail(`Could not start research: ${describeError(error)}`);
      }
    },
  });

  bb.agents.registerTool({
    name: "build",
    description: `Start the build for a task: claims the files it will touch, creates a worktree at <repo>/.claude/worktrees/<slug> on its own branch from the default branch, installs dependencies, then starts a builder thread under the task. Refuses when another task holds an overlapping claim, or when ${BUILD_CAP} builds are already in flight. With claimOnly: true it only replaces the task's claims with these touches (no worktree, no builder), re-checking overlaps: how to widen claims when open_pr, ready_for_review or land refuses files outside them.`,
    parameters: z.object({
      task: taskId,
      touches: z
        .array(z.string().min(1).max(300))
        .min(1)
        .max(100)
        .describe("Every file (src/a.ts) or subtree (src/app/**) the build will create or modify. No other wildcards."),
      branch: z.string().max(120).optional().describe("Branch name. Default task/<slug>."),
      instructions: z
        .string()
        .max(12_000)
        .describe("What the builder must do: the approved plan, in full. It has not seen your thread. Ignored with claimOnly."),
      claimOnly: flag()
        .optional()
        .describe(
          "Only (re)claim these touches for the task, replacing its claims: no worktree, no builder. Use it to widen claims when the branch needs more files; overlaps with other tasks are re-checked.",
        ),
    }),
    presentation: { label: { pending: "Starting a build", completed: "Started a build" } },
    async execute({ task: arg, touches, branch, instructions, claimOnly }, ctx) {
      try {
        const task = taskFor(ctx.threadId, arg);
        if (claimOnly === true) return text(await claimOnlyFor(task, touches));
        return text(await startBuild(task, { touches, branch: branch ?? null, instructions }, ctx.threadId));
      } catch (error) {
        return fail(`Could not start the build: ${describeError(error)}`);
      }
    },
  });

  /**
   * A New task's summary title: one cheap-model call on the host, after the
   * thread is up. Replaces the first-sentence title only while the task is
   * open and nobody has renamed it; any failure keeps that title.
   */
  async function summarizeTitle(taskId: string, threadId: string, firstTitle: string, brief: string, hostId: string | null) {
    if (hostId === null) return;
    try {
      const reply = await host.call(
        "summarizeTitle",
        { prompt: summaryTitlePrompt(brief), model: TITLE_MODEL },
        { hostId, timeoutMs: 60_000 },
      );
      if (!reply.ok) {
        bb.log.info(`${taskId}: no summary title (${reply.error}); keeping "${firstTitle}".`);
        return;
      }
      const title = parseSummaryTitle(reply.text);
      const task = store.task(taskId);
      if (title === null || task === null || task.closedAt !== null || task.title !== firstTitle || title === firstTitle) return;
      changed(store.updateTask(taskId, { title }));
      await bb.sdk.threads.update({ threadId, title });
      bb.log.info(`${taskId}: titled "${title}" (was "${firstTitle}").`);
    } catch (error) {
      bb.log.info(`${taskId}: summary title failed (${describeError(error)}); keeping "${firstTitle}".`);
    }
  }

  /** When the last Jev ask failed: no ask for JEV_BACKOFF_MS after it. */
  let jevFailedAt: number | null = null;

  /**
   * Watch only: ask Jev a new task's kind and tier in the background and store
   * the answer (jevwatch.ts). Never awaited by a caller, bounded by
   * JEV_TIMEOUT_MS, and nothing reads the answer but the board's report:
   * it changes no behaviour. "off" (no box up) writes no row.
   */
  async function jevWatchTask(task: Task, hostId: string | null) {
    try {
      const askedAt = Date.now();
      if (hostId === null || !shouldCall(askedAt, jevFailedAt)) return;
      let reply: JevAskReply;
      try {
        reply = await host.call(
          "jevAsk",
          { title: task.title.slice(0, 1000), brief: task.brief.slice(0, 4000) },
          { hostId, timeoutMs: JEV_TIMEOUT_MS + 500 },
        );
      } catch (error) {
        reply = { ok: false, kind: "error", error: `host: ${describeError(error)}`.slice(0, 300), latencyMs: Date.now() - askedAt };
      }
      const record = askRecord(reply);
      if (record === null) return;
      if (failedAsk(record)) jevFailedAt = askedAt;
      store.recordJevAsk({ taskId: task.id, projectId: task.projectId, askedAt, ...record });
    } catch (error) {
      bb.log.info(`${task.id}: Jev watch skipped (${describeError(error)}).`);
    }
  }

  /** The board's routes: the last 14 days and every open task's threads, each with its outcome (routeoutcome.ts). */
  function boardRoutes(open: readonly Task[]): BoardState["modelRoutes"] {
    const now = Date.now();
    const openIds = new Set(open.map((task) => task.id));
    const routes = store
      .modelRoutes()
      .filter((route) => now - route.routedAt < ROUTE_WINDOW_MS || openIds.has(route.taskId))
      .slice(-2000);
    const taskIds = new Set(routes.map((route) => route.taskId));
    const outcomes = routeOutcomes(
      routes,
      store.children().filter((child) => taskIds.has(child.taskId)),
      store.tickets({ status: "all" }).filter((ticket) => taskIds.has(ticket.taskId)),
    );
    return routes.map((route) => ({
      threadId: route.threadId,
      projectId: route.projectId,
      role: route.role,
      routedAt: route.routedAt,
      model: route.model,
      reason: route.reason,
      probability: route.probability,
      answeredBy: route.jevModel,
      effort: route.effort,
      effortReason: route.effortReason,
      effortProbability: route.effortProbability,
      outcome: outcomes.get(route.threadId) ?? { kind: "open", buildFailures: route.buildFailures, questions: 0 },
    }));
  }

  /** When the last model route failed, and why: no ask for the back-off after it (modelroute.ts routeBackoff, routePause). */
  let routeFailure: { at: number; error: string | null } | null = null;

  /**
   * The model and effort for one agent's spawn (modelroute.ts): Sonnet, Haiku
   * or a lower effort only when Jev is confident, else none, today's provider
   * default. Never Patches, never over the owner's own pick. Bounded by the
   * host's 2 s; any failure is no model and no effort, so a spawn never fails
   * on it. Spawn only: nothing that messages, retries or restarts an existing
   * thread passes a model or effort.
   */
  async function routeFor(input: {
    role: RouteRole;
    providerId: string | undefined;
    ownerModel?: boolean;
    hostId: string | null;
    state: () => string;
  }): Promise<RouteRecord> {
    const skip = routeSkip({ role: input.role, ownerModel: input.ownerModel ?? false, providerId: input.providerId });
    if (skip !== null) return skippedRoute(skip);
    const role = input.role;
    if (role === "patches") return skippedRoute("patches");
    const started = Date.now();
    if (routeBackoff(started, routeFailure?.at ?? null)) return skippedRoute("backoff");
    if (input.hostId === null) return skippedRoute("error", "no host");
    let record: RouteRecord;
    try {
      const checkout = await orchestratorCheckout(input.hostId);
      const reply = await host.call("modelRoute", { state: input.state(), checkout, role }, { hostId: input.hostId, timeoutMs: ROUTE_TIMEOUT_MS + 500 });
      record = routeDecision(reply, role);
    } catch (error) {
      record = skippedRoute("error", `host: ${describeError(error)}`);
    }
    if (routeFailed(record)) routeFailure = { at: started, error: record.error };
    return record;
  }

  /** The route of a spawned agent, in the dossier and the log. Bookkeeping: never fails the spawn. */
  function noteRoute(threadId: string, task: Task, role: RouteRole, record: RouteRecord) {
    try {
      store.recordModelRoute({ threadId, taskId: task.id, projectId: task.projectId, role, routedAt: Date.now(), ...record });
      const p = record.probability === null ? "" : ` p=${record.probability.toFixed(2)}`;
      const ep = record.effortProbability === null ? "" : ` p=${record.effortProbability.toFixed(2)}`;
      bb.log.info(
        `${task.id}: ${role} ${threadId} on ${record.model ?? "the provider default"} (${record.reason}${p}), effort ${record.effort ?? "default"} (${record.effortReason}${ep}).`,
      );
    } catch (error) {
      bb.log.warn(`${task.id}: recording the model route failed: ${describeError(error)}`);
    }
  }

  /**
   * The Orchestrator's own main checkout on a host: the project whose profile
   * lands on main (profiles.ts; only the built-in one may), its default local
   * source, never a worktree. The repo .env the Jev key may live in is there
   * (typesafe.ts jevKey). Kept a minute: it is on the spawn path.
   */
  const orchestratorCheckouts = new Map<string, { at: number; path: string | null }>();
  async function orchestratorCheckout(hostId: string): Promise<string | null> {
    const cached = orchestratorCheckouts.get(hostId);
    if (cached !== undefined && Date.now() - cached.at < 60_000) return cached.path;
    let found: string | null = null;
    try {
      for (const project of await allProjects()) {
        if (project.kind === "personal" || profileOf(project).land !== "main") continue;
        const source = sourceOf(project);
        if (source !== null && source.hostId === hostId) {
          found = source.path;
          break;
        }
      }
    } catch {
      found = cached?.path ?? null;
    }
    orchestratorCheckouts.set(hostId, { at: Date.now(), path: found });
    return found;
  }

  type RouteKeyStatus = { present: true; file: string } | { present: false; problem: "missing" | "open" | "tracked"; file: string | null };
  /** routeKeyStatus, kept a minute: board_state runs on every dossier change. */
  let routeKeySeen: { at: number; status: RouteKeyStatus | null } | null = null;

  async function routeKey(hostId: string | null) {
    if (routeKeySeen !== null && Date.now() - routeKeySeen.at < 60_000) return routeKeySeen.status;
    let status: RouteKeyStatus | null = null;
    if (hostId !== null) {
      try {
        status = await host.call("routeKeyStatus", { checkout: await orchestratorCheckout(hostId) }, { hostId, timeoutMs: 5_000 });
      } catch {
        status = null;
      }
    }
    routeKeySeen = { at: Date.now(), status };
    return status;
  }

  /**
   * Why a build or claimOnly waits: the task's last land is running or its
   * reload is not confirmed, and that confirmation releases the task's claims
   * and resets its build (keepOpenAfterStep). Null when nothing is pending.
   */
  function waitsForReload(task: Task): string | null {
    return buildWaitsForReload({ landing: landing.has(task.id), reloadPending: store.getMeta(reloadKey(task.id)) !== null });
  }

  /**
   * build(claimOnly): replace the task's claims with these touches, checked
   * against other tasks' claims exactly as a build is. In any build state and
   * past every gate: it starts nothing. Throws with the reason when refused.
   */
  async function claimOnlyFor(task: Task, touches: readonly string[]): Promise<string> {
    const waits = waitsForReload(task);
    if (waits !== null) throw new Error(waits);
    const project = await projectById(task.projectId);
    const profile = profileOf(project);
    const config = configRefusal(profile);
    if (config !== null) throw new Error(config);
    if (profile.build === "flux-prompts") {
      throw new Error(`${project.name} has no code builds: paste the Flux prompt into Flux in ${owners()} Chrome instead, and ask ${owner()} before spending ACUs.`);
    }
    const result = store.transaction(() => {
      const claims = planClaims({ taskId: task.id, projectId: task.projectId, touches, held: store.claims(), profile });
      if (!claims.ok) return claims;
      store.releaseClaims(task.id);
      store.addClaims(task.id, task.projectId, claims.paths);
      return claims;
    });
    if (!result.ok) {
      const lines = [
        ...result.invalid,
        ...result.conflicts.map((c) => `${c.path} overlaps ${c.heldPath}, held by ${c.heldBy}`),
      ];
      throw new Error(`Refused, nothing claimed:\n- ${lines.join("\n- ")}`);
    }
    const saved = store.task(task.id);
    if (saved !== null) changed(saved);
    return `Claimed ${result.paths.join(", ")} for ${task.id}; its claims are now exactly these.`;
  }

  /**
   * Claim, plan the worktree, and start preparing it; throws with the reason
   * when refused. Shared by build() and the owner's Retry. A task whose last build
   * failed reuses that worktree and branch instead of orphaning them.
   */
  async function startBuild(task: Task, request: BuildRequest, requestedBy: string, bySam = false): Promise<string> {
    const waits = waitsForReload(task);
    if (waits !== null) throw new Error(waits);
    const project = await projectById(task.projectId);
    const profile = profileOf(project);
    const config = configRefusal(profile);
    if (config !== null) throw new Error(config);
    if (profile.build === "flux-prompts") {
      throw new Error(`${project.name} has no code builds: paste the Flux prompt into Flux in ${owners()} Chrome instead, and ask ${owner()} before spending ACUs.`);
    }
    if (task.buildState === "preparing" || task.buildState === "running") {
      throw new Error(`${task.id} already has a build in flight (${task.buildState}).`);
    }
    if (task.threadId === null) throw new Error(`${task.id} has no task thread.`);
    const source = sourceOf(project);
    if (source === null) throw new Error(`${project.name} has no local checkout.`);
    const memory = buildRefusal(guard.readingFor(source.hostId), Date.now());
    if (memory !== null) throw new Error(memory);
    // Near the usage limit no new build starts; the owner's own Retry is their call.
    const paused = bySam ? null : signInPause(task, "build") ?? usagePause(task, "build");
    if (paused !== null) throw new Error(paused);
    // One PR per effort: a task with a PR continues that PR's head branch,
    // read fresh from GitHub, rather than cutting a new branch from main.
    let fetched: PrFacts | null = null;
    if (task.prNumber !== null && (project.gitRemoteUrl ?? null) !== null) {
      try {
        fetched = await host.call("prFacts", { repoPath: source.path, number: task.prNumber }, { hostId: source.hostId, timeoutMs: 60_000 });
      } catch (error) {
        throw new Error(`Could not read PR #${task.prNumber} (${describeError(error)}), so no build: a new branch could strand its commits outside the PR. Try again.`);
      }
    }
    const pr = fetched;

    // Decide and claim synchronously: no other tool call can interleave.
    const decide = () => store.transaction(() => {
      const inFlight = buildsInFlight(store.tasks({ includeClosed: false })).filter((t) => t.id !== task.id);
      if (inFlight.length >= BUILD_CAP) {
        return { ok: false as const, conflicts: false, message: `${BUILD_CAP} builds are already in flight (${inFlight.map((t) => t.id).join(", ")}). Wait for one to reach its PR.` };
      }
      const claims = planClaims({
        taskId: task.id,
        projectId: task.projectId,
        touches: request.touches,
        held: store.claims(),
        profile,
      });
      if (!claims.ok) {
        const lines = [
          ...claims.invalid,
          ...claims.conflicts.map((c) => `${c.path} overlaps ${c.heldPath}, held by ${c.heldBy}`),
        ];
        return {
          ok: false as const,
          conflicts: claims.conflicts.length > 0,
          holders: [...new Set(claims.conflicts.map((c) => c.heldBy))],
          message: `Refused, nothing claimed:\n- ${lines.join("\n- ")}`,
        };
      }
      const repoState = repoCache.get(project.id)?.repo;
      const hasRemote = (project.gitRemoteUrl ?? null) !== null;
      const defaultBranch = repoState?.defaultBranch ?? "main";
      const followUp = followUpBuild({
        repoPath: source.path,
        task,
        pr,
        checkedOutAt: pr === null ? null : repoState?.branches.find((b) => b.name === pr.headRefName)?.worktreePath ?? null,
      });
      const retry =
        task.buildState === "failed" &&
        task.worktreePath !== null &&
        task.branch !== null &&
        isRepoWorktreePath(source.path, task.worktreePath);
      const reuse = followUp.kind === "continue" || retry;
      let worktreePath: string;
      let branchName: string;
      let baseRef: string;
      const newSlugPath = () => {
        const taken = new Set(
          store
            .tasks({ includeClosed: true })
            .map((t) => t.worktreePath?.split("/").pop())
            .filter((slug): slug is string => slug !== undefined),
        );
        const slug = taskSlug(task.title, taken);
        return { slug, path: worktreePathFor(source.path, slug) };
      };
      if (followUp.kind === "continue") {
        branchName = followUp.branch;
        worktreePath = followUp.worktreePath ?? newSlugPath().path;
        baseRef = task.baseRef ?? buildBaseRef(profileOf(project), hasRemote, defaultBranch);
      } else if (retry) {
        worktreePath = task.worktreePath as string;
        branchName = task.branch as string;
        baseRef = task.baseRef ?? buildBaseRef(profileOf(project), hasRemote, defaultBranch);
      } else {
        baseRef = buildBaseRef(profileOf(project), hasRemote, defaultBranch);
        const fresh = newSlugPath();
        worktreePath = fresh.path;
        branchName = branchFor(fresh.slug, request.branch);
      }
      store.releaseClaims(task.id);
      store.addClaims(task.id, task.projectId, claims.paths);
      const saved = store.updateTask(task.id, {
        stage: "build",
        buildState: "preparing",
        buildError: null,
        buildRequest: request,
        branch: branchName,
        baseRef,
        worktreePath,
        worktreeNote: null,
      });
      const continuesPr = followUp.kind === "continue" ? followUp.prNumber : null;
      const prHead = followUp.kind === "continue" && pr !== null && pr.headRefOid !== "" ? pr.headRefOid : null;
      return { ok: true as const, task: saved, claims: claims.paths, worktreePath, branchName, baseRef, reuse, continuesPr, prHead };
    });
    let plan = decide();
    if (!plan.ok && plan.conflicts) {
      // A holder may be finished without the board having noticed yet (its PR
      // merged, its branch gone): reconcile fresh, then decide again.
      const { checks } = await snapshotRepos(true);
      await Promise.allSettled(checks);
      plan = decide();
    }
    if (!plan.ok) {
      // Still refused on claims: the liveness beat wakes it once they free (wakeClaimWaiters).
      if (plan.conflicts && "holders" in plan) {
        const wait: ClaimWait = { taskId: task.id, projectId: task.projectId, touches: request.touches, holders: plan.holders, since: Date.now() };
        store.setMeta(claimWaitKey(task.id), JSON.stringify(wait));
      }
      throw new Error(plan.message);
    }
    store.setMeta(claimWaitKey(task.id), null);
    changed(plan.task);
    void prepareAndStartBuild({
      task: plan.task,
      project,
      profile,
      hostId: source.hostId,
      repoPath: source.path,
      worktreePath: plan.worktreePath,
      branch: plan.branchName,
      baseRef: plan.baseRef,
      claims: plan.claims,
      instructions: request.instructions,
      requestedBy,
      reuse: plan.reuse,
      continuesPr: plan.continuesPr,
      prHead: plan.prHead,
    });
    const where = plan.continuesPr !== null
      ? `Continuing PR #${plan.continuesPr}'s branch ${plan.branchName} in ${plan.worktreePath}`
      : `${plan.reuse ? "Reusing" : "Preparing"} ${plan.worktreePath} on ${plan.branchName} from ${plan.baseRef}`;
    return `Claimed ${plan.claims.join(", ")} for ${task.id}. ${where}; the builder starts under the task thread once dependencies are installed. A failure goes back to the task thread to fix.`;
  }

  /**
   * A build that failed: claims back, the slot freed, and the owning task
   * told to fix it (the owner sees it only past BUILD_FAILURE_LIMIT). Patches hears
   * too when she asked for the build.
   */
  async function failBuildFor(taskId: string, reason: string, keepWorktree: boolean, requestedBy: string | null) {
    const current = store.task(taskId);
    if (current === null) return;
    countBuildFailure(current);
    const saved = store.transaction(() => {
      store.releaseClaims(taskId);
      return store.updateTask(taskId, {
        buildState: "failed",
        buildError: reason.slice(0, 1000),
        buildFailures: current.buildFailures + 1,
        stage: "research",
        ...(keepWorktree ? {} : { worktreePath: null, branch: null }),
      });
    });
    changed(saved);
    const message = buildFailedMessage({
      taskId,
      reason,
      failures: saved.buildFailures,
      worktreePath: saved.worktreePath,
    });
    for (const threadId of new Set([saved.threadId, requestedBy])) {
      if (threadId === null) continue;
      try {
        await tellThread(threadId, message);
      } catch (error) {
        bb.log.warn(`could not report build failure to ${threadId}: ${describeError(error)}`);
      }
    }
  }

  /**
   * One failure on the routes it belongs to (routeoutcome.ts): the task's,
   * and its latest builder's unless a new build is still being prepared (a
   * failure then is that build's, which has no thread yet).
   */
  function countBuildFailure(task: Task) {
    try {
      const builder =
        task.buildState === "preparing"
          ? null
          : (store
              .children()
              .filter((child) => child.taskId === task.id && child.kind === "build")
              .pop()?.threadId ?? null);
      store.countRouteBuildFailure([task.threadId, builder]);
    } catch (error) {
      bb.log.warn(`${task.id}: counting the build failure on its routes failed: ${describeError(error)}`);
    }
  }

  async function prepareAndStartBuild(args: {
    task: Task;
    project: BbProject;
    profile: ProjectProfile;
    hostId: string;
    repoPath: string;
    worktreePath: string;
    branch: string;
    baseRef: string;
    claims: string[];
    instructions: string;
    requestedBy: string;
    reuse: boolean;
    continuesPr: number | null;
    prHead: string | null;
  }) {
    const { task, project, profile, hostId } = args;
    const failBuild = (reason: string, keepWorktree: boolean) =>
      failBuildFor(task.id, reason, keepWorktree, args.requestedBy);
    if (PLUGIN_ROOT === null) {
      await failBuild(`Creating the worktree failed: cannot find The Orchestrator's source folder from ${SERVER_DIR}.`, false);
      return;
    }
    try {
      await host.call(
        "prepareWorktree",
        {
          repoPath: args.repoPath,
          worktreePath: args.worktreePath,
          pluginRoot: PLUGIN_ROOT,
          branch: args.branch,
          baseRef: args.baseRef,
          include: worktreeIncludeOf(profile),
          productionEnv: profile.productionEnv,
          reuse: args.reuse,
          ...(args.prHead !== null ? { prHead: args.prHead } : {}),
        },
        { hostId, timeoutMs: 120_000 },
      );
    } catch (error) {
      await failBuild(`Creating the worktree failed: ${describeError(error)}`, false);
      return;
    }
    if (profile.setup.length > 0) {
      try {
        const setup = await host.call(
          "runSetup",
          { worktreePath: args.worktreePath, commands: profile.setup.map((argv) => [...argv]) },
          { hostId, timeoutMs: SETUP_TIMEOUT_MS },
        );
        if (!setup.ok) {
          await failBuild(`Dependency setup failed in ${args.worktreePath}:\n${setup.failure ?? ""}`, true);
          return;
        }
      } catch (error) {
        await failBuild(`Dependency setup failed: ${describeError(error)}`, true);
        return;
      }
    }
    try {
      const fresh = store.task(task.id) ?? task;
      const answers = store
        .tickets({ status: "all" })
        .filter((ticket) => ticket.taskId === task.id && ticket.answers !== null)
        .flatMap((ticket) =>
          ticket.questions.map((question, index) => ({ question, answer: ticket.answers?.[index] ?? "" })),
        );
      const provider = await providerOf(fresh.threadId);
      const route = await routeFor({
        role: "build",
        providerId: provider.providerId,
        hostId,
        state: () => routeState({ role: "build", taskTitle: fresh.title, instructions: args.instructions }),
      });
      const thread = await bb.sdk.threads.spawn({
        projectId: task.projectId,
        parentThreadId: fresh.threadId ?? undefined,
        ...provider,
        ...spawnModel("build", route),
        environment: {
          type: "provider",
          environmentProviderId: WORKTREE_PROVIDER,
          inputs: { kind: "existing", path: args.worktreePath },
          machine: { type: "existing", hostId },
        },
        // Pinned: "full" would bypass the sandbox the builder guard sets up in
        // the worktree's .claude/settings.local.json (host prepareWorktree).
        permissionMode: "auto",
        title: `Build: ${fresh.title}`,
        prompt: buildPrompt({
          task: fresh,
          profile,
          worktreePath: args.worktreePath,
          branch: args.branch,
          baseRef: args.baseRef,
          claims: args.claims,
          answers,
          instructions: args.instructions,
          continuesPr: args.continuesPr,
        }),
        pluginMetadata: { role: "build", taskId: task.id },
      });
      noteRoute(thread.id, fresh, "build", route);
      store.addChild({ threadId: thread.id, taskId: task.id, kind: "build", label: args.branch });
      changed(store.updateTask(task.id, { buildState: "running", buildFailures: 0 }));
      bb.log.info(`build ${thread.id} started for ${task.id} in ${project.name}`);
    } catch (error) {
      await failBuild(`Starting the builder failed: ${describeError(error)}`, true);
    }
  }

  bb.agents.registerTool({
    name: "ask_sam",
    description: `Bring ${owner()} this task's asks as ONE ticket; at most ${MAX_OPEN_QUESTIONS} open per task. Only for what ${owner()} alone can decide or run. Each ask says exactly what they do: a "decision" with 2-5 options and the index of the one you recommend, or a "command" they must run themself, with the reason only they can (${SAM_ONLY_REASONS.join(", ")}). Anything you can run, run. Record what you decided yourself in decisions. To reword earlier asks, send the full current set with replace: true. To withdraw an open ticket or some of its questions (no longer needed, settled another way), or a report ticket, use withdraw with the reason: it leaves Needs you and the reason goes in the dossier; never just say in chat that you withdrew it. A task withdraws only its own ticket; Patches any in her project. End your turn after asking: the answers come back to the task thread. Patches: no task for it yet? start_task first. A question written in chat never reaches ${owners()} Needs you.`,
    parameters: z.object({
      task: taskId,
      questions: z.array(askSchema).max(MAX_OPEN_QUESTIONS).default([]),
      withdraw: z
        .preprocess(
          parseJsonString,
          z.object({
            ticket: z.string().min(1).max(40).describe("The open ticket's id (tkt_…)."),
            questions: z
              .array(z.coerce.number().int())
              .max(MAX_OPEN_QUESTIONS)
              .optional()
              .describe("1-based numbers of the questions to withdraw; omit to withdraw the whole ticket."),
            reason: z.string().max(2000).describe("Why, at least 10 characters: recorded in the dossier."),
          }),
        )
        .optional()
        .describe("Withdraw an open ticket, or some of its questions, with a reason. Done before any questions in this call."),
      replace: flag()
        .optional()
        .describe("true: these asks replace the questions on this task's open ticket, for rewording (to drop asks, use withdraw with a reason); default adds to it."),
      decisions: z
        .array(z.object({ question: z.string().max(500), decision: z.string().max(1500) }))
        .max(30)
        .optional(),
    }),
    presentation: { label: { pending: `Asking ${owner()}`, completed: `Asked ${owner()}` } },
    async execute({ task: arg, questions, withdraw, replace, decisions }, ctx) {
      try {
        let withdrawn = "";
        if (withdraw !== undefined) {
          const result = withdrawTicketFor(ctx.threadId, withdraw);
          if (!result.ok) return fail(result.text);
          withdrawn = result.text;
          if (questions.length === 0 && (decisions === undefined || decisions.length === 0)) return text(withdrawn);
          withdrawn += " ";
        }
        const task = taskFor(ctx.threadId, arg);
        if (decisions !== undefined && decisions.length > 0) {
          store.updateTask(task.id, { decisions: [...task.decisions, ...decisions] });
        }
        if (questions.length === 0) {
          changed(store.task(task.id) as Task);
          return text(`${withdrawn}Recorded ${decisions?.length ?? 0} decisions for ${task.id}; no questions asked.`);
        }
        const refused = questions
          .map((ask, index) => ({ index, why: validateAsk(ask as Ask) }))
          .filter((entry) => entry.why !== null);
        if (refused.length > 0) {
          return fail(`${withdrawn}Nothing asked. Fix these asks:\n${refused.map((entry) => `- ask ${entry.index + 1}: ${entry.why}`).join("\n")}`);
        }
        const ticket = store.addQuestions(task.id, questions as Ask[], MAX_OPEN_QUESTIONS, replace === true);
        changed(store.task(task.id) as Task);
        const held = `Ticket ${ticket.id} for ${task.id} now holds ${ticket.questions.length} question(s)`;
        if (replace === true) return text(`${withdrawn}${held}, replacing the earlier ones. ${Owner()} sees one ticket for this task. End your turn.`);
        return text(`${withdrawn}${held}. ${Owner()} sees one ticket for this task. End your turn.`);
      } catch (error) {
        return fail(describeError(error));
      }
    },
  });

  /**
   * ask_sam withdraw: tickets.ts decides who may withdraw what; the store
   * records it. A task Patches withdraws from is told why.
   */
  function withdrawTicketFor(
    threadId: string,
    withdraw: { ticket: string; questions?: number[] | undefined; reason: string },
  ): { ok: boolean; text: string } {
    const who = caller(threadId);
    const ticket = store.ticket(withdraw.ticket);
    const ticketTask = ticket === null ? null : store.task(ticket.taskId);
    const plan = withdrawDecision({
      caller: who === null ? null : who.kind === "task" ? { kind: "task", taskId: who.task.id } : who,
      ticket,
      ticketTask,
      questions: withdraw.questions,
      reason: withdraw.reason,
    });
    if (typeof plan === "string") return { ok: false, text: `Nothing withdrawn: ${plan}` };
    // withdrawDecision refuses a missing ticket, so both are here.
    const id = ticket!.id;
    const reason = withdraw.reason.trim();
    const by = who!.kind === "task" ? "task" : "patches";
    const after =
      plan.kind === "ticket" ? store.withdrawTicket(id, { reason, by }) : store.withdrawQuestions(id, plan.removed, { reason, by });
    // A withdrawn review hand-off puts the task back at its PR, as voidReview does.
    if (ticketTask !== null && ticket!.kind === "review" && ticketTask.stage === "you") store.updateTask(ticketTask.id, { stage: "pr" });
    if (ticketTask !== null) changed(store.task(ticketTask.id) ?? ticketTask);
    else publish();
    bb.log.info(`${id} withdrawn by ${by} (${withdrawnWhat(plan)}): ${reason}`);
    const owner = ticketTask?.threadId ?? null;
    if (by === "patches" && owner !== null && owner !== threadId) {
      void tellThread(owner, withdrawnByPatchesMessage(id, plan, reason)).catch((error: unknown) =>
        bb.log.warn(`telling ${ticketTask?.id} its ticket was withdrawn failed: ${describeError(error)}`),
      );
    }
    const left = after.status === "open" ? `; ${after.questions.length} question(s) still open` : "; it is closed and off Needs you";
    return { ok: true, text: `Withdrew ${withdrawnWhat(plan)} of ${id}${left}. The reason is in the dossier.` };
  }

  // ---------------------------------------------------------------- reports
  // report.ts: a task's findings as a file under bb's thread storage, one open
  // report ticket per task, read and checked only through the host.

  /** A task's report file through the primary host, which holds bb's thread storage. */
  async function reportFile(taskId: string, path: string, read: boolean) {
    const hostId = (await bb.sdk.system.config()).primaryHostId ?? null;
    if (hostId === null) return { ok: false as const, reason: "No host is connected to check the report on." };
    const file = await host.call("readReport", { taskId, path, read }, { hostId, timeoutMs: 30_000 });
    return file.ok ? { ...file, hostId } : file;
  }

  /** Tell the task's Patches chat once per submission; not when she submitted it herself. */
  async function tellReport(task: Task, report: ReportRef, replaced: boolean, from: string) {
    if (chatThread(task.projectId) === from) return;
    const message = reportToldMessage(task, report, replaced);
    try {
      const chat = await ensureChat(await projectById(task.projectId), message);
      if (!chat.started) await tellThread(chat.threadId, message);
    } catch (error) {
      bb.log.warn(`telling Patches about ${task.id}'s report failed: ${describeError(error)}`);
    }
  }

  bb.agents.registerTool({
    name: "submit_report",
    description: `Hand ${owner()} this task's findings to review: a markdown file you wrote under bb's thread storage, <thread-storage>/<task id>/report.md (an absolute .md path, at most 2 MB, no symlinks out). It opens (or, submitted again, updates) the task's one report ticket: "Review report: <title>" in ${owners()} Needs you. The task stays open until ${owner()} marks it reviewed. Task threads; Patches may pass task.`,
    parameters: z.object({
      task: taskId,
      path: z.string().min(1).max(1000).describe("Absolute path of the report: <thread-storage>/<task id>/report.md."),
      title: z.string().min(1).max(REPORT_TITLE_MAX).describe(`One line, at most ${REPORT_TITLE_MAX} characters.`),
      summary: z.string().max(REPORT_SUMMARY_MAX + 20).optional().describe("1-3 short lines: where things stand."),
    }),
    presentation: { label: { pending: "Submitting a report", completed: "Submitted a report" } },
    async execute({ task: arg, path, title, summary }, ctx) {
      try {
        const task = taskFor(ctx.threadId, arg);
        const badTitle = reportTitleRefusal(title);
        if (badTitle !== null) return fail(`Not submitted: ${badTitle}`);
        const lines = reportSummary(summary);
        if (!lines.ok) return fail(`Not submitted: ${lines.reason}`);
        const file = await reportFile(task.id, path, false);
        if (!file.ok) return fail(`Not submitted: ${file.reason}`);
        const report: ReportRef = { path: file.path, title: title.trim(), summary: lines.summary };
        const { ticket, replaced } = store.submitReport(task.id, report);
        changed(store.task(task.id) ?? task);
        bb.log.info(`${task.id} ${replaced ? "updated" : "submitted"} report ${ticket.id}: ${report.path}`);
        void tellReport(task, report, replaced, ctx.threadId);
        return text(reportSubmittedReply(ticket.id, replaced));
      } catch (error) {
        return fail(describeError(error));
      }
    },
  });

  bb.agents.registerTool({
    name: "open_pr",
    description:
      "Push the task's branch from its worktree (never forced) and open its PR, or update the existing one with the new commits. The builder commits; this is the only push.",
    parameters: z.object({
      task: taskId,
      title: z.string().min(5).max(200),
      body: z.string().min(20).max(30_000).describe("The builder's PR body, including its '## Not verified' section."),
    }),
    presentation: { label: { pending: "Pushing the branch", completed: "Pushed the branch" } },
    async execute({ task: arg, title, body }, ctx) {
      try {
        const task = taskFor(ctx.threadId, arg);
        if (task.worktreePath === null || task.branch === null) return fail(`${task.id} has no worktree yet: build first.`);
        const project = await projectById(task.projectId);
        const source = sourceOf(project);
        if (source === null) return fail(`${project.name} has no local checkout.`);
        const route = { hostId: source.hostId, timeoutMs: 90_000 };
        const state = await host.call(
          "worktreeState",
          { worktreePath: task.worktreePath, baseRef: task.baseRef ?? "origin/main" },
          route,
        );
        if (state.branch !== task.branch) return fail(`The worktree is on ${state.branch ?? "a detached HEAD"}, not ${task.branch}.`);
        if (state.dirty) return fail("The worktree has uncommitted changes: the builder must commit first.");
        if (state.ahead === 0) return fail("No commits on the branch yet.");
        // A remote (such as a backup) never makes a land: "main" project PR-based.
        const profile = profileOf(project);
        const config = configRefusal(profile);
        if (config !== null) return fail(config);
        if (profile.land === "main") {
          return fail(`${project.name} lands straight on main: call land, not open_pr.`);
        }
        const refused = plumbingRefusal(state.files);
        if (refused) return fail(refused);
        const outside = outsideClaims(state.files, store.claimsFor(task.id), profile);
        if (outside.length > 0) return fail(outsideClaimsRefusal(outside));
        if (project.gitRemoteUrl === null) {
          return fail(`${project.name} has no remote: nothing to push to. Call ready_for_review; ${owner()} reviews the branch locally.`);
        }
        // The task's PR as GitHub has it now: its head branch is where commits must go.
        const existing =
          task.prNumber === null ? null : await host.call("prFacts", { repoPath: source.path, number: task.prNumber }, route);
        const plan = prPushPlan(task.branch, existing);
        if (plan.kind !== "new-pr") {
          const pushed = await host.call(
            "pushBranch",
            plan.kind === "same"
              ? { worktreePath: task.worktreePath, branch: task.branch }
              : { worktreePath: task.worktreePath, branch: task.branch, target: plan.target, expectedOld: plan.expectedOld },
            route,
          );
          // Believe GitHub, not the push: the PR's head must now be the pushed sha.
          let reached = { ok: false, reason: "" } as ReturnType<typeof pushReachedPr>;
          for (let attempt = 0; attempt < 5; attempt += 1) {
            if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2_000));
            const after = await host.call("prFacts", { repoPath: source.path, number: plan.prNumber }, route);
            reached = pushReachedPr({ prNumber: plan.prNumber, target: plan.target, pushedSha: pushed.headSha, after });
            if (reached.ok) break;
          }
          if (!reached.ok) return fail(reached.reason);
          // The proven head is gone: its review hand-off goes with it.
          store.closeReview(task.id);
          changed(store.updateTask(task.id, { stage: "pr", buildState: "none", verdict: null }));
          const onto = plan.kind === "onto" ? ` (fast-forwarded its branch ${plan.target} from ${task.branch})` : "";
          return text(`Pushed ${pushed.headSha.slice(0, 7)} to PR #${plan.prNumber}${onto}; GitHub confirms its head moved. CI restarts; call ready_for_review when it finishes.`);
        }
        const pushed = await host.call("pushBranch", { worktreePath: task.worktreePath, branch: task.branch }, route);
        const defaultBranch = (task.baseRef ?? "origin/main").replace(/^origin\//, "");
        const pr = await host.call(
          "createPullRequest",
          { worktreePath: task.worktreePath, branch: task.branch, base: defaultBranch, title, body },
          route,
        );
        changed(store.updateTask(task.id, { stage: "pr", buildState: "none", prNumber: pr.number, prUrl: pr.url, verdict: null }));
        return text(`${plan.note ? `${plan.note} ` : ""}Opened PR #${pr.number} (${pr.url}) from ${task.branch} at ${pushed.headSha.slice(0, 7)}. Call ready_for_review when CI finishes.`);
      } catch (error) {
        return fail(`Could not push: ${describeError(error)}`);
      }
    },
  });

  bb.agents.registerTool({
    name: "land",
    description:
      `Only for projects that land straight on main (The Orchestrator's own repo, a local app in development): rebase the task branch onto main in its worktree and fast-forward the main checkout to it. No PR; main is pushed to its private backup afterwards when the profile has one. Cleans up its worktree, then builds and reloads when the profile says so: the task closes once the reload is confirmed live (you are told), and a failed build or reload comes back to the task to fix. Without a reload it closes at once. With \`more\` (what is still left) it does not close: once live, its claims and build slot are released, it stays open and you build again for the next step; the final land omits \`more\` and closes it. A closing land of a task with an open questions ticket leaves it open (claims released) until ${owner()} answers it or it is withdrawn (ask_sam withdraw).`,
    parameters: z.object({
      task: taskId,
      summary: z.string().min(10).max(2000).describe("What landed, in a sentence or two."),
      more: textArg().describe(
        "What is still left for this task after this land, one step per line. With it the task stays open after the reload; omit it on the final land.",
      ),
    }),
    presentation: { label: { pending: "Landing on main", completed: "Landed on main" } },
    async execute({ task: arg, summary, more }, ctx) {
      const steps = parseMore(more);
      const keep = keepOpenAfterLand(steps);
      let landingId: string | null = null;
      try {
        const task = taskFor(ctx.threadId, arg);
        landingId = task.id;
        landing.add(task.id);
        const project = await projectById(task.projectId);
        const profile = profileOf(project);
        if (profile.land !== "main") {
          return fail(`${project.name} ships through a PR that ${owner()} merges: open_pr, then ready_for_review.`);
        }
        if (task.worktreePath === null || task.branch === null) return fail(`${task.id} has no worktree yet: build first.`);
        const source = sourceOf(project);
        if (source === null) return fail(`${project.name} has no local checkout.`);
        const target = (task.baseRef ?? "main").replace(/^origin\//, "");
        const state = await host.call(
          "worktreeState",
          { worktreePath: task.worktreePath, baseRef: task.baseRef ?? target },
          { hostId: source.hostId, timeoutMs: 90_000 },
        );
        const outside = outsideClaims(state.files, store.claimsFor(task.id), profile);
        if (outside.length > 0) return fail(outsideClaimsRefusal(outside));
        // A guard lands only with its tests changed and passing (landguard.ts).
        const guard = guardTestRule(state.files);
        if (!guard.ok) return fail(`${guard.reason} Nothing landed.`);
        if (guard.tests.length > 0) {
          const tests = await host.call(
            "runGuardTests",
            { repoPath: source.path, worktreePath: task.worktreePath, files: guard.tests },
            { hostId: source.hostId, timeoutMs: 6 * 60_000 },
          );
          if (!tests.ok) return fail(`${guard.tests.join(", ")} failed in the worktree, so nothing landed:\n${tests.output}`);
        }
        const landed = await host.call(
          "landBranch",
          { repoPath: source.path, worktreePath: task.worktreePath, branch: task.branch, target },
          { hostId: source.hostId, timeoutMs: 120_000 },
        );
        const reloads = profile.afterLand.length > 0;
        const pending: PendingReload = {
          taskId: task.id,
          threadId: task.threadId,
          projectId: task.projectId,
          sha: landed.headSha,
          target,
          summary,
          startedAt: 0,
          ...(keep ? { more: steps } : {}),
        };
        changed(store.updateTask(task.id, { buildState: "none", buildFailures: 0, verifiedSha: landed.headSha }));
        // Steps left are recorded now, before any reload: the record outlives
        // a failed one. The final land drops it.
        store.setMeta(stepsKey(task.id), keep ? serializeSteps(stepLanded(stepsOf(task.id), landed.headSha, steps)) : null);
        // With a reload, the task closes (or is kept open with its steps left)
        // only once it is live (checkReloads). An open questions ticket keeps
        // a closing task open either way (tickets.ts).
        let held: string | null = null;
        if (!reloads && !keep) {
          const hold = closeHoldFor(task.id);
          if (hold === null) closeTask(task.id, reloadedNote(pending), "landed");
          else {
            holdClose(task, hold, reloadedNote(pending));
            held = heldCloseMessage(task.id, hold, "Landed.");
            if (task.threadId !== null && task.threadId !== ctx.threadId) void tellHeld(task, hold, "Landed.");
          }
          publish();
        }
        // Before the reload below: runAfterLand restarts this plugin, host
        // included, and used to abort a `git worktree remove` still running.
        await cleanupWorktree(task.id);
        // After the cleanup, which reads the worktree the record still names.
        if (!reloads && keep) {
          keepOpenAfterStep(task, landed.headSha, steps);
          publish();
          // Landed by Patches: the task's own thread hears it too.
          if (task.threadId !== null && task.threadId !== ctx.threadId) {
            void tellThread(task.threadId, stepLandedMessage(task.id, landed.headSha, steps)).catch((error: unknown) =>
              bb.log.warn(`telling ${task.id} its step landed failed: ${describeError(error)}`),
            );
          }
        }
        let done = `Landed ${landed.commits} commit(s) from ${task.branch} on ${target} (${landed.headSha.slice(0, 7)}).${reloads ? "" : keep ? ` ${stepKeptReply(task.id, steps.length)}` : held !== null ? ` ${held}` : ` ${task.id} is closed.`}`;
        // A backup push is a separate step: its failure never undoes the land.
        const push = backupPush(profile, target);
        if (push !== null) {
          const remote = push[1]!;
          const retry = `Run git ${push.join(" ")} in ${source.path}.`;
          try {
            const backup = await host.call(
              "pushBackup",
              { repoPath: source.path, remote, branch: target },
              { hostId: source.hostId, timeoutMs: 60_000 },
            );
            done += backup.ok
              ? ` Backed up to ${remote}.`
              : ` Backup push failed: ${backup.error ?? backup.output}; landed anyway. ${retry}`;
          } catch (error) {
            done += ` Backup push failed: ${describeError(error)}; landed anyway. ${retry}`;
          }
        }
        if (!reloads) return text(done);
        // Landed is landed: a failed build after it is the task's to fix, never undone.
        const build = profile.afterLand.slice(0, -1).map((argv) => argv.join(" ")).join(" && ") || "the build";
        let error: string;
        try {
          const after = await host.call(
            "runAfterLand",
            { repoPath: source.path, commands: profile.afterLand.map((argv) => [...argv]), reloadId: task.id },
            { hostId: source.hostId, timeoutMs: 15 * 60_000 },
          );
          if (after.ok) {
            // Recorded before the reply: the reload restarts this plugin a
            // second from now, and the next instance picks it up from here.
            store.setMeta(reloadKey(task.id), JSON.stringify({ ...pending, startedAt: Date.now() }));
            return text(
              keep
                ? `${done} Built; reload started, not live yet. Once it is confirmed live: ${stepKeptReply(task.id, steps.length)}`
                : `${done} Built; reload started, not live yet. ${task.id} stays open until the reload is confirmed.`,
            );
          }
          error = after.error ?? after.output;
        } catch (caught) {
          error = describeError(caught);
        }
        // A half-written dist/ must not be what a restart of bb loads.
        const rollback = await restoreLastGood(source);
        await failBuildFor(task.id, withRollback(`Landed on ${target}, then the build failed: ${error}`, rollback), false, ctx.threadId);
        return text(withRollback(`${done} Build failed: ${error}. Run ${build} in ${source.path} and fix it`, rollback));
      } catch (error) {
        return fail(`Could not land: ${describeError(error)}`);
      } finally {
        if (landingId !== null) landing.delete(landingId);
      }
    },
  });

  // ------------------------------------------------------------ reloads
  // land() leaves a pending reload in meta; this instance and the next one
  // both check it every RELOAD_CHECK_MS (reload.ts decides). Only the claimant
  // of a row (it is still the same row) acts, so a decision is made once.
  let checkingReloads = false;

  /** Put the last-good dist/ back (recovery.ts); never throws. */
  async function restoreLastGood(source: { path: string; hostId: string } | null): Promise<RollbackResult> {
    if (source === null) return { restored: false, reason: "the project has no local checkout" };
    try {
      const result = await host.call("restoreLastGood", { repoPath: source.path }, { hostId: source.hostId, timeoutMs: 120_000 });
      if (result.restored && result.sha !== null) {
        bb.log.warn(`dist/ rolled back to last-good ${result.sha}`);
        return { restored: true, sha: result.sha };
      }
      return { restored: false, reason: result.reason ?? "the host restored nothing" };
    } catch (error) {
      bb.log.warn(`restoring the last-good build failed: ${describeError(error)}`);
      return { restored: false, reason: `restoring the last-good build failed: ${describeError(error)}` };
    }
  }

  /** After a confirmed reload, keep its dist/ as last-good; failures are logged only. */
  async function keepLastGood(source: { path: string; hostId: string } | null, pending: PendingReload) {
    if (source === null) return;
    const others = store.metaWithPrefix(RELOAD_PREFIX).filter(({ key }) => key !== reloadKey(pending.taskId)).length;
    if (!shouldKeepLastGood({ otherPendingReloads: others })) {
      bb.log.info(`not keeping ${pending.sha.slice(0, 7)} as last-good: ${others} other reload(s) pending`);
      return;
    }
    try {
      const kept = await host.call("keepLastGood", { repoPath: source.path, sha: pending.sha }, { hostId: source.hostId, timeoutMs: 120_000 });
      if (kept.ok) bb.log.info(`kept ${pending.sha.slice(0, 7)} as the last-good build`);
      else bb.log.warn(`keeping the last-good build failed: ${kept.error}`);
    } catch (error) {
      bb.log.warn(`keeping the last-good build failed: ${describeError(error)}`);
    }
  }

  async function checkReloads() {
    if (checkingReloads) return;
    checkingReloads = true;
    try {
      for (const { key, value } of store.metaWithPrefix(RELOAD_PREFIX)) {
        const pending = parsePendingReload(value);
        if (pending === null) {
          bb.log.warn(`dropping unreadable pending reload ${key}`);
          store.setMeta(key, null);
          continue;
        }
        await checkReload(key, value, pending);
      }
    } catch (error) {
      bb.log.warn(`reload check failed: ${describeError(error)}`);
    } finally {
      checkingReloads = false;
    }
  }

  async function checkReload(key: string, raw: string, pending: PendingReload) {
    const task = store.task(pending.taskId);
    if (task === null || task.closedAt !== null) {
      store.setMeta(key, null);
      return;
    }
    let outcome: ReloadOutcome | null = null;
    let source: ReturnType<typeof sourceOf> = null;
    try {
      source = sourceOf(await projectById(pending.projectId));
      if (source !== null) {
        outcome = await host.call("reloadOutcome", { reloadId: pending.taskId }, { hostId: source.hostId, timeoutMs: 10_000 });
      }
    } catch (error) {
      bb.log.warn(`reading the reload outcome of ${pending.taskId} failed: ${describeError(error)}`);
    }
    const decision = decideReload({ pending, outcome, instanceStartedAt: INSTANCE_STARTED_AT, now: Date.now() });
    if (decision.kind === "wait") return;
    const claimed = store.transaction(() => {
      if (store.getMeta(key) !== raw) return false;
      store.setMeta(key, null);
      return true;
    });
    if (!claimed) return;
    if (decision.kind === "live") {
      try {
        await closeReloaded(pending);
      } catch (error) {
        // The pending key is already cleared: put it back so the next check
        // retries, instead of losing the close (or the step) for good.
        store.setMeta(key, raw);
        bb.log.warn(`closing ${pending.taskId} after its reload failed, will retry: ${describeError(error)}`);
        return;
      }
      await keepLastGood(source, pending);
      return;
    }
    let plugin: PluginStatus | null = null;
    if (source !== null) {
      try {
        plugin = await host.call("pluginStatus", { pluginId: bb.pluginId }, { hostId: source.hostId, timeoutMs: 30_000 });
      } catch (error) {
        bb.log.warn(`reading bb's plugin status failed: ${describeError(error)}`);
      }
    }
    // This is the instance bb kept running: put the last-good build back so
    // a restart of bb loads it, and tell the task main still needs fixing.
    const reason = withRollback(reloadFailureReason(decision.reason, plugin), await restoreLastGood(source));
    bb.log.warn(`${pending.taskId}: ${reason}`);
    await failBuildFor(pending.taskId, reason, false, null);
  }

  /** The reload is live: close the task (or hold it, or keep it open with its steps left) and tell its thread. */
  async function closeReloaded(pending: PendingReload) {
    const current = store.task(pending.taskId);
    if (current === null || current.closedAt !== null) return;
    if (keepOpenAfterLand(pending.more)) {
      const left = pending.more ?? [];
      keepOpenAfterStep(current, pending.sha, left);
      publish();
      if (pending.threadId !== null) {
        try {
          await tellThread(pending.threadId, stepLandedMessage(pending.taskId, pending.sha, left));
        } catch (error) {
          bb.log.warn(`telling ${pending.threadId} its step is live failed: ${describeError(error)}`);
        }
      }
      return;
    }
    const note = reloadedNote(pending);
    const hold = closeHoldFor(current.id);
    if (hold !== null) {
      holdClose(current, hold, note);
      publish();
      if (pending.threadId !== null) await tellHeld({ ...current, threadId: pending.threadId }, hold, `Reloaded: ${pending.sha.slice(0, 7)} is live.`);
      return;
    }
    closeTask(pending.taskId, note, "landed");
    bb.log.info(`${pending.taskId} closed: ${note}`);
    publish();
    if (pending.threadId !== null) {
      try {
        await tellThread(pending.threadId, reloadedMessage(pending));
      } catch (error) {
        bb.log.warn(`telling ${pending.threadId} the reload is live failed: ${describeError(error)}`);
      }
    }
  }

  const reloadTimer = setInterval(() => void checkReloads(), RELOAD_CHECK_MS);
  bb.onDispose(() => clearInterval(reloadTimer));

  bb.agents.registerTool({
    name: "ready_for_review",
    description:
      `Validate the task's PR for its HEAD commit (checks green, preview built from head, E2E and iOS comments passed, then ai-tests added last) and, when everything holds, hand it to ${owner()} with their test list. Safe to call repeatedly: it says what is still missing, and adds or re-adds ai-tests itself when that is the only thing left.`,
    parameters: z.object({
      task: taskId,
      pr: z.number().int().positive().optional().describe("PR number, when the task did not open it through open_pr."),
      testList: z
        .array(z.string().min(3).max(500))
        .max(30)
        .describe(
          `PR projects: first "How to open it (<platform>): …" per platform the PR touches (web preview URL; iOS OTA link/QR with channel, or TestFlight build number, with the head; or "no <platform> preview for <sha7> yet"), from CI or PR comments, never guessed. Then hands-on checks only ${owner()} can do, beyond the ones the diff implies.`,
        ),
    }),
    presentation: { label: { pending: "Validating the PR", completed: "Validated the PR" } },
    async execute({ task: arg, pr, testList }, ctx) {
      try {
        let task = taskFor(ctx.threadId, arg);
        const project = await projectById(task.projectId);
        const profile = profileOf(project);
        const config = configRefusal(profile);
        if (config !== null) return fail(config);
        const source = sourceOf(project);
        if (source === null) return fail(`${project.name} has no local checkout.`);
        if (pr !== undefined && pr !== task.prNumber) task = store.updateTask(task.id, { prNumber: pr });

        if (task.prNumber === null) {
          if (profile.land === "pr" && project.gitRemoteUrl !== null && profile.build === "worktree") {
            return fail("No PR yet: open_pr first.");
          }
          // A task that never built (an adopted PR) has no claims to hold its branch to.
          if (task.buildRequest !== null && task.worktreePath !== null && task.branch !== null) {
            const state = await host.call(
              "worktreeState",
              { worktreePath: task.worktreePath, baseRef: task.baseRef ?? "origin/main" },
              { hostId: source.hostId, timeoutMs: 90_000 },
            );
            const outside = outsideClaims(state.files, store.claimsFor(task.id), profile);
            if (outside.length > 0) return fail(outsideClaimsRefusal(outside));
          }
          const list = deriveTestList({ files: [], body: "", profile, extra: testList });
          store.openReview(task.id);
          changed(store.updateTask(task.id, { stage: "you", buildState: "none", testList: list, verdict: { kind: "ready", reasons: [], headSha: null, at: Date.now() } }));
          return text(`Handed ${task.id} to ${owner()} (no PR in ${project.name}). Test list:\n- ${list.join("\n- ") || "(none)"}`);
        }

        const facts: PrFacts = await host.call(
          "prFacts",
          { repoPath: source.path, number: task.prNumber },
          { hostId: source.hostId, timeoutMs: 60_000 },
        );
        if (task.branch === null) task = store.updateTask(task.id, { branch: facts.headRefName, prUrl: facts.url });
        // Before validatePr: a refusal must come before ai-tests is added.
        if (task.buildRequest !== null) {
          const outside = outsideClaims(facts.files, store.claimsFor(task.id), profile);
          if (outside.length > 0) return fail(outsideClaimsRefusal(outside));
        }
        const verdict = validatePr(facts, profile, task.labelledSha ?? null);
        const record = { kind: verdict.kind, reasons: verdict.reasons, headSha: facts.headRefOid, at: Date.now() };

        if (verdict.kind === "add_label" && profile.aiTestsLabel !== null) {
          await host.call(
            "applyLabel",
            { repoPath: source.path, number: facts.number, label: profile.aiTestsLabel, readd: verdict.readd },
            { hostId: source.hostId, timeoutMs: 60_000 },
          );
          store.closeReview(task.id);
          changed(store.updateTask(task.id, { stage: "pr", labelledSha: facts.headRefOid, verdict: { ...record, kind: "waiting", reasons: [`${profile.aiTestsLabel} ${verdict.readd ? "re-added" : "added"} on ${facts.headRefOid.slice(0, 7)}; its run is in progress.`] } }));
          return text(`${verdict.reasons.join(" ")}\nDone: ${profile.aiTestsLabel} ${verdict.readd ? "re-added" : "added"}. CI re-runs with the AI tests. Nothing may be pushed now; call ready_for_review again when checks finish.`);
        }
        if (verdict.kind !== "ready") {
          // Not ready now means no merge ask: an earlier hand-off is void.
          if (verdict.kind !== "closed") store.closeReview(task.id);
          changed(store.updateTask(task.id, { stage: verdict.kind === "closed" ? task.stage : "pr", verdict: record }));
          return text(`Not ready (${verdict.kind}) for ${facts.headRefOid.slice(0, 7)}:\n- ${verdict.reasons.join("\n- ")}`);
        }
        const gap = profile.land === "pr" ? howToOpenGap(testList) : null;
        if (gap !== null) return fail(`Ready for ${facts.headRefOid.slice(0, 7)}, but not handed to ${owner()}: ${gap} Fix the list and call ready_for_review again.`);
        const list = deriveTestList({ files: facts.files, body: facts.body, profile, extra: testList });
        store.openReview(task.id);
        changed(
          store.updateTask(task.id, {
            stage: "you",
            verdict: record,
            verifiedSha: facts.headRefOid,
            testList: list,
          }),
        );
        return text(
          `PR #${facts.number} is proven for ${facts.headRefOid.slice(0, 7)} and is with ${owner()}. Their test list:\n- ${list.join("\n- ") || "(nothing beyond CI)"}\nDo not push to it now; merging is ${owners()}.`,
        );
      } catch (error) {
        return fail(`Could not validate: ${describeError(error)}`);
      }
    },
  });

  bb.agents.registerTool({
    name: "task_status",
    description:
      `The dossier: this chat's project's open tasks in one line each, or one of its tasks in full (claims, decisions, questions and ${owners()} answers, research summaries, PR verdict, test list). Also which project this chat is for, the build slots and Claude usage, shared by every project.`,
    parameters: z.object({ task: z.string().max(40).optional() }),
    presentation: { label: { pending: "Reading the dossier", completed: "Read the dossier" }, suppress: true },
    async execute({ task: arg }, ctx) {
      const who = caller(ctx.threadId);
      if (who === null) return fail("Only Patches and task threads can read the dossier.");
      const projects = await allProjects();
      const name = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
      const wanted = who.kind === "task" ? who.task.id : arg;
      const tickets = store.tickets({ status: "all" });
      if (wanted !== undefined && wanted !== "") {
        const task = store.task(wanted);
        if (task === null) return fail(`No task ${wanted}.`);
        if (who.kind === "orchestrator") {
          const refusal = chatRefusal(who.projectId, task, name(task.projectId));
          if (refusal !== null) return fail(refusal);
        }
        return text(
          taskDetail(task, {
            projectName: name(task.projectId),
            claims: store.claimsFor(task.id),
            tickets,
            children: store.children().filter((c) => c.taskId === task.id),
          }) +
            releasesDetail(task.id) +
            withdrawalsDetail(task.id),
        );
      }
      const open = store.tasks({ includeClosed: false });
      const chatProject = who.kind === "orchestrator" ? who.projectId : who.task.projectId;
      // A chat lists its own project's tasks; the build slots and usage are every project's.
      const listed = chatTasks(open, chatProject);
      return text(
        [
          `This chat: ${name(chatProject)}`,
          `Builds in flight: ${buildsInFlight(open).length}/${BUILD_CAP}`,
          usageLine(),
          listed.length === 0 ? "No open tasks." : dossierSummary(listed, tickets, null, 6000),
        ].join("\n"),
      );
    },
  });

  /** The task's release history for task_status: when its claims went back, why, and by whom. */
  function releasesDetail(id: string): string {
    const releases = store.releases(id);
    if (releases.length === 0) return "";
    return `\nreleases:\n${releases
      .map((r) => `  - ${new Date(r.at).toISOString()} by ${r.by}${r.closed ? ", closed" : ""}: ${r.reason} (${r.paths.length > 0 ? r.paths.join(", ") : "no claims"})`)
      .join("\n")}`;
  }

  /** The task's withdrawn questions for task_status: when, by whom, which, and why. */
  function withdrawalsDetail(id: string): string {
    const withdrawals = store.withdrawals(id);
    if (withdrawals.length === 0) return "";
    return `\nwithdrawals:\n${withdrawals
      .map((w) => `  - ${new Date(w.at).toISOString()} by ${w.by}, ${w.ticketId}: ${w.reason} (${w.questions.length > 0 ? w.questions.join(" | ") : "no questions"})`)
      .join("\n")}`;
  }

  bb.agents.registerTool({
    name: "release_task",
    description:
      "Patches only. Give a task's claims and build slot back, with the reason recorded in the dossier; close: true also closes the task, refused while it has an open questions or report ticket (withdraw it first, with a reason). Claims release themselves when the task's PR merges or closes, or its branch is gone with its commits on the default branch; use this only when that cannot see it (work merged some other way, an abandoned task).",
    parameters: z.object({
      task: z.string().min(1).max(40).describe("Task id."),
      reason: z.string().min(10).max(2000).describe("Why, with the evidence you checked (PR, commit, branch)."),
      close: flag().default(false).describe("Also close the task."),
    }),
    presentation: { label: { pending: "Releasing a task's claims", completed: "Released a task's claims" } },
    async execute({ task: id, reason, close }, ctx) {
      const who = caller(ctx.threadId);
      if (who?.kind !== "orchestrator") return fail("Only Patches releases claims.");
      const task = store.task(id);
      if (task === null) return fail(`No task ${id}.`);
      const refusal = chatRefusal(who.projectId, task, projectNames.get(task.projectId) ?? task.projectId);
      if (refusal !== null) return fail(refusal);
      if (task.closedAt !== null) return fail(`${task.id} is already closed.`);
      if (close) {
        const refused = releaseCloseRefusal(store.tickets({ status: "open" }).filter((ticket) => ticket.taskId === task.id));
        if (refused !== null) return fail(`Not closed: ${refused}`);
      }
      const paths = store.releaseTask(task.id, { reason, by: "patches", close });
      if (close) {
        store.setMeta(stepsKey(task.id), null);
        // Closed by Patches, not by a land the dossier saw: given up, for the outcome comparison.
        noteOutcomes(task.id, "abandoned");
        void cleanupWorktree(task.id);
      }
      changed(store.task(task.id) ?? task);
      return text(
        `Released ${paths.length} claim${paths.length === 1 ? "" : "s"}${paths.length > 0 ? ` (${paths.join(", ")})` : ""} from ${task.id}${close ? " and closed it" : ""}.`,
      );
    },
  });

  // One agent in the owner's Chrome at a time: browser.ts decides, the dossier holds
  // the lease, and the events below release it when the holder's pass ends.
  bb.agents.registerTool({
    name: "browser",
    description:
      `Call before any mcp__claude-in-chrome__* call: acquire the one browser lease (only one agent uses ${owners()} Chrome at a time), release it once your tabs are closed. Told to wait: do non-browser work, or end your pass saying so.`,
    parameters: z.object({ action: z.enum(["acquire", "release"]) }),
    presentation: { label: { pending: "Browser lease", completed: "Browser lease" } },
    async execute({ action }, ctx) {
      const who = caller(ctx.threadId);
      const child = store.child(ctx.threadId);
      const owner = who?.kind === "task" ? who.task : child !== null && child.kind === "research" ? store.task(child.taskId) : null;
      if (who === null && owner === null) return fail("Only Patches, tasks and research threads use the browser; builders never do.");
      if (action === "release") {
        return text(store.releaseBrowserLease(ctx.threadId) ? "Released the browser." : "You did not hold the browser.");
      }
      const lease = store.browserLease();
      const decision = leaseDecision({ lease, threadId: ctx.threadId, now: Date.now() });
      if (decision.action === "wait") {
        const held = holds.get(ctx.threadId);
        holds.set(ctx.threadId, {
          kind: "browser",
          reason: `${lease?.taskId ?? lease?.holderThreadId ?? "another agent"} has it`,
          since: held?.kind === "browser" ? held.since : Date.now(),
        });
        return text(decision.reason);
      }
      if (holds.get(ctx.threadId)?.kind === "browser") holds.delete(ctx.threadId);
      store.acquireBrowserLease(ctx.threadId, owner?.id ?? null);
      return text(
        decision.action === "granted"
          ? "The browser is yours. At most 3 tabs of your own; close them all, then browser release, before your pass ends."
          : "You already hold the browser (renewed).",
      );
    },
  });

  function releaseBrowserFor(threadId: string) {
    if (store.releaseBrowserLease(threadId)) bb.log.info(`browser lease released by ${threadId}`);
  }

  // ------------------------------------------------------------- configure
  const ORCHESTRATOR_TOOLS = ["start_task", "research", "build", "ask_sam", "submit_report", "open_pr", "land", "ready_for_review", "release_task", "task_status", "browser"];
  const TASK_TOOLS = ["research", "build", "ask_sam", "submit_report", "open_pr", "land", "ready_for_review", "task_status", "browser"];
  const RESEARCH_TOOLS = ["browser"];

  bb.agents.configure((context) => {
    const none = { tools: [], skills: [] };
    if (context.origin.kind === "fork") return none;
    let chat = chatOf(context.thread.id);
    if (chat === null) {
      const claimed = claimedChat({
        role: context.pluginMetadata.role,
        metadataProjectId: context.pluginMetadata.projectId,
        projectId: context.project.id,
        projectKind: context.project.kind,
      });
      if (claimed !== null && chatThread(claimed.projectId) === null) {
        registerChat(claimed.projectId, context.thread.id);
        chat = claimed;
      }
    }
    if (chat !== null) {
      // A chat sees only its own project's open tasks; the build cap stays shared.
      const tasks = chatTasks(store.tasks({ includeClosed: false }), chat.projectId);
      const summary = dossierSummary(tasks, store.tickets({ status: "open" }), null);
      const scope = {
        projectName: context.project.name,
        profile: profileOf({ name: context.project.name, gitRemoteUrl: context.project.gitRemoteUrl }),
        chromeAccount: localConfig.config.chromeAccount ?? null,
      };
      return { tools: ORCHESTRATOR_TOOLS, skills: [], instructions: patchesInstructions(summary, scope) };
    }
    // bb configures a thread while it is being spawned, before the dossier
    // has its id: roles.ts falls back to the metadata it was spawned with.
    const role = threadRole({
      threadId: context.thread.id,
      parentThreadId: context.thread.parentThreadId,
      metadata: context.pluginMetadata,
      taskByThread: store.taskByThread(context.thread.id),
      child: store.child(context.thread.id),
      task: (id) => store.task(id),
    });
    if (role === null) return none;
    const profile = profileOf({ name: context.project.name, gitRemoteUrl: context.project.gitRemoteUrl });
    if (role.kind === "task") {
      return { tools: TASK_TOOLS, skills: [], instructions: taskInstructions(role.task, context.project.name, profile, localConfig.config.chromeAccount ?? null) };
    }
    return {
      tools: role.kind === "build" ? [] : RESEARCH_TOOLS,
      skills: [],
      instructions: role.kind === "build" ? builderInstructions(role.owner, profile) : researchInstructions(role.owner, localConfig.config.chromeAccount ?? null),
    };
  });

  // ---------------------------------------------------------------- events
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    const chat = chatOf(thread.id);
    if (chat !== null) {
      // Patches answered: unread on this chat's project until the owner shows it.
      store.setMeta(replyAtKey(chat.projectId), String(Date.now()));
      publish();
      return;
    }
    if (lastAssistantText === null) return;
    const summary = lastAssistantText.trim().slice(-1500);
    const child = store.child(thread.id);
    if (child !== null) {
      store.setChildSummary(thread.id, summary);
      publish();
      return;
    }
    const task = store.taskByThread(thread.id);
    if (task !== null && task.closedAt === null) {
      const last = summary.split("\n").map((line) => line.trim()).filter(Boolean).pop() ?? null;
      changed(store.updateTask(task.id, { note: last === null ? null : last.slice(0, 300) }));
      store.setMeta(reportKey(task.id), lastAssistantText.trim().slice(0, REPORT_MAX));
      store.setMeta(idleKey(task.id), String(Date.now()));
      void checkLanded(task.projectId, true);
    }
  });

  // A failure the dossier does not record is one Patches has to dig for.
  // A turn that failed on a usage limit is not an error: it resumes after the
  // reset (usage section below). turn.failed says so, in either order with
  // this event, so the failure settles first. Nor is one that failed because
  // Claude is signed out (sign-in section below): it waits for the owner.
  bb.events.on("thread.failed", ({ thread, error }) => {
    const timer = setTimeout(() => {
      settling.delete(timer);
      void limitWaiting(thread.id).then((waiting) => {
        if (waiting) bb.log.info(`${thread.id} failed on the usage limit: waiting for the reset, not an error`);
        else if (signInWaiting(thread.id, error)) bb.log.info(`${thread.id} failed because Claude is signed out: waiting for ${owner()} to sign in, not an error`);
        else threadFailed(thread, error);
      });
    }, LIMIT_SETTLE_MS);
    settling.add(timer);
  });
  const settling = new Set<ReturnType<typeof setTimeout>>();
  bb.onDispose(() => {
    for (const timer of settling) clearTimeout(timer);
  });

  function threadFailed(thread: { id: string }, error: string | null) {
    const reason = `${ERROR_SUMMARY_PREFIX} ${(error ?? "no message").split("\n")[0]?.slice(0, 240)}`;
    const task = store.taskByThread(thread.id);
    if (task !== null && task.closedAt === null) {
      changed(store.updateTask(task.id, { note: reason }));
      return;
    }
    const child = store.child(thread.id);
    if (child !== null) {
      store.setChildSummary(thread.id, reason);
      const owner = store.task(child.taskId);
      if (owner === null || owner.closedAt !== null) return;
      const latestBuild = store
        .children()
        .filter((c) => c.taskId === owner.id && c.kind === "build")
        .pop();
      if (child.kind === "build" && owner.buildState === "running" && latestBuild?.threadId === thread.id) {
        // A dead builder must not hold a build slot: it is a failed build, the task's to fix.
        void failBuildFor(owner.id, `The builder ${reason.toLowerCase()}`, true, null);
        return;
      }
      changed(store.updateTask(owner.id, { note: `${child.kind === "build" ? "Builder" : "Research"} ${reason.toLowerCase()}` }));
    }
  }

  bb.events.on("thread.archived", ({ thread }) => {
    const chat = chatOf(thread.id);
    if (chat !== null) {
      // Its tasks are re-attached to a live chat by the next beat (reattachTasks).
      clearChat(chat.projectId);
      publish();
      void checkLiveness();
      return;
    }
    const task = store.taskByThread(thread.id);
    if (task === null || task.closedAt !== null) return;
    closeTask(task.id, "Task thread archived.", "abandoned");
    publish();
    void cleanupWorktree(task.id);
  });

  // ----------------------------------------------------------- memory guard
  // guard.ts runs it, memory.ts decides it. Here: what an agent is, how to
  // read memory and stop an agent, and the hook, events and timer.
  function agentRole(thread: { id: string; originPluginId?: string | null; parentThreadId?: string | null }): AgentRole | null {
    if (chatOf(thread.id) !== null) return null;
    const child = store.child(thread.id);
    if (child !== null) return child.kind === "build" ? "build" : "research";
    if (store.taskByThread(thread.id) !== null) return "task";
    // Spawned by this plugin under a parent but not recorded yet: spawn()
    // records the thread only after it returns, and its first turn is decided
    // before that. Count it as an agent rather than let it slip past.
    if (thread.originPluginId === bb.pluginId && (thread.parentThreadId ?? null) !== null) return "task";
    return null;
  }

  async function stopForMemory(victim: RunningAgent, reading: MemoryReading) {
    const message = stoppedMessage(victim, reading);
    kills.set(victim.threadId, { reason: `stopped, the Mac was down to ${describeReading(reading)}`, at: Date.now() });
    releaseBrowserFor(victim.threadId);
    try {
      await bb.sdk.threads.stop({ threadId: victim.threadId });
    } catch (error) {
      bb.log.warn(`memory guard: stop ${victim.threadId} failed: ${describeError(error)}`);
    }
    const child = store.child(victim.threadId);
    const task = child !== null ? store.task(child.taskId) : store.taskByThread(victim.threadId);
    if (task === null || task.closedAt !== null) return;
    if (victim.role === "build" && task.worktreePath !== null) {
      // A stopped turn can leave its commands running (a dev server, a test
      // watcher): kill whatever still runs inside the worktree.
      try {
        const source = sourceOf(await projectById(task.projectId));
        if (source !== null) {
          await host.call(
            "killWorktreeProcesses",
            { repoPath: source.path, worktreePath: task.worktreePath },
            { hostId: source.hostId, timeoutMs: 30_000 },
          );
        }
      } catch (error) {
        bb.log.warn(`memory guard: killing processes in ${task.worktreePath} failed: ${describeError(error)}`);
      }
      if (task.buildState === "running" || task.buildState === "preparing") {
        await failBuildFor(task.id, message, true, null);
        return;
      }
    }
    changed(store.updateTask(task.id, { note: `Stopped for memory: ${describeReading(reading)}` }));
    if (task.threadId !== null) await tellThread(task.threadId, message).catch(() => undefined);
  }

  /** A killed process's BB_THREAD_ID → that thread (if it is ours) and its task, with a note. */
  async function tellProcessOwner(threadId: string, message: string) {
    kills.set(threadId, { reason: "one of its processes was killed for memory", at: Date.now() });
    const child = store.child(threadId);
    const task = child !== null ? store.task(child.taskId) : store.taskByThread(threadId);
    if (task === null || task.closedAt !== null) {
      bb.log.warn(`memory guard: killed a process of ${threadId}, which is no open task's thread; logged only`);
      return;
    }
    changed(store.updateTask(task.id, { note: message.slice(0, 300) }));
    if (child !== null) await tellThread(threadId, message).catch(() => undefined);
    if (task.threadId !== null) await tellThread(task.threadId, message);
  }

  const guard = createMemoryGuard({
    roleOf: agentRole,
    hosts: async () => {
      const ids = new Set<string>();
      for (const project of await allProjects()) {
        const source = sourceOf(project);
        if (source !== null) ids.add(source.hostId);
      }
      return [...ids];
    },
    readMemory: (hostId) => host.call("memoryStatus", {}, { hostId, timeoutMs: 20_000 }),
    runningIds: async () => (await bb.sdk.threads.listRunning()).map((t) => t.id),
    thread: async (id) => {
      try {
        return await bb.sdk.threads.get({ threadId: id });
      } catch {
        return null;
      }
    },
    stop: stopForMemory,
    killProcess: async (hostId, victim, target) =>
      host.call("killProcess", { pid: victim.pid, command: victim.command, target }, { hostId, timeoutMs: 30_000 }),
    tellOwner: tellProcessOwner,
    recheck: () => {
      void bb.experimental_hooks.recheck("message.dispatch").catch((error: unknown) => {
        bb.log.warn(`memory guard: recheck failed: ${describeError(error)}`);
      });
    },
    warn: (message) => bb.log.warn(message),
    info: (message) => bb.log.info(message),
    now: () => Date.now(),
  });

  bb.experimental_hooks.on("message.dispatch", (context) => {
    // A throw here would fail the turn outright; waiting is the safe answer.
    try {
      const id = context.thread.id;
      const held = holds.get(id);
      const signIn = signInDecision(context);
      if (signIn !== null) {
        // The memory wait wins when both apply; signInDecision claims no agent slot.
        if (signIn.memory) holds.set(id, { kind: "memory", reason: signIn.decision.reason.slice(0, 200), since: held?.kind === "memory" ? held.since : Date.now() });
        else holds.set(id, { kind: "signed-out", reason: signinHoldReason(), since: Date.now() });
        return signIn.decision;
      }
      if (held?.kind === "signed-out") holds.delete(id);
      const decision = guard.decide(context);
      if (decision.action === "wait") {
        holds.set(id, { kind: "memory", reason: decision.reason.slice(0, 200), since: held?.kind === "memory" ? held.since : Date.now() });
      } else if (held?.kind === "memory") {
        holds.delete(id);
      }
      return decision;
    } catch (error) {
      bb.log.warn(`memory guard: dispatch decision failed: ${describeError(error)}`);
      return {
        action: "wait",
        reason: `The Orchestrator: the memory guard hit an error (${describeError(error)}).`,
        sendAt: Date.now() + WAIT_RETRY_MS,
      };
    }
  });
  bb.events.on("thread.active", ({ thread }) => {
    guard.onActive(thread);
    // Working again: the memory hold is over and an earlier kill is history.
    const hold = holds.get(thread.id)?.kind;
    if (hold === "memory" || hold === "signed-out") holds.delete(thread.id);
    kills.delete(thread.id);
  });
  for (const event of ["thread.idle", "thread.failed", "thread.archived"] as const) {
    bb.events.on(event, ({ thread }) => {
      guard.onDone(thread.id);
      holds.delete(thread.id);
      // The pass ended: its browser lease goes back, tabs closed or not.
      releaseBrowserFor(thread.id);
    });
  }
  const memoryTimer = setInterval(() => void guard.tick(), WATCHDOG_INTERVAL_MS);
  // Not during registration: host calls fail there ("unavailable during
  // factory registration"), which is what every load logged before.
  const firstTick = setTimeout(() => void guard.tick(), FIRST_HOST_CALL_MS);
  bb.onDispose(() => {
    clearInterval(memoryTimer);
    clearTimeout(firstTick);
  });

  // ------------------------------------------------------------ usage limits
  // usage.ts decides. Here: read Claude usage on the liveness beat (cached by
  // the provider; a fresh reading at most every 5 min), record each of our
  // agents' limit hits in the dossier, and after the reset make sure each one
  // came back: provider-retry's queued row, else one re-queue of our own.
  const LIMIT_HITS_KEY = "usage_limit_hits";
  const PAUSED_KEY = "usage_paused_starts";
  /** turn.failed and thread.failed arrive in either order: a failure waits this long before it counts as an error. */
  const LIMIT_SETTLE_MS = 5_000;
  let usageReading: UsageReading | null = null;
  let usageResourceId: string | null = null;
  let usageRefreshAt: number | null = null;

  const currentUsage = () => usageView(usageReading, Date.now());
  const usageLine = () => {
    const usage = usageStatusLine(currentUsage(), Date.now());
    const signIn = signInStatusLine(signInRecords());
    return signIn === null ? usage : `${signIn}\n${usage}`;
  };

  function readJson<T>(key: string): T[] {
    try {
      const value = JSON.parse(store.getMeta(key) ?? "[]") as unknown;
      return Array.isArray(value) ? (value as T[]) : [];
    } catch {
      return [];
    }
  }
  const limitHits = () => readJson<LimitHit>(LIMIT_HITS_KEY);
  const saveHits = (hits: readonly LimitHit[]) => store.setMeta(LIMIT_HITS_KEY, JSON.stringify(hits));
  const pausedStarts = () => readJson<PausedStart>(PAUSED_KEY);

  const usageResources = z.object({ resources: z.array(z.object({ id: z.string(), providerId: z.string() }).passthrough()) }).passthrough();

  /** One reading from provider-claude-code; keeps the last good one when this fails. */
  async function readUsage() {
    try {
      if (usageResourceId === null) {
        const { resources } = await bb.sdk.plugins.callRpc({
          pluginId: CLAUDE_USAGE_PLUGIN,
          method: USAGE_LIST_METHOD,
          input: {},
          outputSchema: usageResources,
          signal: AbortSignal.timeout(20_000),
        });
        usageResourceId = resources.find((resource) => resource.providerId === "claude-code")?.id ?? null;
        if (usageResourceId === null) return;
      }
      const now = Date.now();
      // Signed out: a fresh reading once a minute, since an ok one says sign-in works again.
      const forced = wantsSignInRefresh({ records: signInRecords(), lastRefreshAt: signInRefreshAt, now });
      if (forced) signInRefreshAt = now;
      const refresh = forced || wantsRefresh({ observedAt: usageReading?.observedAt ?? null, lastRefreshAt: usageRefreshAt, now });
      if (refresh) usageRefreshAt = now;
      const raw = await bb.sdk.plugins.callRpc({
        pluginId: CLAUDE_USAGE_PLUGIN,
        method: USAGE_GET_METHOD,
        input: { resourceId: usageResourceId, refresh },
        outputSchema: z.unknown(),
        signal: AbortSignal.timeout(refresh ? 45_000 : 20_000),
      });
      const reading = parseUsage(raw);
      if (reading !== null) {
        usageReading = reading;
        usageOkAt = reading.observedAt;
      }
    } catch (error) {
      // A removed resource fails the RPC: list again next beat.
      usageResourceId = null;
      bb.log.warn(`usage: reading Claude usage failed: ${describeError(error)}`);
    }
  }

  /** A new build or research near the limit: refused, and remembered so the task hears when it may start. */
  function usagePause(task: Task, kind: StartKind): string | null {
    const refusal = startRefusal(currentUsage(), kind, Date.now());
    if (refusal === null || task.threadId === null) return refusal;
    store.setMeta(PAUSED_KEY, JSON.stringify(addPaused(pausedStarts(), { taskId: task.id, threadId: task.threadId, kind, at: Date.now() })));
    bb.log.info(`usage: paused ${task.id}'s ${kind}: ${refusal.slice(0, 160)}`);
    return refusal;
  }

  /** The window has room again: each paused task hears it once. */
  async function wakePaused() {
    const paused = pausedStarts();
    const view = currentUsage();
    if (paused.length === 0 || !mayWake(view) || view === null) return;
    store.setMeta(PAUSED_KEY, "[]");
    for (const threadId of new Set(paused.map((entry) => entry.threadId))) {
      const mine = paused.filter((entry) => entry.threadId === threadId);
      const task = store.task(mine[0]?.taskId ?? "");
      if (task === null || task.closedAt !== null) continue;
      bb.log.info(`usage: waking ${task.id}: the window has room again`);
      await tellThread(threadId, wakeMessage(mine, view)).catch((error: unknown) => {
        bb.log.warn(`usage: waking ${task.id} failed: ${describeError(error)}`);
      });
    }
  }

  function hitRole(threadId: string): { role: HitRole; taskId: string | null } | null {
    if (chatOf(threadId) !== null) return { role: "chat", taskId: null };
    const child = store.child(threadId);
    if (child !== null) return { role: child.kind, taskId: child.taskId };
    const task = store.taskByThread(threadId);
    return task !== null && task.closedAt === null ? { role: "task", taskId: task.id } : null;
  }

  // Every failed turn: ours and on a usage limit, it is recorded until it is back.
  bb.events.on("turn.failed", (failure) => {
    const hit = limitHitOf(failure);
    if (hit === null) return;
    const who = hitRole(failure.threadId);
    if (who === null) return;
    saveHits(recordHit(limitHits(), { threadId: failure.threadId, requestId: failure.requestId, resetsAt: hit.resetsAt, ...who }, Date.now()));
    const until = hit.resetsAt === null ? "the reset" : clock(hit.resetsAt, Date.now());
    bb.log.info(`usage: ${failure.threadId} (${who.role}${who.taskId === null ? "" : ` of ${who.taskId}`}) hit the usage limit; back after ${until}`);
    if (who.taskId !== null) {
      const task = store.task(who.taskId);
      if (task !== null && task.closedAt === null) {
        const role = who.role === "task" ? "Task" : who.role === "build" ? "Builder" : "Research";
        changed(store.updateTask(task.id, { note: `${role} paused by the usage limit; resumes after ${until}` }));
      }
    }
  });

  /** The retry rows bb holds, by thread: when each is sent, and whether it is a usage-limit retry. */
  function retriesOf(rows: readonly { threadId: string; sendAt: number | null; payload: { kind: string; reason?: string } }[]) {
    const retries = new Map<string, LimitWait>();
    for (const row of rows) {
      if (row.payload.kind !== "retry" || retries.has(row.threadId)) continue;
      const backoff = row.payload.reason === "Provider overloaded" || row.payload.reason === SIGNIN_RETRY_REASON;
      retries.set(row.threadId, { kind: backoff ? "retry" : "usage-limit", until: row.sendAt });
    }
    return retries;
  }

  /** Whether a failed thread is waiting out a usage limit rather than stuck. */
  async function limitWaiting(threadId: string): Promise<boolean> {
    if (limitHits().some((hit) => hit.threadId === threadId)) return true;
    try {
      return retriesOf(await bb.sdk.threads.queue.list({ threadId })).has(threadId);
    } catch {
      return false;
    }
  }

  /** After the reset: each hit came back, is re-queued once, or its task hears it did not. */
  async function resumeHits(retries: ReadonlyMap<string, LimitWait>) {
    const hits = limitHits();
    if (hits.length === 0) return;
    const fallback = currentUsage()?.resetsAt ?? null;
    // turn.failed may record hits while this awaits: apply only what this
    // pass decided, to the hit it looked at (same request), at the end.
    const dropped = new Set<string>();
    const requeued = new Map<string, number>();
    const drop = (hit: LimitHit) => dropped.add(`${hit.threadId}:${hit.requestId}`);
    for (const hit of hits) {
      let status: ProbeStatus;
      try {
        const thread = await bb.sdk.threads.get({ threadId: hit.threadId });
        status = thread.archivedAt !== null || thread.deletedAt !== null ? "gone" : thread.status;
      } catch (error) {
        if (!notFound(error)) continue;
        status = "gone";
      }
      const step = resumeStep({ hit, status, retryQueued: retries.has(hit.threadId), fallbackResetAt: fallback, now: Date.now() });
      if (step.kind === "wait") continue;
      if (step.kind === "resumed") {
        drop(hit);
        bb.log.info(`usage: ${hit.threadId} (${hit.role}) is back after the usage limit (${status})`);
        continue;
      }
      if (step.kind === "requeue") {
        try {
          await bb.sdk.threads.retry({ threadId: hit.threadId, turnRequestId: hit.requestId, reason: "The Orchestrator: usage limit reset" });
          requeued.set(`${hit.threadId}:${hit.requestId}`, Date.now());
          bb.log.info(`usage: re-queued ${hit.threadId} (${hit.role}): nothing brought it back after the reset`);
          continue;
        } catch (error) {
          bb.log.warn(`usage: re-queueing ${hit.threadId} failed: ${describeError(error)}`);
          await giveUp(hit, `re-queueing its turn failed: ${describeError(error)}`);
          drop(hit);
          continue;
        }
      }
      await giveUp(hit, "its re-queued turn did not run");
      drop(hit);
    }
    if (dropped.size === 0 && requeued.size === 0) return;
    saveHits(
      limitHits()
        .filter((hit) => !dropped.has(`${hit.threadId}:${hit.requestId}`))
        .map((hit) => {
          const at = requeued.get(`${hit.threadId}:${hit.requestId}`);
          return at === undefined ? hit : { ...hit, requeuedAt: at };
        }),
    );
  }

  /**
   * A hit that did not come back. A builder's build fails (the task's to fix);
   * research tells its task. A task thread or a Patches chat is left in error,
   * where liveness shows it: Needs you with Restart, or the chat's alert line.
   */
  async function giveUp(hit: LimitHit, why: string) {
    bb.log.warn(`usage: ${hit.threadId} (${hit.role}) did not resume after the usage limit: ${why}`);
    const task = hit.taskId === null ? null : store.task(hit.taskId);
    if (task === null || task.closedAt !== null) return;
    const latestBuild = store.children().filter((child) => child.taskId === task.id && child.kind === "build").pop();
    if (hit.role === "build" && task.buildState === "running" && latestBuild?.threadId === hit.threadId) {
      await failBuildFor(task.id, `The builder ${hit.threadId} stopped at the usage limit and did not resume after the reset (${why}).`, true, null);
      return;
    }
    if (hit.role === "research" && task.threadId !== null) {
      await tellThread(task.threadId, notResumedMessage(hit, why)).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- sign-in
  // signin.ts decides. Here: record each of our agents' turns that failed
  // because Claude is signed out, hold new turns and starts meanwhile, and on
  // the liveness beat see whether sign-in works again: then retry each failed
  // turn once, wake the paused starts and release the held turns.
  const SIGNIN_KEY = "signin_failures";
  const SIGNIN_PAUSED_KEY = "signin_paused_starts";
  /** When a Claude turn of ours last completed; in memory only (the usage reading covers a reload). */
  let turnOkAt: number | null = null;
  /** The observedAt of the last usage reading with status ok. */
  let usageOkAt: number | null = null;
  let signInRefreshAt: number | null = null;

  const signInRecords = () => readJson<SignedOut>(SIGNIN_KEY);
  const saveSignIn = (records: readonly SignedOut[]) => store.setMeta(SIGNIN_KEY, JSON.stringify(records));

  /** A failed thread's last provider/error or system/error, as "message: detail"; null when unreadable. */
  async function failureText(threadId: string): Promise<string | null> {
    try {
      const [event] = await bb.sdk.threads.events.list({ threadId, order: "desc", limit: "1", types: ["provider/error", "system/error"] });
      const data = (event as { data?: { message?: unknown; detail?: unknown } } | undefined)?.data;
      if (typeof data?.message !== "string") return null;
      return typeof data.detail === "string" && data.detail !== "" ? `${data.message}: ${data.detail}` : data.message;
    } catch (error) {
      bb.log.warn(`signin: reading ${threadId}'s last error failed: ${describeError(error)}`);
      return null;
    }
  }

  /** One of our threads failed on sign-in: recorded until it is back, and its task's note says so. */
  function noteSignedOut(threadId: string, requestId: string | null) {
    const who = hitRole(threadId);
    if (who === null) return false;
    const before = signInRecords();
    saveSignIn(recordSignedOut(before, { threadId, requestId, ...who }, Date.now()));
    bb.log.warn(`signin: ${threadId} (${who.role}${who.taskId === null ? "" : ` of ${who.taskId}`}) failed because Claude is signed out; waiting for ${owner()} to sign in`);
    if (who.taskId !== null) {
      const task = store.task(who.taskId);
      if (task !== null && task.closedAt === null) changed(store.updateTask(task.id, { note: "Paused: Claude is signed out" }));
    }
    publish();
    return true;
  }

  // Every failed turn: ours and on sign-in, it is recorded until it is back.
  // turn.failed carries the category but no text, so the thread's last error
  // event is read too.
  bb.events.on("turn.failed", (failure) => {
    if (limitHitOf(failure) !== null) return;
    void (async () => {
      const text = failure.errorInfo?.category === "unauthorized" ? null : await failureText(failure.threadId);
      if (signedOutOf({ errorInfo: failure.errorInfo, text })) noteSignedOut(failure.threadId, failure.requestId);
    })().catch((error: unknown) => bb.log.warn(`signin: reading ${failure.threadId}'s failure failed: ${describeError(error)}`));
  });

  /** Whether a failed thread is waiting for the owner to sign in rather than stuck; thread.failed's own text counts when turn.failed said nothing. */
  function signInWaiting(threadId: string, error: string | null): boolean {
    const record = signInRecords().find((entry) => entry.threadId === threadId);
    if (record !== undefined && isWaiting(record)) return true;
    if (!signedOutOf({ errorInfo: null, text: error })) return false;
    return noteSignedOut(threadId, null);
  }

  // A Claude turn of ours that completed (not one that was stopped) says sign-in works.
  bb.events.on("thread.idle", ({ thread }) => {
    if (!isSignedOut(signInRecords()) || hitRole(thread.id) === null) return;
    void (async () => {
      const [event] = await bb.sdk.threads.events.list({ threadId: thread.id, order: "desc", limit: "1", types: ["turn/completed"] });
      const status = (event as { data?: { status?: unknown } } | undefined)?.data?.status;
      if (event === undefined || status !== "completed") return;
      turnOkAt = Math.max(turnOkAt ?? 0, event.createdAt);
      await checkLiveness();
    })().catch((error: unknown) => bb.log.warn(`signin: reading ${thread.id}'s last turn failed: ${describeError(error)}`));
  });

  /**
   * The dispatch hook's answer while signed out, or null to decide as usual.
   * Only our own agents and chats wait, and never the owner's own messages. The
   * memory decision is made without guard.decide, which would claim a slot
   * for a turn that is not going to run.
   */
  function signInDecision(context: MessageDispatchHookContext): { decision: Extract<MessageDispatchHookDecision, { action: "wait" }>; memory: boolean } | null {
    const sentBySam = context.initiator === "user" && context.senderThreadId === null;
    const reason = signInHold(signInRecords(), sentBySam);
    const role = agentRole(context.thread);
    if (reason === null || (role === null && chatOf(context.thread.id) === null)) return null;
    const now = Date.now();
    if (role !== null) {
      const memory = dispatchDecision({
        attempt: context.attempt,
        sentBySam,
        threadId: context.thread.id,
        active: new Set(guard.activeIds()),
        reading: guard.readingFor(context.host?.id),
        now,
      });
      if (memory.action === "wait") return { decision: { action: "wait", reason: memory.reason, sendAt: now + WAIT_RETRY_MS }, memory: true };
    }
    return { decision: { action: "wait", reason, sendAt: now + WAIT_RETRY_MS }, memory: false };
  }

  /** A new build or research while signed out: refused, and remembered so the task hears when it may start. */
  function signInPause(task: Task, kind: StartKind): string | null {
    const refusal = signInStartRefusal(signInRecords(), kind);
    if (refusal === null || task.threadId === null) return refusal;
    const paused = readJson<PausedStart>(SIGNIN_PAUSED_KEY);
    store.setMeta(SIGNIN_PAUSED_KEY, JSON.stringify(addPaused(paused, { taskId: task.id, threadId: task.threadId, kind, at: Date.now() })));
    bb.log.info(`signin: paused ${task.id}'s ${kind}: Claude is signed out`);
    return refusal;
  }

  /** Signed in again: each paused task hears it once. */
  async function wakeSignInPaused() {
    const paused = readJson<PausedStart>(SIGNIN_PAUSED_KEY);
    if (paused.length === 0 || isSignedOut(signInRecords())) return;
    store.setMeta(SIGNIN_PAUSED_KEY, "[]");
    for (const threadId of new Set(paused.map((entry) => entry.threadId))) {
      const mine = paused.filter((entry) => entry.threadId === threadId);
      const task = store.task(mine[0]?.taskId ?? "");
      if (task === null || task.closedAt !== null) continue;
      bb.log.info(`signin: waking ${task.id}: Claude is signed in again`);
      await tellThread(threadId, signInWakeMessage(mine)).catch((error: unknown) => {
        bb.log.warn(`signin: waking ${task.id} failed: ${describeError(error)}`);
      });
    }
  }

  /** The beat's pass: once sign-in works again each failed turn is retried once; a record that is back or gone is forgotten. */
  async function resumeSignIn(retries: ReadonlyMap<string, LimitWait>) {
    const records = signInRecords();
    if (records.length === 0) return;
    const wasOut = isSignedOut(records);
    const back = signInBack({ records, turnOkAt, usageOkAt });
    // turn.failed may record failures while this awaits: apply only what this
    // pass decided, to the failure it looked at, at the end.
    const dropped = new Set<string>();
    const retried = new Map<string, number>();
    const key = (record: SignedOut) => `${record.threadId}:${record.at}`;
    for (const record of records) {
      let status: ProbeStatus;
      try {
        const thread = await bb.sdk.threads.get({ threadId: record.threadId });
        status = thread.archivedAt !== null || thread.deletedAt !== null ? "gone" : thread.status;
      } catch (error) {
        if (!notFound(error)) continue;
        status = "gone";
      }
      const step = signInStep({ record, status, retryQueued: retries.has(record.threadId), back, now: Date.now() });
      if (step.kind === "wait") continue;
      if (step.kind === "forget") {
        dropped.add(key(record));
        bb.log.info(`signin: ${record.threadId} (${record.role}) is no longer waiting on sign-in (${status})`);
        continue;
      }
      if (step.kind === "leave") {
        dropped.add(key(record));
        bb.log.warn(`signin: ${record.threadId} (${record.role}) failed on sign-in again after its one retry; left in error`);
        continue;
      }
      try {
        await bb.sdk.threads.retry({
          threadId: record.threadId,
          ...(record.requestId === null ? {} : { turnRequestId: record.requestId }),
          reason: SIGNIN_RETRY_REASON,
        });
        retried.set(key(record), Date.now());
        bb.log.info(`signin: retried ${record.threadId} (${record.role}): Claude is signed in again`);
      } catch (error) {
        // Left in error, where liveness shows it; never a second try.
        dropped.add(key(record));
        bb.log.warn(`signin: retrying ${record.threadId} failed, left in error: ${describeError(error)}`);
      }
    }
    if (dropped.size > 0 || retried.size > 0) {
      saveSignIn(
        signInRecords()
          .filter((record) => !dropped.has(key(record)))
          .map((record) => {
            const at = retried.get(key(record));
            return at === undefined ? record : { ...record, retriedAt: at };
          }),
      );
    }
    if (!wasOut || isSignedOut(signInRecords())) return;
    bb.log.info("signin: Claude is signed in again; held turns and paused starts carry on");
    publish();
    void bb.experimental_hooks.recheck("message.dispatch").catch((error: unknown) => {
      bb.log.warn(`signin: recheck failed: ${describeError(error)}`);
    });
  }

  // --------------------------------------------------------------------- CI
  // ci.ts decides; here: gate it on usage and memory, tell the owning task or
  // start a "Fix failing CI" task under the project's chat, and persist the
  // head's key only once that worked.
  /** The liveness beat re-reads the repos for CI when its cached read is older than this. */
  const CI_REFRESH_MS = 5 * 60_000;
  let checkingCi = false;
  /** Keys being acted on right now, so an overlapping pass cannot act twice. */
  const ciInflight = new Set<string>();

  function ciGate(project: BbProject | undefined): string | null {
    const usage = signInStartRefusal(signInRecords(), "research") ?? startRefusal(currentUsage(), "research", Date.now());
    if (usage !== null) return usage;
    const source = project === undefined ? null : sourceOf(project);
    const decision = dispatchDecision({
      attempt: "start-turn",
      sentBySam: false,
      threadId: "",
      active: new Set(),
      reading: guard.readingFor(source?.hostId),
      now: Date.now(),
    });
    return decision.action === "wait" ? decision.reason : null;
  }

  /**
   * The liveness beat's CI pass, over the cached repo reads. A cache that is
   * empty or older than CI_REFRESH_MS is re-read instead; that read runs the
   * pass itself (snapshotRepos).
   */
  function checkCiFromCache() {
    const hidden = new Set(store.projectPrefs().filter((p) => p.hidden).map((p) => p.projectId));
    const cached = [...repoCache.entries()].filter(([projectId]) => !hidden.has(projectId));
    const oldest = Math.min(...cached.map(([, entry]) => entry.at));
    if (cached.length === 0 || Date.now() - oldest > CI_REFRESH_MS) {
      reposInflight ??= readRepos(false).finally(() => {
        reposInflight = null;
      });
      void reposInflight.catch((error: unknown) => bb.log.warn(`ci: repo read failed: ${describeError(error)}`));
      return;
    }
    void checkCi(cached.map(([projectId, entry]) => ({ projectId, repo: entry.repo, error: entry.error })));
  }

  async function checkCi(repos: Repos["repos"]) {
    if (checkingCi) return;
    checkingCi = true;
    try {
      const known = new Map((await allProjects()).map((project) => [project.id, project]));
      const projects = repos.flatMap((entry) =>
        entry.repo === null
          ? []
          : [
              {
                projectId: entry.projectId,
                projectName: known.get(entry.projectId)?.name ?? projectNames.get(entry.projectId) ?? entry.projectId,
                pullRequests: entry.repo.pullRequests,
              },
            ],
      );
      if (projects.length === 0) return;
      await runCiPass({
        projects,
        openTasks: store.tasks({ includeClosed: false }),
        gate: (projectId) => ciGate(known.get(projectId)),
        deps: {
          acted: (key) => ciInflight.has(key) || store.getMeta(key) !== null,
          deferredNoted: (key) => store.getMeta(ciDeferredKey(key)) !== null,
          markActed: (key) => {
            store.setMeta(key, String(Date.now()));
            store.setMeta(ciDeferredKey(key), null);
          },
          noteDeferred: (key, reason) => store.setMeta(ciDeferredKey(key), reason),
          tell: async (action) => {
            ciInflight.add(action.key);
            try {
              await tellThread(action.threadId, action.message);
              bb.log.info(`ci: told ${action.taskId} about red CI (${action.key})`);
            } finally {
              ciInflight.delete(action.key);
            }
          },
          start: async (action) => {
            const chat = chatThread(action.projectId);
            if (chat === null) throw new Error("no Patches chat for the project yet");
            const project = known.get(action.projectId) ?? (await projectById(action.projectId));
            const pr = projects
              .find((entry) => entry.projectId === action.projectId)
              ?.pullRequests.find((candidate) => candidate.number === action.prNumber);
            if (pr === undefined) throw new Error(`PR #${action.prNumber} is not in the repo read`);
            const before = new Set(store.tasks({ includeClosed: false }).map((task) => task.id));
            ciInflight.add(action.key);
            try {
              const { task } = await spawnTask(project, chat, action.title, action.brief, { number: pr.number, url: pr.url });
              bb.log.info(`ci: started ${task.id} for PR #${action.prNumber}`);
            } catch (error) {
              // A task row whose thread never started would own the PR and hide it from the next pass.
              for (const orphan of store.tasks({ includeClosed: false })) {
                if (before.has(orphan.id) || orphan.projectId !== action.projectId) continue;
                if (orphan.prNumber !== action.prNumber || orphan.threadId !== null) continue;
                closeTask(orphan.id, `Could not start its thread: ${describeError(error)}`, "abandoned");
              }
              throw error;
            } finally {
              ciInflight.delete(action.key);
            }
          },
          log: (message) => bb.log.info(message),
        },
      });
    } catch (error) {
      bb.log.warn(`ci: check failed: ${describeError(error)}`);
    } finally {
      checkingCi = false;
    }
  }

  // --------------------------------------------------------------- liveness
  // liveness.ts decides; here: probe the host, keep the snapshot the board
  // polls, and act on new incidents. Cheap on purpose: one listRunning, a get
  // for each open task's thread and its latest research and build, and the
  // last event only for busy threads.
  const LIVENESS_INCIDENTS_KEY = "liveness_incidents";
  let liveness: LivenessView = { checkedAt: null, error: null, configProblem: null, tasks: [], chats: [], others: [], usage: null };
  /** The local config's problem for the board: nothing before the first read was tried. */
  const configProblem = () => (localConfigTried ? localConfig.problem : null);
  let checkingLiveness = false;

  const notFound = (error: unknown) => /not.?found|404|no such thread/i.test(describeError(error));

  /** From one queue read: each thread's first message bb refused to deliver (bb's reason), and the retries it holds. */
  async function queueFacts(): Promise<{ refused: Map<string, string>; retries: Map<string, LimitWait> }> {
    const rows = await bb.sdk.threads.queue.list();
    const refused = new Map<string, string>();
    for (const row of rows) {
      if (row.failureReason !== null && !refused.has(row.threadId)) refused.set(row.threadId, row.failureReason);
    }
    return { refused, retries: retriesOf(rows) };
  }

  /** Why a thread's failed turn is coming back on its own: bb's retry row, else a sign-in failure waiting for the owner, else a recorded limit hit. */
  function limitWaits(retries: ReadonlyMap<string, LimitWait>): Map<string, LimitWait> {
    const waits = new Map(retries);
    for (const record of signInRecords()) {
      if (isWaiting(record) && !waits.has(record.threadId)) waits.set(record.threadId, { kind: "signed-out", until: null });
    }
    const fallback = currentUsage()?.resetsAt ?? null;
    for (const hit of limitHits()) {
      if (!waits.has(hit.threadId)) waits.set(hit.threadId, { kind: "usage-limit", until: hit.resetsAt ?? fallback });
    }
    return waits;
  }

  /** An errored thread's last system/error, as "message: detail"; null when unreadable. */
  async function lastError(threadId: string): Promise<string | null> {
    try {
      const [event] = await bb.sdk.threads.events.list({ threadId, order: "desc", limit: "1", types: ["system/error"] });
      const data = (event as { data?: { message?: unknown; detail?: unknown } } | undefined)?.data;
      if (typeof data?.message !== "string") return null;
      return typeof data.detail === "string" && data.detail !== "" ? `${data.message}: ${data.detail}` : data.message;
    } catch (error) {
      bb.log.warn(`liveness: reading ${threadId}'s last error failed: ${describeError(error)}`);
      return null;
    }
  }

  /** The host's view of one thread; null when it could not be read (the check skips that task). */
  async function probeThread(
    threadId: string,
    role: LiveRole,
    refused: ReadonlyMap<string, string>,
    waits: ReadonlyMap<string, LimitWait>,
    /** When given, a live thread's parentThreadId is recorded here, from the same read. */
    parents?: Map<string, string | null>,
  ): Promise<Probe | null> {
    let status: ProbeStatus;
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      status = thread.archivedAt !== null || thread.deletedAt !== null ? "gone" : thread.status;
      if (parents !== undefined && status !== "gone") parents.set(threadId, thread.parentThreadId ?? null);
    } catch (error) {
      if (!notFound(error)) {
        bb.log.warn(`liveness: reading ${threadId} failed: ${describeError(error)}`);
        return null;
      }
      status = "gone";
    }
    let lastEventAt: number | null = null;
    if (status === "active" || status === "starting" || status === "stopping") {
      try {
        const [event] = await bb.sdk.threads.events.list({ threadId, order: "desc", limit: "1" });
        lastEventAt = event?.createdAt ?? null;
      } catch (error) {
        // Unknown is never stale: it waits for the next check.
        bb.log.warn(`liveness: reading ${threadId}'s last event failed: ${describeError(error)}`);
      }
    }
    const error = status === "error" ? await lastError(threadId) : null;
    return { threadId, role, status, lastEventAt, undeliverable: refused.get(threadId) ?? null, error, limit: waits.get(threadId) ?? null };
  }

  async function runLivenessAction(action: LivenessAction) {
    try {
      if (action.kind === "stop") {
        bb.log.warn(`liveness: stopping silent ${action.threadId}`);
        releaseBrowserFor(action.threadId);
        await bb.sdk.threads.stop({ threadId: action.threadId });
      } else if (action.kind === "fail-build") {
        // The failed event may have got here first: fail a build once.
        if (store.task(action.taskId)?.buildState !== "running") return;
        bb.log.warn(`liveness: failing ${action.taskId}'s build: ${action.reason}`);
        await failBuildFor(action.taskId, action.reason, true, null);
      } else {
        bb.log.warn(`liveness: telling ${action.taskId}: ${action.message.slice(0, 200)}`);
        await tellThread(action.threadId, action.message);
      }
    } catch (error) {
      bb.log.warn(`liveness: ${action.kind} for ${"taskId" in action ? action.taskId : action.threadId} failed: ${describeError(error)}`);
    }
  }

  /**
   * Hang every task thread that is not under its project's live Patches chat
   * back under it (chats.ts parentFixes): bb tells only a thread's parent when
   * it goes idle. A project with no chat gets one, started with the summary;
   * otherwise the chat is told once per beat. A failed update is retried next
   * beat. Returns the tasks re-attached.
   */
  async function reattachTasks(fixes: readonly ParentFix[], projects: readonly BbProject[]): Promise<Set<string>> {
    const done = new Set<string>();
    const byProject = new Map<string, ParentFix[]>();
    for (const fix of fixes) byProject.set(fix.projectId, [...(byProject.get(fix.projectId) ?? []), fix]);
    for (const [projectId, group] of byProject) {
      const project = projects.find((candidate) => candidate.id === projectId);
      if (project === undefined || project.kind === "personal" || sourceOf(project) === null) continue;
      const titled = (list: readonly ParentFix[]) => list.map((fix) => ({ id: fix.taskId, title: store.task(fix.taskId)?.title ?? fix.taskId }));
      let chatThreadId = group[0]?.chatThreadId ?? null;
      let told = false;
      if (chatThreadId === null) {
        try {
          const chat = await ensureChat(project, reattachedMessage(project.name, titled(group)));
          chatThreadId = chat.threadId;
          told = chat.started;
        } catch (error) {
          bb.log.warn(`re-attach: starting ${project.name}'s Patches chat failed: ${describeError(error)}`);
          continue;
        }
      }
      const moved: ParentFix[] = [];
      for (const fix of group) {
        // Closed, or its thread changed, since the probe: leave it.
        const current = store.task(fix.taskId);
        if (current === null || current.closedAt !== null || current.threadId !== fix.threadId) continue;
        try {
          await bb.sdk.threads.update({ threadId: fix.threadId, parentThreadId: chatThreadId });
          bb.log.info(`re-attach: ${fix.taskId} (${fix.threadId}) now hangs under ${project.name}'s Patches chat ${chatThreadId}`);
          moved.push(fix);
          done.add(fix.taskId);
        } catch (error) {
          bb.log.warn(`re-attach: moving ${fix.taskId} (${fix.threadId}) under ${chatThreadId} failed, retried next beat: ${describeError(error)}`);
        }
      }
      if (told || moved.length === 0) continue;
      try {
        await tellThread(chatThreadId, reattachedMessage(project.name, titled(moved)));
      } catch (error) {
        bb.log.warn(`re-attach: telling ${project.name}'s Patches chat failed: ${describeError(error)}`);
      }
    }
    return done;
  }

  /**
   * Builds refused on claims (claim_wait metas) whose claims are free now are
   * told once to build again. Covers every release: release_task, merge,
   * close, landed, failed builds. A closed or gone task's wait is dropped.
   */
  async function wakeClaimWaiters(projects: readonly BbProject[]) {
    const waits: { key: string; wait: ClaimWait; threadId: string }[] = [];
    for (const { key, value } of store.metaWithPrefix(claimWaitKey(""))) {
      let wait: ClaimWait | null = null;
      try {
        wait = JSON.parse(value) as ClaimWait;
      } catch {
        wait = null;
      }
      const task = wait === null ? null : store.task(wait.taskId);
      if (wait === null || task === null || task.closedAt !== null || task.threadId === null) {
        store.setMeta(key, null);
        continue;
      }
      waits.push({ key, wait, threadId: task.threadId });
    }
    if (waits.length === 0) return;
    const profileById = (projectId: string) => profileOf(projects.find((project) => project.id === projectId) ?? { name: "" });
    const wake = new Set(claimWaitsToWake(waits.map((entry) => entry.wait), store.claims(), profileById));
    for (const { key, wait, threadId } of waits) {
      if (!wake.has(wait.taskId)) continue;
      const holders = wait.holders !== undefined && wait.holders.length > 0 ? wait.holders.join(", ") : "other tasks";
      try {
        await tellThread(
          threadId,
          `[The Orchestrator] The claims your build was waiting on are free now (held by ${holders}): call build again with the same touches.`,
        );
        store.setMeta(key, null);
        bb.log.info(`claims: woke ${wait.taskId}, its claims (held by ${holders}) are free`);
      } catch (error) {
        bb.log.warn(`claims: waking ${wait.taskId} failed, retried next beat: ${describeError(error)}`);
      }
    }
  }

  async function checkLiveness() {
    if (checkingLiveness) return;
    checkingLiveness = true;
    // A review hand-off must not outlive its proven head even with the board
    // closed: re-read the repos (cached 20 s) while any is open.
    if (store.tickets({ status: "open" }).some((ticket) => ticket.kind === "review")) {
      reposInflight ??= readRepos(false).finally(() => {
        reposInflight = null;
      });
      void reposInflight.catch((error: unknown) => bb.log.warn(`review check: repo read failed: ${describeError(error)}`));
    }
    try {
      await loadLocalConfig();
      await readUsage();
      const running = new Set((await bb.sdk.threads.listRunning()).map((thread) => thread.id));
      const { refused, retries } = await queueFacts();
      // First: a hit that is back no longer reads as waiting.
      await resumeHits(retries);
      await resumeSignIn(retries);
      const waits = limitWaits(retries);
      const children = store.children();
      const results: LivenessView["tasks"] = [];
      const parents = new Map<string, string | null>();
      const openTasks = store.tasks({ includeClosed: false });
      for (const task of openTasks) {
        const mine = children.filter((child) => child.taskId === task.id);
        const latest = new Set(
          (["research", "build"] as const).map((kind) => mine.filter((child) => child.kind === kind).pop()?.threadId),
        );
        const probes: Probe[] = [];
        let unreadable = false;
        const targets: { threadId: string; role: LiveRole }[] = [
          ...(task.threadId !== null ? [{ threadId: task.threadId, role: "task" as const }] : []),
          ...mine.map((child) => ({ threadId: child.threadId, role: child.kind })),
        ];
        for (const target of targets) {
          // Older children count only while they still run; their errors are history.
          const probe =
            target.role === "task" || latest.has(target.threadId) || running.has(target.threadId)
              ? await probeThread(target.threadId, target.role, refused, waits, target.role === "task" ? parents : undefined)
              : { ...target, status: "idle" as const, lastEventAt: null, undeliverable: null, error: null, limit: null };
          if (probe === null) {
            unreadable = true;
            break;
          }
          probes.push(probe);
        }
        if (unreadable) {
          const previous = liveness.tasks.find((entry) => entry.taskId === task.id);
          if (previous !== undefined) results.push(previous);
          continue;
        }
        results.push(taskLiveness({ task, probes, holds, kills, now: Date.now() }));
      }
      let seen = new Set<string>();
      try {
        seen = new Set(JSON.parse(store.getMeta(LIVENESS_INCIDENTS_KEY) ?? "[]") as string[]);
      } catch {
        seen = new Set();
      }
      const { actions, open } = livenessActions({
        tasks: results.map((entry) => ({ liveness: entry, threadId: store.task(entry.taskId)?.threadId ?? null })),
        seen,
      });
      store.setMeta(LIVENESS_INCIDENTS_KEY, JSON.stringify([...open]));
      const chats: LivenessView["chats"] = [];
      const projects = await allProjects();
      // Each project's live chat, for re-attaching tasks: an archived or deleted one is none.
      const liveChats = new Map<string, string | null>();
      for (const projectId of projects.filter((project) => project.kind !== "personal").map((project) => project.id)) {
        const threadId = chatThread(projectId);
        liveChats.set(projectId, threadId);
        if (threadId === null) continue;
        const probe = await probeThread(threadId, "task", refused, waits);
        if (probe?.status === "gone") {
          clearChat(projectId);
          liveChats.set(projectId, null);
          continue;
        }
        const trouble = probe === null ? null : chatTrouble(probe, Date.now());
        if (trouble !== null) chats.push({ projectId, threadId, trouble });
      }
      // Tasks only: never a chat itself, nor a research or build child.
      const fixes = parentFixes({
        tasks: openTasks.filter((task) => task.threadId === null || chatOf(task.threadId) === null),
        parents,
        chats: liveChats,
      });
      for (const entry of results) {
        // A thread not read this beat keeps what the last beat said.
        const threadId = store.task(entry.taskId)?.threadId ?? null;
        if (threadId === null || !parents.has(threadId)) continue;
        const fix = fixes.find((candidate) => candidate.taskId === entry.taskId);
        entry.unheard = unheardReason(fix, projectNames.get(fix?.projectId ?? "") ?? "its project");
      }
      const others = await checkOthers(running, refused, waits, projects);
      liveness = { checkedAt: Date.now(), error: null, configProblem: configProblem(), tasks: results, chats, others, usage: currentUsage() };
      const reattached = await reattachTasks(fixes, projects);
      if (reattached.size > 0) {
        liveness = {
          ...liveness,
          tasks: liveness.tasks.map((entry) => (reattached.has(entry.taskId) ? { ...entry, unheard: null } : entry)),
        };
      }
      await wakeClaimWaiters(projects);
      for (const action of actions) await runLivenessAction(action);
      await wakePaused();
      await wakeSignInPaused();
      checkCiFromCache();
      for (const projectId of new Set(store.tasks({ includeClosed: false }).filter(landCandidate).map((task) => task.projectId))) {
        void checkLanded(projectId, false);
      }
      void archiveClosedChats();
    } catch (error) {
      liveness = { ...liveness, configProblem: configProblem(), error: `the liveness check failed: ${describeError(error)}` };
      bb.log.warn(`liveness: check failed: ${describeError(error)}`);
    } finally {
      checkingLiveness = false;
    }
  }

  /**
   * Loose threads, display only: no tells, tickets or stops. An unreadable
   * probe keeps its previous entry; an unreadable list keeps them all.
   */
  async function checkOthers(
    running: ReadonlySet<string>,
    refused: ReadonlyMap<string, string>,
    waits: ReadonlyMap<string, LimitWait>,
    projects: readonly BbProject[],
  ): Promise<LivenessView["others"]> {
    let listed: Awaited<ReturnType<typeof bb.sdk.threads.list>>;
    try {
      listed = await bb.sdk.threads.list({ archived: false, limit: 500 });
    } catch (error) {
      bb.log.warn(`liveness: listing threads failed: ${describeError(error)}`);
      return liveness.others;
    }
    const excludedIds = new Set<string>();
    for (const projectId of projects.map((project) => project.id)) {
      const threadId = chatThread(projectId);
      if (threadId !== null) excludedIds.add(threadId);
    }
    // The retired Any-project chat is left alone, and off the board.
    const retired = store.getMeta(RETIRED_ANY_CHAT_KEY);
    if (retired !== null) excludedIds.add(retired);
    for (const task of store.tasks({ includeClosed: true })) if (task.threadId !== null) excludedIds.add(task.threadId);
    for (const child of store.children()) excludedIds.add(child.threadId);
    const now = Date.now();
    const out: LivenessView["others"] = [];
    for (const threadId of looseCandidates({ threads: listed, excludedIds, running, now })) {
      const probe = await probeThread(threadId, "task", refused, waits);
      if (probe === null) {
        const previous = liveness.others.find((entry) => entry.threadId === threadId);
        if (previous !== undefined) out.push(previous);
        continue;
      }
      const { state, reason } = agentLiveness(probe, undefined, now);
      out.push({ threadId, state, reason });
    }
    return out;
  }

  const livenessTimer = setInterval(() => void checkLiveness(), LIVENESS_INTERVAL_MS);
  const firstLiveness = setTimeout(() => void checkLiveness(), 2_000);
  bb.onDispose(() => {
    clearInterval(livenessTimer);
    clearTimeout(firstLiveness);
  });

  // -------------------------------------------------------------------- RPC
  bb.rpc.register(rpcContract, {
    liveness: async () => ({ ...liveness, configProblem: configProblem() }),

    agent_restart: async ({ taskId: id }) => {
      const task = store.task(id);
      if (task === null || task.closedAt !== null || task.threadId === null) throw new Error("That task is closed or has no thread.");
      const threadId = task.threadId;
      const thread = await bb.sdk.threads.get({ threadId });
      // A retry already queued (after a usage limit) must not run twice.
      const queued = retriesOf(await bb.sdk.threads.queue.list({ threadId })).get(threadId);
      const refusal = restartRefusal(queued === undefined ? undefined : queued.until, Date.now()) ?? signInRestartRefusal(signInRecords(), threadId);
      if (refusal !== null) throw new Error(refusal);
      let message: string;
      if (thread.status === "error") {
        await bb.sdk.threads.retry({ threadId });
        message = "Retried its failed turn.";
      } else {
        if (thread.status === "active" || thread.status === "starting" || thread.status === "stopping") {
          await bb.sdk.threads.stop({ threadId });
        }
        await tellThread(
          threadId,
          `[The Orchestrator] ${Owner()} restarted you: your last turn went silent and was stopped. Check where you were (task_status, git status in your worktree) and carry on.`,
        );
        message = "Stopped its silent turn and told it to carry on.";
      }
      bb.log.info(`liveness: ${owner()} restarted ${task.id} (${threadId}): ${message}`);
      void checkLiveness();
      return { message };
    },

    // Patches is not told (unless her chat has to be started for it): the
    // dossier is her source of truth, and a turn of hers would cost memory
    // budget for nothing. Its title starts as the
    // brief's first sentence; summarizeTitle replaces it shortly after.
    task_new: async ({ projectId, input, ...execution }) => {
      const projects = (await allProjects()).filter((project) => project.kind !== "personal");
      const project = projects.find((candidate) => candidate.id === projectId) ?? null;
      const source = project === null ? null : sourceOf(project);
      const chats = projects.flatMap(({ id }) => {
        const threadId = chatThread(id);
        return threadId === null ? [] : [{ projectId: id, threadId }];
      });
      const block = newTaskBlock({
        project: project === null ? null : { id: project.id, name: project.name, path: source?.path ?? null, hostId: source?.hostId ?? null },
      });
      if (block !== null || project === null) throw new Error(block ?? `No project ${projectId}.`);
      const said = input
        .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n\n");
      if (said.trim() === "") throw new Error("Say what the task should do in words; a task needs a brief.");
      const { title, brief } = taskFromAsk(said);
      // Its own project's chat; one with none yet has it started first (that is her one turn).
      const parentThreadId =
        parentChatFor(project.id, chats) ??
        (
          await ensureChat(
            project,
            `[The Orchestrator] ${Owner()} is starting a task in ${project.name} with New task: "${title}". It hangs under this chat; task_status shows it. Nothing to do until it reports.`,
          )
        ).threadId;
      const others = store
        .tasks({ includeClosed: false })
        .filter((other) => other.projectId === project.id)
        .map((other) => ({ id: other.id, title: other.title }));
      const task = store.createTask({ projectId: project.id, title, brief });
      void jevWatchTask(task, source?.hostId ?? null);
      try {
        // The owner's picks in the composer; without them, Patches' provider.
        const picks = execution.providerId !== undefined ? execution : await providerOf(parentThreadId);
        // Jev's model never replaces one the owner picked (modelroute.ts ownerPickedModel).
        const route = await routeFor({
          role: "task",
          providerId: picks.providerId,
          ownerModel: execution.providerId !== undefined && ownerPickedModel(execution),
          hostId: source?.hostId ?? null,
          state: () => routeState({ role: "task", title, brief }),
        });
        const thread = await bb.sdk.threads.spawn({
          projectId: project.id,
          parentThreadId,
          environment: await checkoutEnvironment(project),
          ...picks,
          ...spawnModel("task", route),
          title,
          input: [{ type: "text", text: newTaskPrompt(task, project.name, others), mentions: [] }, ...input],
          pluginMetadata: { role: "task", taskId: task.id },
        });
        noteRoute(thread.id, task, "task", route);
        changed(store.updateTask(task.id, { threadId: thread.id }));
        bb.log.info(`${Owner()} started ${task.id} "${title}" in ${project.name} with New task (thread ${thread.id}).`);
        void summarizeTitle(task.id, thread.id, title, brief, source?.hostId ?? null);
        return { taskId: task.id, threadId: thread.id };
      } catch (error) {
        // No open task without a thread: it would hold a place on the board forever.
        closeTask(task.id, `Could not start its thread: ${describeError(error)}`, "abandoned");
        publish();
        throw error;
      }
    },

    board_state: async () => {
      const projects = await allProjects();
      const prefs = store.projectPrefs();
      let primaryHostId: string | null = null;
      try {
        primaryHostId = (await bb.sdk.system.config()).primaryHostId ?? null;
      } catch {
        primaryHostId = null;
      }
      // Always one project in view while any exists: an unset or removed focus is the first visible one.
      const own = projects.filter((project) => project.kind !== "personal");
      const focus = focusedProject(
        store.getMeta(FOCUS_KEY),
        own.map((project) => ({ id: project.id, hidden: prefs.find((p) => p.projectId === project.id)?.hidden ?? false })),
      );
      const chats = await Promise.all(
        own.map(async ({ id: projectId }) => {
          const threadId = chatThread(projectId);
          if (threadId === null) return null;
          try {
            const thread = await bb.sdk.threads.get({ threadId });
            if (thread.archivedAt !== null || thread.deletedAt !== null) {
              clearChat(projectId);
              return null;
            }
          } catch {
            clearChat(projectId);
            return null;
          }
          const unread = isUnread({
            replyAt: metaTime(replyAtKey(projectId)),
            seenAt: metaTime(seenAtKey(projectId)),
            shown: focus === projectId,
          });
          return { projectId, threadId, unread };
        }),
      );
      const patchesChats = chats.filter((chat) => chat !== null);
      const tasks = store.tasks({ includeClosed: false });
      return {
        patchesChats,
        focusProjectId: focus,
        primaryHostId,
        projects: projects
          .filter((project) => project.kind !== "personal")
          .map((project) => {
            const pref = prefs.find((p) => p.projectId === project.id);
            const source = sourceOf(project);
            return {
              id: project.id,
              name: project.name,
              isPersonal: false,
              path: source?.path ?? null,
              hostId: source?.hostId ?? null,
              color: pref?.color ?? null,
              hidden: pref?.hidden ?? false,
              profile: profileOf(project).key,
              reviewLabel: reviewLabel(profileOf(project)),
            };
          }),
        tasks: tasks.map((task) => ({
          ...task,
          claims: store.claimsFor(task.id),
          followUp: task.stage === "research" ? followUpOf(store.getMeta(reportKey(task.id)) ?? task.note) : null,
          stepsLeft: stepsOf(task.id)?.left.length ?? 0,
        })),
        tickets: store.tickets({ status: "open" }),
        children: store.children().filter((child) => tasks.some((task) => task.id === child.taskId)),
        closedCounts: closedCounts(store.tasks({ includeClosed: true })),
        buildsInFlight: buildsInFlight(tasks).length,
        buildCap: BUILD_CAP,
        sidebar: { provider: threadListProviderId(bb.pluginId), adopted: store.sidebarAdopted() },
        archiveClosedChats: archiveEnabled(store.getMeta(ARCHIVE_CLOSED_KEY)),
        closedThreadIds: closedTaskThreadIds(store.tasks({ includeClosed: true }), store.children()),
        ui: { otherAgentsOpen: savedFlag(store.getMeta(UI_OTHER_AGENTS_OPEN_KEY)) },
        jevWatch: own
          .map((project) => ({ projectId: project.id, report: agreementReport(store.listJevWatch(project.id)) }))
          .filter((entry) => entry.report.rows > 0),
        modelRoutes: boardRoutes(tasks),
        modelRoutePause: routePause(Date.now(), routeFailure),
        modelRouteKey: await routeKey(primaryHostId),
        signedOut: signedOutView(signInRecords()),
        ownerName: owner(),
        needsSetup: setupNeeded(projects),
        projectsDir: localConfig.config.projectsDir ?? DEFAULT_PROJECTS_DIR,
      };
    },

    claude_sign_in: async () => {
      // Sign-in coming back is signInBack's to notice; this only starts the command.
      const hostId = (await bb.sdk.system.config()).primaryHostId ?? null;
      if (hostId === null) return { ok: false, error: "No host is connected to run the sign-in on." };
      const started = await host.call("claudeSignIn", {}, { hostId, timeoutMs: 20_000 });
      if (started.ok) bb.log.info("Sign in with Claude: started `claude auth login` on the host");
      else bb.log.warn(`Sign in with Claude: could not start: ${started.error ?? "unknown"}`);
      return started;
    },

    ui_pref: async ({ otherAgentsOpen }) => {
      store.setMeta(UI_OTHER_AGENTS_OPEN_KEY, otherAgentsOpen ? "1" : "0");
      publish();
      return { ok: true as const };
    },

    repos_snapshot: async ({ force }) => {
      reposInflight ??= readRepos(force).finally(() => {
        reposInflight = null;
      });
      return reposInflight;
    },

    project_prefs: async ({ projectId, color, hidden }) => {
      store.setProjectPrefs(projectId, {
        ...(color !== undefined ? { color } : {}),
        ...(hidden !== undefined ? { hidden } : {}),
      });
      // Hiding the project in view moves the view to the first visible one (focusedProject).
      if (hidden === true && store.getMeta(FOCUS_KEY) === projectId) store.setMeta(FOCUS_KEY, null);
      publish();
      return { ok: true as const };
    },

    project_add: async ({ hostId, path, name }) => ({ projectId: await addExistingProject(hostId, path, name, true) }),

    setup_state: async () => {
      const hostId = (await bb.sdk.system.config()).primaryHostId ?? null;
      const projects = await allProjects();
      let facts: { home: string; gh: SignIn; claude: SignIn } | null = null;
      if (hostId !== null) {
        try {
          facts = await host.call("setupFacts", {}, { hostId, timeoutMs: 40_000 });
        } catch (error) {
          bb.log.warn(`setup: reading the sign-in state failed: ${describeError(error)}`);
        }
      }
      const unknown: SignIn = { state: "unknown", account: null };
      // A turn that failed on sign-in outranks what `claude auth status` says (signin.ts).
      const claude: SignIn = isSignedOut(signInRecords()) ? { state: "out", account: null } : (facts?.claude ?? unknown);
      return {
        needsSetup: setupNeeded(projects),
        home: facts?.home ?? null,
        projectsDir: localConfig.config.projectsDir,
        suggestedDir: localConfig.config.projectsDir ?? DEFAULT_PROJECTS_DIR,
        ownerName: owner(),
        configProblem: localConfig.problem,
        signIn: {
          gh: { ...(facts?.gh ?? unknown), command: GH_SIGN_IN_COMMAND },
          claude: { ...claude, command: SIGN_IN_COMMAND },
        },
      };
    },

    setup_list: async ({ dir }) => {
      const hostId = (await bb.sdk.system.config()).primaryHostId ?? null;
      if (hostId === null) throw new Error("No machine is connected to look in that folder on.");
      const listing = await host.call("listRepos", { dir }, { hostId, timeoutMs: 30_000 });
      const { choices, note } = repoChoices(listing.dir, listing, registeredPaths(await allProjects()));
      return { dir: listing.dir, exists: listing.exists, choices, note: listing.exists ? note : null };
    },

    setup_save: async ({ projectsDir, ownerName, repos }) => {
      const hostId = (await bb.sdk.system.config()).primaryHostId ?? null;
      if (hostId === null) throw new Error("No machine is connected to save the setup on.");
      const name = ownerNameToSave(ownerName, owner(), ownerFirstName(null, gitName));
      if (typeof name === "string" && name.length > OWNER_NAME_MAX) {
        throw new Error(`Keep the name to ${OWNER_NAME_MAX} characters or fewer.`);
      }
      const saved = await host.call(
        "saveSetup",
        { projectsDir, ...(name !== undefined ? { ownerName: name } : {}) },
        { hostId, timeoutMs: 30_000 },
      );
      if (!saved.ok) throw new Error(saved.reason);
      bb.log.info(`setup: saved the projects folder ${saved.projectsDir}${saved.created ? " (created)" : ""}${name === undefined ? "" : "; the name changed"}`);
      await loadLocalConfig();
      publish();
      const results: { name: string; ok: boolean; detail: string; projectId: string | null }[] = [];
      if (repos.length > 0) {
        // The list as it is now, read again on the host: only a git repo in the saved folder is added.
        const listing = await host.call("listRepos", { dir: saved.projectsDir }, { hostId, timeoutMs: 30_000 });
        const { choices } = repoChoices(listing.dir, listing, registeredPaths(await allProjects()));
        let opened = false;
        for (const pick of pickRepos(repos, choices)) {
          if (!pick.ok) {
            results.push({ name: pick.name, ok: false, detail: pick.reason, projectId: null });
            continue;
          }
          try {
            // The first one added is opened; each of the others starts its chat when the owner opens it.
            const projectId = await addExistingProject(hostId, pick.path, pick.name, !opened);
            opened = true;
            results.push({ name: pick.name, ok: true, detail: pick.path, projectId });
          } catch (error) {
            results.push({ name: pick.name, ok: false, detail: describeError(error), projectId: null });
          }
        }
        bb.log.info(`setup: added ${results.filter((result) => result.ok).length} of ${results.length} ticked repos`);
      }
      return { projectsDir: saved.projectsDir, created: saved.created, results };
    },

    project_create: async ({ hostId, name }) => {
      const projects = await allProjects();
      const paths = registeredPaths(projects);
      // The host reads the folder from the config itself and re-checks the path against its real home directory.
      const check = validateNewProject(
        name,
        { names: projects.map((project) => project.name), paths },
        localConfig.config.projectsDir ?? DEFAULT_PROJECTS_DIR,
      );
      if (!check.ok) throw new Error(check.reason);
      const title = name.trim();
      bb.log.info(`Add project: creating ${title} (${check.slug})`);
      const made = await host.call(
        "createProject",
        { name: title, slug: check.slug, registeredPaths: paths.slice(0, 500) },
        { hostId, timeoutMs: 180_000 },
      );
      const created = await bb.sdk.projects.create({ name: title, source: { type: "local_path", hostId, path: made.path } });
      markSeen(store.getMeta(FOCUS_KEY));
      markSeen(created.id);
      store.setMeta(FOCUS_KEY, created.id);
      publish();
      startChatOnOpen(created.id);
      bb.log.info(
        made.github.ok
          ? `Add project: ${title} at ${made.path}, ${made.github.url} (${made.github.visibility})`
          : `Add project: ${title} at ${made.path}; GitHub failed: ${made.github.error}`,
      );
      return { projectId: created.id, path: made.path, github: made.github };
    },

    project_remove: async ({ projectId, confirmName }) => {
      const project = await projectById(projectId);
      if (project.kind === "personal") throw new Error("The Personal project cannot be removed.");
      if (confirmName.trim() !== project.name) {
        throw new Error(`Type the project's name, ${project.name}, to remove it.`);
      }
      if (store.tasks({ includeClosed: false }).some((task) => task.projectId === projectId)) {
        throw new Error(`${project.name} has open tasks. Close them first.`);
      }
      await bb.sdk.projects.delete({ projectId });
      publish();
      return { ok: true as const };
    },

    orchestrator_register: async ({ threadId, projectId }) => {
      const thread = await bb.sdk.threads.get({ threadId });
      const projects = await allProjects();
      const home = projects.find((project) => project.id === thread.projectId);
      const project = projects.find((candidate) => candidate.id === projectId && candidate.kind !== "personal");
      if (project === undefined) throw new Error(`No project ${projectId}.`);
      if (thread.projectId !== projectId) throw new Error(`${project.name}'s Patches must live in ${project.name}.`);
      const metadata = await bb.sdk.threads.getPluginMetadata({ threadId, pluginId: bb.pluginId });
      const claimed =
        home === undefined
          ? null
          : claimedChat({
              role: metadata.role,
              metadataProjectId: metadata.projectId,
              projectId: home.id,
              projectKind: home.kind === "personal" ? "personal" : "standard",
            });
      if (claimed === null || claimed.projectId !== projectId) throw new Error("That thread was not started as this Patches chat.");
      const current = chatThread(projectId);
      if (current !== null && current !== threadId) {
        throw new Error("That chat already has a thread. Archive it first to start over.");
      }
      registerChat(projectId, threadId);
      publish();
      return { ok: true as const };
    },

    chat_seen: async ({ projectId }) => {
      markSeen(projectId);
      publish();
      return { ok: true as const };
    },

    focus_set: async ({ projectId }) => {
      // The owner was looking at the old chat until now, and is looking at the new one.
      markSeen(store.getMeta(FOCUS_KEY));
      markSeen(projectId);
      store.setMeta(FOCUS_KEY, projectId);
      publish();
      startChatOnOpen(projectId);
      return { ok: true as const };
    },

    sidebar_adopted: async () => {
      store.markSidebarAdopted();
      return { ok: true as const };
    },

    ticket_answer: async ({ ticketId, answers, note }) => {
      const ticket = store.ticket(ticketId);
      if (ticket === null || ticket.status !== "open") throw new Error("That ticket is already closed.");
      const task = store.task(ticket.taskId);
      if (task === null || task.threadId === null) throw new Error("That ticket's task has no thread.");
      const lines = ticket.questions.map(
        (question, index) => `**Q${index + 1}.** ${question}\n**${Owner()}:** ${answers[index]?.trim() || "(no answer: decide it yourself and record the decision)"}`,
      );
      if (note.trim() !== "") lines.push(`**${Owner()} also says:** ${note.trim()}`);
      await tellThread(task.threadId, `${Owner()} answered your questions (ticket ${ticket.id}). These are settled; do not re-ask.\n\n${lines.join("\n\n")}`);
      store.closeTicket(ticket.id, ticket.questions.map((_, index) => answers[index]?.trim() ?? ""));
      changed(store.updateTask(task.id, answeredTaskPatch(task)));
      return { ok: true as const };
    },

    ticket_close: async ({ ticketId }) => {
      const ticket = store.ticket(ticketId);
      if (ticket === null) throw new Error("No such ticket.");
      store.closeTicket(ticketId, ticket.answers);
      const task = store.task(ticket.taskId);
      if (task !== null) changed(store.updateTask(task.id, answeredTaskPatch(task)));
      else publish();
      return { ok: true as const };
    },

    report_read: async ({ ticketId }) => {
      const ticket = store.ticket(ticketId);
      if (ticket === null || ticket.kind !== "report" || !ticket.report) throw new Error("No such report.");
      const file = await reportFile(ticket.taskId, ticket.report.path, true);
      if (!file.ok) throw new Error(file.reason);
      return { title: ticket.report.title, path: file.path, text: file.text ?? "", hostId: file.hostId };
    },

    report_reviewed: async ({ ticketId }) => {
      const ticket = store.ticket(ticketId);
      if (ticket === null || ticket.kind !== "report") throw new Error("No such report.");
      if (ticket.status !== "open") throw new Error("That report is already reviewed or withdrawn.");
      const task = store.task(ticket.taskId);
      store.closeTicket(ticket.id, null);
      // Open questions still hold the task (tickets.ts): it closes once they are answered.
      const closes = task !== null && task.closedAt === null && closeHoldFor(task.id) === null;
      if (task !== null && closes) {
        closeTask(task.id, reportReviewedNote(), "done");
        store.setMeta(idleKey(task.id), null);
        store.setMeta(closeHeldKey(task.id), null);
        bb.log.info(`${task.id} closed: ${reportReviewedNote()}`);
        void cleanupWorktree(task.id);
        if (task.threadId !== null) {
          void tellThread(task.threadId, reportReviewedMessage(task.id)).catch((error: unknown) =>
            bb.log.warn(`telling ${task.id} its report was reviewed failed: ${describeError(error)}`),
          );
        }
      }
      publish();
      return { closed: closes };
    },

    report_follow_up: async ({ ticketId, note }) => {
      const refused = followUpRefusal(note);
      if (refused !== null) throw new Error(refused);
      const ticket = store.ticket(ticketId);
      if (ticket === null || ticket.kind !== "report") throw new Error("No such report.");
      if (ticket.status !== "open") throw new Error("That report is already reviewed or withdrawn.");
      const task = store.task(ticket.taskId);
      if (task === null || task.threadId === null || task.closedAt !== null) throw new Error("That report's task has no open thread.");
      await tellThread(task.threadId, reportFollowUpMessage(ticket.id, note));
      bb.log.info(`${Owner()} followed up on ${task.id}'s report ${ticket.id}`);
      return { ok: true as const };
    },

    build_retry: async ({ taskId: id }) => {
      const task = store.task(id);
      if (task === null || task.closedAt !== null) throw new Error("That task is closed.");
      if (task.buildState !== "failed") throw new Error("That build has not failed.");
      if (task.buildRequest === null || task.threadId === null) {
        throw new Error("There is no earlier build request to retry; the task has to call build itself.");
      }
      const message = await startBuild(task, task.buildRequest, task.threadId, true);
      await tellThread(task.threadId, `[The Orchestrator] ${Owner()} pressed Retry on your failed build. ${message}`);
      return { message };
    },

    build_dismiss: async ({ taskId: id }) => {
      const task = store.task(id);
      if (task === null || task.closedAt !== null) throw new Error("That task is closed.");
      if (task.buildState !== "failed") throw new Error("That build has not failed.");
      changed(store.updateTask(task.id, { buildState: "none", buildError: null, buildFailures: 0 }));
      if (task.threadId !== null) {
        await tellThread(task.threadId, `[The Orchestrator] ${Owner()} dismissed the failed build of ${task.id}. Do not retry it unless they ask.`);
      }
      if (task.worktreePath !== null) void cleanupWorktree(task.id);
      return { ok: true as const };
    },

    task_delete: async ({ taskId: id }) => {
      const task = store.task(id);
      if (task === null) throw new Error(`No task ${id}.`);
      if (task.threadId !== null && chatOf(task.threadId) !== null) throw new Error("That is a Patches chat, not a task.");
      if (task.closedAt === null) {
        closeTask(task.id, `Deleted by ${owner()}.`, "abandoned");
        publish();
      }
      store.setMeta(idleKey(task.id), null);
      // Stopped first, so a working thread is archived too. Archived, not
      // deleted: the owner can restore them. PRs and branches are left alone.
      const threadIds = taskThreadIds(task);
      for (const threadId of threadIds) {
        releaseBrowserFor(threadId);
        await bb.sdk.threads.stop({ threadId }).catch(() => undefined);
      }
      if (await archiveThreads(threadIds, new Set())) store.setMeta(threadsArchivedKey(task.id), String(Date.now()));
      bb.log.info(`${Owner()} deleted ${task.id} "${task.title}"`);
      if (task.worktreePath === null) return { worktree: "none" as const };
      await cleanupWorktree(task.id);
      const after = store.task(task.id);
      if (after === null || after.worktreePath === null) return { worktree: "removed" as const };
      return { worktree: "kept" as const, reason: after.worktreeNote ?? "The worktree could not be checked." };
    },

    archive_closed_chats: async ({ enabled }) => {
      if (enabled !== undefined) {
        store.setMeta(ARCHIVE_CLOSED_KEY, enabled ? "on" : "off");
        publish();
        if (enabled) void archiveClosedChats();
      }
      return { enabled: archiveEnabled(store.getMeta(ARCHIVE_CLOSED_KEY)) };
    },

    closed_tasks: async ({ projectId, query, offset, limit }) => {
      const page = closedTaskPage({ tasks: store.tasks({ includeClosed: true }), projectId, query, offset, limit });
      return {
        rows: page.rows.map((task) => ({
          id: task.id,
          projectId: task.projectId,
          title: task.title,
          threadId: task.threadId,
          note: task.note,
          prNumber: task.prNumber,
          prUrl: task.prUrl,
          closedAt: task.closedAt,
        })),
        total: page.total,
      };
    },

    closed_task: async ({ taskId: id }) => {
      const task = store.task(id);
      if (task === null) throw new Error(`No task ${id}.`);
      if (task.closedAt === null) throw new Error("That task is still open: it is on the board.");
      const summary = closedTaskSummary({
        task,
        tickets: store.tickets({ status: "all" }),
        withdrawals: store.withdrawals(task.id),
        releases: store.releases(task.id),
        children: store.children(),
      });
      // Looked at only: nothing here unarchives, messages or changes a thread.
      const threads = await Promise.all(
        summary.threads.map(async (entry) => {
          try {
            const thread = await bb.sdk.threads.get({ threadId: entry.threadId });
            const state = thread.deletedAt !== null ? "gone" : thread.archivedAt !== null ? "archived" : "live";
            return { ...entry, state: state as "live" | "archived" | "gone" };
          } catch {
            return { ...entry, state: "gone" as const };
          }
        }),
      );
      return { ...summary, threads };
    },

    task_activity: async ({ taskId: id }) => {
      const task = store.task(id);
      if (task === null) throw new Error(`No task ${id}.`);
      // Only the threads the dossier records for this task; looked at, never messaged or stopped.
      const children = store.children().filter((child) => child.taskId === task.id);
      const own = taskThreads({ task, children, liveThreadIds: new Set(children.map((child) => child.threadId)), currentThreadId: null });
      const running = new Set((await bb.sdk.threads.listRunning()).map((thread) => thread.id));
      const anyWorking = own.some((entry) => running.has(entry.threadId));
      const candidates = await Promise.all(
        own.map(async (entry) => ({
          ...entry,
          working: running.has(entry.threadId),
          // Asked only to pick the last one active when nothing works.
          lastActiveAt: anyWorking
            ? null
            : await bb.sdk.threads.get({ threadId: entry.threadId }).then(
                (thread) => (thread.deletedAt !== null ? null : thread.updatedAt),
                () => null,
              ),
        })),
      );
      const repoPath = await projectById(task.projectId).then(
        (project) => sourceOf(project)?.path ?? null,
        () => null,
      );
      const panes = await Promise.all(
        whichThreads(candidates).map(async ({ threadId, kind, label, working }) => {
          const pane = { threadId, kind, label: kind === "task" ? `Task: ${label}` : label, working };
          try {
            const events = await bb.sdk.threads.events.list({
              threadId,
              order: "desc",
              limit: String(ACTIVITY_EVENT_ROWS),
              types: ACTIVITY_EVENT_TYPES,
            });
            const root = kind === "build" ? (task.worktreePath ?? repoPath) : repoPath;
            return { ...pane, lines: activityLines(events, { root, working }) };
          } catch (error) {
            bb.log.warn(`task_activity: reading ${threadId} failed: ${describeError(error)}`);
            return { ...pane, lines: [unreadableLine(Date.now())] };
          }
        }),
      );
      return { panes, checkedAt: Date.now() };
    },
  });

  bb.log.info(`${PATCHES} is ready.`);
}
