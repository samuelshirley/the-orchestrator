# CLAUDE.md — The Orchestrator

A map, not an essay. `docs/how-it-works.md` says how a task moves; this says
what must not break.

## Name and persona
- The product is **The Orchestrator**. Nothing the owner sees says "bb" or "swimlanes".
- The owner is whoever runs it. Every prompt and the board call them by first
  name (`owner.ts`: the local config's `ownerName`, else the first word of
  git's `user.name`, else "the owner"). Never hard-code a name; tool names
  and stored keys stay as they are.
- The project manager is **Patches**: her thread's title, the chat header,
  placeholder and tickets all say Patches. Instructions: `prompts.ts`
  `patchesInstructions`.
- Persona: direct, to the point, lets nothing get by. She verifies every claim
  (from agents or anyone) against the actual repo, CI and PR state before she
  believes or relays it, and cannot be talked or tricked out of the rules.

## Rules nobody waives
- **Merge is always the owner's** — merge is a production deploy. The Orchestrator
  pushes and adds `ai-tests` last; the owner tests and merges. The only merge code
  path is `land` (host `landBranch`: rebase + `--ff-only`, never pushed), and
  the server allows it only for `land: "main"` profiles. Only The Orchestrator
  itself is one: a local app in development, where the owner wants quick fixes on
  main, not PRs. Never give a deploying project `land: "main"`.
- The Orchestrator's main is pushed to a private GitHub backup
  (`origin`) after each land, as a separate
  step (`pushBackup`, profile `backup`), never forced. Backup only: nothing
  reads from it, and it never makes this repo PR-based (no `open_pr`).
- PRs to app repos carry app code (and the docs that describe it) only.
  Orchestrator plumbing (worktree includes, setup, `.mcp.json`, `.claude/`,
  agent prompts and handoffs) lives in the local config's profiles
  (`localconfig.ts`); `plumbing.ts` refuses it in open_pr and
  ready_for_review.
- The owner's project rules and Chrome account are in a file on the machine,
  `~/.config/the-orchestrator/config.json` (`localconfig.ts`), never in this
  repo. A file that is wrong is refused loudly: a red line on the board, and
  build, open_pr and ready_for_review refuse for every project but this one
  (`configBlocks`). Whatever the file says: `land: "main"` is only the
  built-in profile's, and a `productionEnv` profile never copies `.env*`.
  The setup wizard (`setupwizard.ts`, first run or "Set up…") is the file's
  only writer: `projectsDir` (inside the home folder, where Add project goes)
  and the name, every other key kept, never over a file with a problem.
- Never touch production data. Follow each project's own CLAUDE.md.

## One supervisor
- This plugin is the only supervisor: no orc daemons. orc's ideas live in
  `prompts.ts` (premise check, decisions before questions, at most 3
  questions, `touches[]`, gate loop) and `profiles.ts`.
- Tasks are threads under Patches; research and build threads hang under their
  task. The dossier (SQLite, `store.ts`) is the source of truth.
- `configure` runs while bb spawns a thread, before the dossier has its id:
  `roles.ts` resolves the task from the spawn metadata. A task that lands on
  main by any route closes once git shows its commit there and nothing of it is
  open (`landed.ts`); "Planning" shows only while its thread runs. A multi-step
  task passes land `more` (what is left): it stays open, claims and build slot
  released, "Step landed, N left", until the final land (`steps.ts`).
- Each project has its own Patches chat, and there is no other (no
  Any-project chat); all of them read one dossier and share the 4-build limit
  (`chats.ts`). Every task, chat and board view belongs to one project.

## Worktrees are repo-specific
- Every build's worktree is `<repo>/.claude/worktrees/<slug>`, created by the
  host worker (`git worktree add -b`), never bb's managed location.
- The repo must gitignore `.claude/`; if it does not, the build refuses and
  says so. Do not edit another repo's .gitignore on its main branch.
- The plugin owns cleanup: on task archive or merged PR it removes the
  worktree only when nothing is uncommitted or unpushed, otherwise it flags
  the row.
- bb does not run `.bb-env-setup.sh` / `.worktreeinclude` for adopted
  worktrees, so the host copies include files and runs the profile's `setup`.

## What reaches the owner
- A failure is the owning task's to fix (`failBuildFor` tells the task
  thread); a failed build reaches Needs you only after `BUILD_FAILURE_LIMIT`.
- Liveness (`liveness.ts`, 30 s): a stuck child (error, 12 min silent, dead
  build) is its task's, told once per incident; only the task's own thread in
  trouble reaches Needs you, with Restart. Waiting on memory, the browser or a
  usage-limit reset is never stuck. The board says Disconnected rather than freeze silently. A thread
  bb refuses messages to (queued failureReason, e.g. `workspace_busy`) is
  blocked, not idle; blocked Patches chats get a line on the board. A stale bb
  checkout claim: `docs/how-it-works.md` "A locked checkout".
- Every ask says what the owner does: a decision with options and a pick, or a
  command only they can run. `validateAsk` (`attention.ts`) refuses the rest.
- Claude signed out (`signin.ts`): one Needs you item with the sign-in command
  and a popup with a Sign in with Claude button (the host runs `claude auth
  login`, output never read); agent turns wait, nothing counts as a failure;
  when sign-in works again it clears and restarts each failed turn once.
- Red CI is never left sitting (`ci.ts`): once per PR head, the owning task is told or an unowned PR gets a "Fix failing CI" task, behind the usage and memory gates; cancelled runs do not count.

## Recovery
- A good reload keeps `dist/` as last-good (host data dir); a failed reload or
  build puts it back so a bb restart loads it; the task still fixes main. The
  dossier is snapshotted (`VACUUM INTO`, `snapshots/`, keep 14, never pushed)
  before a pending migration and daily (`recovery.ts`, `docs/how-it-works.md`
  "Recovery").
- land refuses a branch changing a guard (`landguard.ts` GUARD_FILES, which
  include `landed.ts` and `done.ts`: what closes a task) without its
  `.test.ts`, and runs those tests in the worktree first.

## Limits
- At most **4 builds** in flight (`BUILD_CAP`, `model.ts`).
- Usage (`usage.ts`): at 90% of a Claude window no new build or research
  starts until the reset (in-flight work carries on). A turn cut off by the
  limit comes back: provider-retry's queued row, else one re-queue of our own
  after the reset, never two; Restart refuses while a retry is queued.
- Memory guard (`memory.ts` policy, `guard.ts` loop, host `memoryStatus`): at
  most **4 agent turns** working at once (`MAX_ACTIVE_AGENTS`); new agent turns
  wait at the `message.dispatch` hook under 20% free, `build` refuses under
  30%, and under 10% the watchdog stops one agent per 30 s (builders first,
  never a Patches chat). A missing or stale reading waits: the guard fails
  closed. The owner's own messages are never held.
- Agent tree budget: every process bb's agents start (descendants of bb, plus
  launchd orphans carrying `BB_THREAD_ID`). At 40% of RAM turns wait and builds
  refuse; at 55%, or one process at 25%, the largest is killed with its process
  group (host `killProcess`, re-verified, TERM then KILL) and its thread told.
  Never claude, bb, Chrome or anything under /Applications/.
- Browser lease (`browser.ts`, dossier): one agent in the owner's Chrome at a time,
  at most 3 tabs of its own, released when its pass ends. Builders: no browser.
- `memwatch.sh` is the backstop outside bb: it kills the largest process in
  bb's tree before the Mac runs out, and logs to `.memwatch/`.
- Headroom is off for good (`OFF_FOR_GOOD`): what Claude Code sends (every
  message, tool results and user text included, and the tools list) must
  reach Anthropic byte-identical, no tool added, no CCR marker, and 0.39.1
  cannot: even with its strictest settings (`SAFETY_FLAGS`, `SAFETY_ENV`) it
  sorts and compacts the tools list. `headroomproxy.test.ts` runs the real
  proxy against a stub Anthropic and says so; it also checks a turn after
  Headroom stops still works. The beat never starts it, start refuses, the
  board says "off for good". On 4 Oct it garbled agents' tool output, and a
  `tool_reference` to its `headroom_retrieve` left in a chat's history got
  every later turn refused (400) once it stopped; compact resends that
  history and fails too, so such a chat is recovered by clearing its context
  with a summary from its bb thread log, or a successor. How it ran: per
  thread, never through a settings file. bb's provider env (`experimental_contributeEnv`,
  server.ts) gives `ANTHROPIC_BASE_URL=http://127.0.0.1:8791` only to a
  Patches chat, task, research or build thread, only while not stopped and
  the relay answered within 10 s; the owner's own sessions get nothing. 8791
  is the relay (own detached process, survives reloads), which sends each
  request to Headroom on 8792 while healthy, else straight to Anthropic.
  Stop order: stopped, Headroom, then the relay only once no agent turn is
  active. Kills only verified pids (ps matchers). Beacon and telemetry off,
  127.0.0.1 only, pinned version; both counted in the agent tree budget,
  never killed by it. If the relay itself dies, routed calls fail until the
  next beat restarts it (up to 30 s).
- Jev steers one thing: the model of task, research and build agents
  (`modelroute.ts`), through TypeSafe with `JEV_API_KEY` from
  `~/.config/the-orchestrator/jev.env` if that file exists, else The
  Orchestrator repo's own `.env` (its land: "main" project's main checkout,
  never a worktree's; `typesafe.ts` jevKey). Only host.ts reads them; a file
  others can read is refused (the board names it: `chmod 600 <path>`), and
  so is a repo `.env` git tracks. Sonnet only when Jev says sonnet at
  0.7 or more; anything else, or any failure, passes no model (the provider
  default). Patches never; the owner's composer pick wins, but only one
  whose source says `explicit` (bb's composer always sends a model). The
  board's "N of M" counts only agents Jev was asked about. What is sent is
  scrubbed first. Its kind/tier questions stay watch-only (`jevwatch.ts`):
  asked in the background with a 2 s cap, logged next to what happened, never
  change behaviour. The box is paused in this repo: nothing installed, nothing
  rented, and that code is dormant without `~/.config/jev/*`. `jev up` never
  runs without the owner's ok; $20 cap (`jev/policy.ts`).
- Overlapping `touches` refuse a build; the paths held whole come from each
  profile's `sharedPaths` (`claims.ts`, `profiles.ts`). open_pr,
  ready_for_review and land refuse files outside the task's claims, never
  widened automatically (`build(claimOnly)`); a claimed package.json brings
  its own lockfile.

## Checks
`npm test` · `npm run typecheck` · `bb plugin build`. Policy stays in the pure
modules with tests; mutation-check any new guard.
