// The one boundary between the server entry and the host worker that runs git
// and gh on the machine holding each project checkout. Both sides validate
// against these schemas, so every string the board renders is bounded here.
//
// Reads are the default. The only writes are the ones the owner delegated to the
// Orchestrator: push a task's own branch, open its PR, and add or re-add the
// `ai-tests` label. Nothing here force-pushes, and nothing pushes a default
// branch except pushBackup — host.ts refuses the rest outright. The one local
// merge is landBranch, a fast-forward for projects whose profile says land:
// "main" (a local app in development; landBranch itself never pushes); the
// server refuses it for every other project. pushBackup then copies that
// default branch to the profile's private backup remote, never forced.
// createProject makes a new project folder and its private GitHub repo.
// keepLastGood / restoreLastGood copy the main checkout's dist/ to and from
// the host's last-good dir (recovery.ts); runGuardTests runs a guard's tests
// in a task's worktree before land (landguard.ts).
// ai.voice.transcribe turns the chat mic's recording into text on this Mac.
// claudeSignIn starts `claude auth login` for the board's Sign in with Claude
// button; it takes no input and returns nothing the process printed.
// The setup wizard (setupwizard.ts): setupFacts says the home directory and
// whether gh and Claude are signed in, listRepos lists one folder's
// subfolders (read-only), saveSetup writes the folder and the name into the
// local config, keeping every other key, and never over a file with a problem.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { LOCAL_CONFIG_MAX_CHARS } from "./localconfig";
import { OWNER_NAME_MAX } from "./owner";
import { PROJECTS_DIR_MAX, REPO_LIST_CAP } from "./setupwizard";

const text = (max: number) => z.string().max(max);
const path = z.string().min(1).max(1000);
/** One tool's sign-in, for the setup wizard (setupwizard.ts SignIn). */
const signInSchema = z
  .object({ state: z.enum(["in", "out", "missing", "unknown"]), account: text(200).nullable() })
  .strict();
/** mainCommits returns at most this many commits. */
export const MAIN_COMMIT_LIMIT = 300;

export const branchSchema = z.object({
  name: text(250),
  sha: text(64),
  committedAt: z.number(),
  subject: text(300),
  ahead: z.number().int(),
  behind: z.number().int(),
  worktreePath: text(1000).nullable(),
});
export type Branch = z.infer<typeof branchSchema>;

export const checksSchema = z.enum(["passing", "failing", "pending", "none"]);
export type Checks = z.infer<typeof checksSchema>;

export const pullRequestSchema = z.object({
  number: z.number().int(),
  title: text(300),
  url: text(500),
  state: z.enum(["open", "closed", "merged"]),
  isDraft: z.boolean(),
  headRefName: text(250),
  headRefOid: text(64),
  updatedAt: z.number(),
  checks: checksSchema,
  /** Conclusions (upper-case, as GitHub gives them) of the checks counted as failed. */
  failedConclusions: z.array(text(40)).max(50),
  mergeable: z.enum(["mergeable", "conflicting", "unknown"]),
  /** GitHub's mergeStateStatus: CLEAN, BEHIND, DIRTY, BLOCKED, UNSTABLE, … */
  mergeStateStatus: text(40),
  labels: z.array(text(80)).max(30),
  /** Short sha from the sticky preview comment's "Built from"; null when none. */
  previewSha: text(64).nullable(),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;

export const repoSnapshotSchema = z.object({
  defaultBranch: text(250),
  branches: z.array(branchSchema).max(200),
  pullRequests: z.array(pullRequestSchema).max(200),
  /** Why the PR lookup failed (gh missing, signed out, no remote); null when it worked. */
  pullRequestError: text(500).nullable(),
  githubUrl: text(500).nullable(),
});
export type RepoSnapshot = z.infer<typeof repoSnapshotSchema>;

export const commentSchema = z.object({
  body: text(20_000),
  createdAt: z.number(),
});
export type PrComment = z.infer<typeof commentSchema>;

/** Everything ready_for_review needs about one PR, read fresh. */
export const prFactsSchema = z.object({
  number: z.number().int(),
  url: text(500),
  state: z.enum(["open", "closed", "merged"]),
  isDraft: z.boolean(),
  headRefName: text(250),
  headRefOid: text(64),
  checks: checksSchema,
  /** Names of checks that failed, for the verdict's reasons. */
  failingChecks: z.array(text(200)).max(50),
  mergeable: z.enum(["mergeable", "conflicting", "unknown"]),
  mergeStateStatus: text(40),
  labels: z.array(text(80)).max(30),
  files: z.array(text(500)).max(3000),
  body: text(30_000),
  comments: z.array(commentSchema).max(100),
});
export type PrFacts = z.infer<typeof prFactsSchema>;

export const worktreeStateSchema = z.object({
  branch: text(250).nullable(),
  headSha: text(64),
  dirty: z.boolean(),
  /** Commits on the branch that the base ref does not have. */
  ahead: z.number().int(),
  /** Files the branch changes against the base ref (`git diff --name-only base...HEAD`). */
  files: z.array(text(500)).max(2000),
});
export type WorktreeState = z.infer<typeof worktreeStateSchema>;

// The AI-service host methods. They began as a copy of the SDK's contract
// (0.5.9 dist/ai-services.js); since SDK 0.5.29 a service is functions in the
// server (server.ts registers `transcribe`), and this is only our own wire
// between server.ts and host.ts.
const jsonValueSchema: z.ZodType<AiJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
type AiJsonValue = string | number | boolean | null | AiJsonValue[] | { [key: string]: AiJsonValue };
const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

const aiServiceErrorCodeSchema = z.enum([
  "timeout",
  "rate_limited",
  "service_unavailable",
  "auth_required",
  "request_failed",
  "invalid_response",
]);
const aiFailureSchema = z
  .object({ ok: z.literal(false), code: aiServiceErrorCodeSchema, message: z.string().min(1) })
  .strict();

export const aiServicesHostContract = defineRpcContract({
  "ai.inference.complete": {
    input: z
      .object({
        serviceId: z.string().min(1),
        model: z.string().min(1),
        reasoningEffort: z.literal("none"),
        prompt: z.string().min(1),
        outputSchema: jsonObjectSchema,
        timeoutMs: z.number().int().positive(),
      })
      .strict(),
    output: z.union([
      z.object({ ok: z.literal(true), model: z.string().min(1), value: jsonObjectSchema }).strict(),
      aiFailureSchema,
    ]),
  },
  "ai.voice.transcribe": {
    input: z
      .object({
        serviceId: z.string().min(1),
        model: z.string().min(1),
        audioBase64: z.string().min(1),
        mimeType: z.string().min(1),
        filename: z.string().min(1),
        prompt: z.string().nullable(),
        timeoutMs: z.number().int().positive(),
      })
      .strict(),
    output: z.union([
      z.object({ ok: z.literal(true), model: z.string().min(1), text: z.string() }).strict(),
      aiFailureSchema,
    ]),
  },
});

export type AiServiceErrorCode = z.infer<typeof aiServiceErrorCodeSchema>;
export type AiVoiceTranscribeInput = z.infer<(typeof aiServicesHostContract)["ai.voice.transcribe"]["input"]>;
export type AiVoiceTranscribeOutput = z.infer<(typeof aiServicesHostContract)["ai.voice.transcribe"]["output"]>;

/** One of Jev's answers as jevwatch.ts readAnswer reads it. */
const jevAnswerSchema = z.union([
  z.object({ choice: text(40), top: z.number().min(0).max(1), margin: z.number().min(0).max(1) }),
  z.object({ error: text(200) }),
]);
const killTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("group"), pgid: z.number().int().gt(1) }),
  z.object({ kind: z.literal("pid"), pid: z.number().int().gt(1) }),
]);

/** The board's Headroom line (headroom.ts headroomView). */
export const headroomViewSchema = z
  .object({
    state: z.enum(["on", "installing", "starting", "down", "off"]),
    line: text(300),
    needsOwner: z.object({ title: text(100), body: text(500), command: text(1200) }).strict().nullable(),
  })
  .strict();
export type HeadroomViewOutput = z.infer<typeof headroomViewSchema>;

const headroomBeatOutputSchema = z
  .object({
    view: headroomViewSchema,
    /** Checkouts left alone this beat, and why. */
    skipped: z.array(z.object({ path: text(1000), reason: text(300) }).strict()).max(50),
  })
  .strict();
export type HeadroomBeatOutput = z.infer<typeof headroomBeatOutputSchema>;

export const hostContract = defineRpcContract({
  /**
   * The AI-service methods core calls for the `local` service server.ts
   * registers: "ai.voice.transcribe" runs Apple's on-device speech (voice.ts);
   * "ai.inference.complete" is not offered and always refuses.
   */
  ...aiServicesHostContract,
  repoSnapshot: {
    input: z
      .object({ repoPath: path, previewMarker: text(200).nullable() })
      .strict(),
    output: repoSnapshotSchema,
  },
  prFacts: {
    input: z.object({ repoPath: path, number: z.number().int().positive() }).strict(),
    output: prFactsSchema,
  },
  worktreeState: {
    input: z.object({ worktreePath: path, baseRef: text(250) }).strict(),
    output: worktreeStateSchema,
  },
  /**
   * Is a task's branch still there, locally or on origin, and is its last
   * known tip on the default branch? Local refs only, no fetch. headOnBase is
   * null when there is no headSha.
   */
  branchFate: {
    input: z
      .object({ repoPath: path, branch: text(250), headSha: text(64).nullable(), base: text(250) })
      .strict(),
    output: z.object({ local: z.boolean(), remote: z.boolean(), headOnBase: z.boolean().nullable() }),
  },
  /**
   * Commits on the default branch (local, and origin's when there is one)
   * committed at or after `since` (ms), newest first, at most MAIN_COMMIT_LIMIT.
   * Local refs only, no fetch. landed.ts ties them to tasks. `tips`: the
   * local tips of the given task branches that exist (a task's own build).
   */
  mainCommits: {
    input: z
      .object({
        repoPath: path,
        since: z.number().int().nonnegative(),
        branches: z.array(text(250)).max(100).optional(),
      })
      .strict(),
    output: z.object({
      base: text(250),
      commits: z.array(z.object({ sha: text(64), committedAt: z.number(), message: text(4000) })),
      tips: z.array(z.object({ branch: text(250), sha: text(64) })),
    }),
  },
  /**
   * Push the worktree's own branch to origin. Never forced, never the default
   * branch. With `target` (the task's open PR's head branch, when the worktree
   * is on another branch): push HEAD to origin/<target> only when that is a
   * strict fast-forward from `expectedOld`, the PR's head as GitHub reported it.
   */
  pushBranch: {
    input: z
      .object({
        worktreePath: path,
        branch: text(250),
        target: text(250).optional(),
        expectedOld: text(64).optional(),
      })
      .strict(),
    output: z.object({ headSha: text(64) }),
  },
  createPullRequest: {
    input: z
      .object({
        worktreePath: path,
        branch: text(250),
        base: text(250),
        title: z.string().min(1).max(250),
        body: z.string().max(30_000),
      })
      .strict(),
    output: z.object({ number: z.number().int(), url: text(500) }),
  },
  /**
   * `git worktree add -b <branch> <repo>/.claude/worktrees/<slug> <baseRef>`,
   * then copy the untracked files the profile and `.worktreeinclude` name.
   * Refuses when `.claude/` is not gitignored in the repo.
   */
  prepareWorktree: {
    input: z
      .object({
        repoPath: path,
        worktreePath: path,
        /** The plugin's source folder, where builderguard.ts lives; never the host artifacts folder. */
        pluginRoot: path,
        branch: text(250),
        baseRef: text(250),
        include: z.array(text(200)).max(50),
        /** The profile's productionEnv: when true no env pattern is copied, from the profile's list or the repo's `.worktreeinclude`. */
        productionEnv: z.boolean(),
        /** A retry after a failed build, or a follow-up round on an open PR: keep the worktree and branch if they exist; a branch only on origin is recreated from it. */
        reuse: z.boolean(),
        /** A follow-up round: the PR's head sha. The branch is fast-forwarded to it, or refused when it has diverged. */
        prHead: text(64).optional(),
      })
      .strict(),
    output: z.object({
      copied: z.number().int(),
      /** Include patterns that matched nothing in the main checkout. */
      unmatched: z.array(text(200)).max(50),
      /** The builder guard (sandbox, deny rules, Bash hook) is in the worktree's .claude/settings.local.json. */
      guarded: z.literal(true),
    }),
  },
  /** Install dependencies in a fresh worktree; argv lists, run in order. */
  /**
   * The owner's local config (localconfig.ts): the text of
   * ~/.config/the-orchestrator/config.json, cut at the cap plus one so a file
   * over it is seen as such; null when there is no such file. Never writes
   * the file. A valid text that differs from the last copy is kept at
   * <dataDir>/local-config.last-good.json. `gitUserName` is git's global
   * user.name for the owner's first name (owner.ts), null when git has none.
   */
  localConfig: {
    input: z.object({}).strict(),
    output: z
      .object({ text: z.string().max(LOCAL_CONFIG_MAX_CHARS + 1).nullable(), gitUserName: z.string().max(200).nullable().optional() })
      .strict(),
  },
  /** The Mac's memory right now, for the memory guard (memory.ts). */
  memoryStatus: {
    input: z.object({}).strict(),
    output: z.object({
      freePercent: z.number().int().min(0).max(100),
      totalBytes: z.number().nullable(),
      swapUsedBytes: z.number().nullable(),
      top: z
        .array(z.object({ pid: z.number().int(), rssBytes: z.number(), command: text(200) }))
        .max(20),
      treeBytes: z.number().nullable(),
      heavy: z
        .array(
          z.object({
            pid: z.number().int(),
            pgid: z.number().int(),
            rssBytes: z.number(),
            command: text(200),
            threadId: text(100).nullable(),
            target: killTargetSchema.nullable(),
          }),
        )
        .max(20),
      at: z.number(),
    }),
  },
  /**
   * Kill one agent process the memory guard picked (memory.ts
   * pickProcessKill): its group or its pid, SIGTERM then SIGKILL. The host
   * re-reads the tree first and refuses anything no longer the same agent
   * process; it never kills claude, bb or anything under /Applications/.
   */
  killProcess: {
    input: z.object({ pid: z.number().int().positive(), command: text(200), target: killTargetSchema }).strict(),
    output: z.object({ killed: z.boolean(), detail: text(300) }),
  },
  /**
   * One short `claude -p` call (a New task's summary title). A failure is
   * ok: false with why, never a throw.
   */
  summarizeTitle: {
    input: z.object({ prompt: z.string().min(1).max(25_000), model: z.string().min(1).max(100) }).strict(),
    output: z.union([
      z.object({ ok: z.literal(true), text: text(2000) }),
      z.object({ ok: z.literal(false), error: text(500) }),
    ]),
  },
  /**
   * Watch only (jevwatch.ts): ask Jev a new task's kind and tier. "off", with
   * no network call, unless ~/.config/jev says the box is up and has our key;
   * otherwise one POST capped at JEV_TIMEOUT_MS, body included. Every outcome
   * is a value, never a throw, and no error carries the response body.
   */
  jevAsk: {
    input: z.object({ title: z.string().max(1000), brief: z.string().max(4000) }).strict(),
    output: z.union([
      z.object({
        ok: z.literal(true),
        latencyMs: z.number().int().min(0),
        model: text(80).nullable(),
        answers: z.object({ kind: jevAnswerSchema, tier: jevAnswerSchema }),
      }),
      z.object({ ok: z.literal(false), kind: z.literal("off") }),
      z.object({ ok: z.literal(false), kind: z.enum(["error", "timeout"]), error: text(300), latencyMs: z.number().int().min(0) }),
    ]),
  },
  /**
   * Jev picks an agent's model (modelroute.ts): TypeSafe only, with the key
   * from ~/.config/the-orchestrator/jev.env (typesafe.ts), "no-key" with no
   * call when there is none or the file is open to others. One POST capped
   * at JEV_TIMEOUT_MS, no retry. Every outcome is a value, never a throw, and
   * no error carries the response body or the key. `state` comes scrubbed
   * from the server (modelroute.ts routeState).
   */
  modelRoute: {
    input: z.object({ state: z.string().min(1).max(4000) }).strict(),
    output: z.union([
      z.object({ ok: z.literal(true), latencyMs: z.number().int().min(0), model: text(80).nullable(), answer: jevAnswerSchema }).strict(),
      z.object({ ok: z.literal(false), kind: z.literal("no-key"), problem: z.enum(["missing", "open"]) }).strict(),
      z
        .object({ ok: z.literal(false), kind: z.enum(["error", "timeout"]), error: text(300), latencyMs: z.number().int().min(0) })
        .strict(),
    ]),
  },
  /** Whether jev.env holds a usable key (typesafe.ts keyFromFile). Presence only: the key never leaves the host. */
  routeKeyStatus: {
    input: z.object({}).strict(),
    output: z.union([
      z.object({ present: z.literal(true) }).strict(),
      z.object({ present: z.literal(false), problem: z.enum(["missing", "open"]) }).strict(),
    ]),
  },
  /** Kill every process whose cwd is inside a task worktree (a stopped builder's leftovers). */
  killWorktreeProcesses: {
    input: z.object({ repoPath: path, worktreePath: path }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  runSetup: {
    input: z
      .object({
        worktreePath: path,
        commands: z.array(z.array(text(200)).min(1).max(20)).max(10),
      })
      .strict(),
    output: z.object({
      ok: z.boolean(),
      /** The failing command and the tail of its output; null when ok. */
      failure: text(3000).nullable(),
    }),
  },
  inspectWorktree: {
    input: z.object({ worktreePath: path, baseRef: text(250) }).strict(),
    output: z.object({
      exists: z.boolean(),
      dirty: z.boolean(),
      unpushed: z.number().int(),
    }),
  },
  /**
   * `git worktree remove` — only when clean and fully pushed. `gone`: the
   * folder no longer exists while the repo does (the host pruned git's
   * record of it); the task's record is stale.
   */
  removeWorktree: {
    input: z
      .object({ repoPath: path, worktreePath: path, baseRef: text(250) })
      .strict(),
    output: z.object({ removed: z.boolean(), gone: z.boolean(), reason: text(300).nullable() }),
  },
  /**
   * The folders directly under <repo>/.claude/worktrees: whether git has each
   * registered (`git worktree list`), and whether it holds no files at all
   * (only possibly-empty directories; a symlink counts as a file).
   */
  listWorktreeDirs: {
    input: z.object({ repoPath: path }).strict(),
    output: z.array(z.object({ slug: text(200), registered: z.boolean(), empty: z.boolean() })).max(500),
  },
  /**
   * Remove a folder under <repo>/.claude/worktrees that no task records, as
   * worktrees.ts orphanDecision allows. The host re-inspects everything itself
   * and never kills processes for it.
   */
  removeOrphanWorktree: {
    input: z.object({ repoPath: path, worktreePath: path }).strict(),
    output: z.object({ removed: z.boolean(), reason: text(300).nullable() }),
  },
  /**
   * For land: "main" profiles only (a local app, never pushed): rebase the
   * task branch onto `target` in its worktree, then `git merge --ff-only` it
   * in the main checkout. Refuses a dirty worktree, a main checkout on another
   * branch or with tracked changes, and any conflict (the rebase is aborted).
   */
  landBranch: {
    input: z
      .object({ repoPath: path, worktreePath: path, branch: text(250), target: text(250) })
      .strict(),
    output: z.object({ headSha: text(64), commits: z.number().int() }),
  },
  /**
   * After land() on a land: "main" profile with a backup remote: `git push
   * <remote> <branch>:<branch>` from the main checkout, never forced. A
   * rejected or failed push returns ok: false; it never undoes the land.
   */
  pushBackup: {
    input: z.object({ repoPath: path, remote: text(100), branch: text(250) }).strict(),
    output: z.object({
      ok: z.boolean(),
      output: text(3000),
      /** Why the push failed; null when ok. */
      error: text(3000).nullable(),
    }),
  },
  /**
   * After land() on a land: "main" profile: run the build commands in the
   * main checkout, in order; start the last (the reload that restarts this
   * plugin) detached after a short delay, so the land reply gets out first.
   * A failed build returns ok: false with its tail and skips the reload.
   * With `reloadId`, the reload writes its output and then its exit code to
   * `<outcomeDir>/<reloadId>.out|.exit` (the exit file last, atomically);
   * reloadOutcome reads them.
   */
  runAfterLand: {
    input: z
      .object({
        repoPath: path,
        commands: z.array(z.array(text(200)).min(1).max(20)).min(1).max(10),
        reloadId: text(100).regex(/^task_[a-z0-9]+$/).optional(),
      })
      .strict(),
    output: z.object({
      ok: z.boolean(),
      /** The tail of the build output. */
      output: text(3000),
      /** The failing command and why; null when ok. */
      error: text(3000).nullable(),
      /** Where the reload's outcome is written; null without reloadId or when the reload did not start. */
      outcomeDir: text(1000).nullable(),
    }),
  },
  /**
   * The outcome runAfterLand's reload wrote: its exit code (null while the
   * .exit file is not there yet) and the tail of its output. Read only; the
   * files stay (old and new instances both read them) until the next
   * runAfterLand for the same id replaces them.
   */
  reloadOutcome: {
    input: z.object({ reloadId: text(100).regex(/^task_[a-z0-9]+$/) }).strict(),
    output: z.object({ exitCode: z.number().int().nullable(), output: text(3000) }),
  },
  /**
   * After a confirmed good reload (recovery.ts): copy the main checkout's
   * dist/ to the host's last-good dir with its sha, swapped in whole.
   */
  keepLastGood: {
    input: z.object({ repoPath: path, sha: text(64).regex(/^[0-9a-f]{7,64}$/) }).strict(),
    output: z.object({ ok: z.boolean(), error: text(1000).nullable() }),
  },
  /**
   * After a failed reload or build: put the last-good dist/ back in the main
   * checkout. restored: false with the reason when there is none.
   */
  restoreLastGood: {
    input: z.object({ repoPath: path }).strict(),
    output: z.object({ restored: z.boolean(), sha: text(64).nullable(), reason: text(1000).nullable() }),
  },
  /**
   * land's guard-file rule (landguard.ts): `npx vitest run <files>` in the
   * task's worktree; files are repo-root *.test.ts names only.
   */
  runGuardTests: {
    input: z
      .object({
        repoPath: path,
        worktreePath: path,
        files: z.array(text(100).regex(/^[A-Za-z0-9_-]+\.test\.ts$/)).min(1).max(20),
      })
      .strict(),
    output: z.object({ ok: z.boolean(), output: text(3000) }),
  },
  /** bb's own view of a plugin (`bb plugin list --json`): status and statusDetail, null when absent. */
  pluginStatus: {
    input: z.object({ pluginId: text(100) }).strict(),
    output: z.object({ status: text(100).nullable(), detail: text(2000).nullable() }),
  },
  /**
   * Add project (newproject.ts): mkdir <projects folder>/<slug> (the local
   * config's projectsDir, else <home>/Documents/Github; the host reads the
   * config itself and re-checks the folder is inside home), write
   * the first files, `git init -b main`, first commit, then `gh repo create
   * <gh login>/<slug> --private --push` and an unauthenticated check that
   * GitHub hides it. Refuses a folder that already exists. A gh failure is
   * github.ok: false with the command to retry; the local project stays.
   */
  createProject: {
    input: z
      .object({
        name: z.string().min(1).max(60),
        slug: z.string().min(1).max(60),
        /** Every registered project's local path: the host refuses to reuse one. */
        registeredPaths: z.array(path).max(500),
      })
      .strict(),
    output: z.object({
      path: text(1000),
      github: z.union([
        z.object({ ok: z.literal(true), url: text(500), visibility: z.enum(["private", "public", "unknown"]) }),
        z.object({ ok: z.literal(false), error: text(3000), retry: text(2000) }),
      ]),
    }),
  },
  /** Add a label; with `readd`, remove it first so its run follows the latest push. */
  applyLabel: {
    input: z
      .object({
        repoPath: path,
        number: z.number().int().positive(),
        label: z.string().min(1).max(80),
        readd: z.boolean(),
      })
      .strict(),
    output: z.object({ ok: z.boolean() }),
  },
  /**
   * The setup wizard's facts (setupwizard.ts): the home directory, and
   * whether `gh` and Claude are signed in (`gh api user --jq .login`, `claude
   * auth status`: only the login, `loggedIn` and the email are kept; no token
   * or credential file is read). Read-only, never throws: "unknown" is an answer.
   */
  setupFacts: {
    input: z.object({}).strict(),
    output: z
      .object({
        home: text(PROJECTS_DIR_MAX),
        gh: signInSchema,
        claude: signInSchema,
      })
      .strict(),
  },
  /**
   * The immediate subfolders of `dir` (no recursion, no dot-folders, no
   * symlinks), in name order and capped: whether each has a .git folder and
   * its origin remote without credentials. The host re-checks `dir` is inside
   * its real home directory. Read-only; a folder that is not there is
   * `exists: false` and no entries.
   */
  listRepos: {
    input: z.object({ dir: path.max(PROJECTS_DIR_MAX) }).strict(),
    output: z
      .object({
        dir: text(PROJECTS_DIR_MAX),
        exists: z.boolean(),
        entries: z
          .array(z.object({ name: z.string().min(1).max(255), git: z.boolean(), remote: text(300).nullable() }).strict())
          .max(REPO_LIST_CAP),
        truncated: z.boolean(),
      })
      .strict(),
  },
  /**
   * Save the wizard's answers into ~/.config/the-orchestrator/config.json:
   * `projectsDir` (re-checked inside home; created if missing) and the name
   * (a string sets it, null takes it out, absent leaves it). Every other key
   * is kept (mergeSetupIntoConfig). A file with a problem is never written
   * over: ok false and why. The write is a temp file renamed into place, 0600.
   */
  saveSetup: {
    input: z
      .object({ projectsDir: path.max(PROJECTS_DIR_MAX), ownerName: z.string().min(1).max(OWNER_NAME_MAX).nullable().optional() })
      .strict(),
    output: z.union([
      z.object({ ok: z.literal(true), projectsDir: text(PROJECTS_DIR_MAX), created: z.boolean() }).strict(),
      z.object({ ok: z.literal(false), reason: text(1000) }).strict(),
    ]),
  },
  /**
   * The board's Sign in with Claude button (signin.ts): start `claude auth
   * login`, which opens the browser's sign-in tab itself. No input: no
   * account, no path. ok once the process has started; the error is a spawn
   * failure in plain words, never anything the process printed (its output
   * is not read at all).
   */
  claudeSignIn: {
    input: z.object({}).strict(),
    output: z.object({ ok: z.boolean(), error: text(200).nullable() }).strict(),
  },
  /**
   * One liveness beat for the Headroom proxy (headroom.ts): install, start or
   * restart it as headroomStep says, then put ANTHROPIC_BASE_URL in each
   * checkout's .claude/settings.local.json while it is healthy and take ours
   * out while it is not (never one the owner set; never in a checkout whose
   * .claude/ git does not ignore). The install runs in the background.
   */
  headroomBeat: {
    input: z.object({ checkouts: z.array(path).max(200) }).strict(),
    output: headroomBeatOutputSchema,
  },
  /** The owner's explicit stop, or start again; nothing else stops the proxy for good. */
  headroomControl: {
    input: z.object({ action: z.enum(["stop", "start"]) }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
});
