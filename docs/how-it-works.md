# How The Orchestrator works

The reference. For setup, see the [README](../README.md).

The owner's development dashboard: one project manager, **Patches**, runs researchers
and builders across every project. Open **The Orchestrator** in the sidebar
(`/plugins/the-orchestrator/board`).

| Column | What it is |
| --- | --- |
| Projects | Every project, each in its own colour; one is always selected (the first visible one until the owner picks, or when the selected one is removed or hidden). With none, it points to Add project. Click one (or its board tab, or its sidebar row) to open its board: no chat, just the board across the full width, with its open tasks underneath in the rail; a project with a checkout and no Patches chat yet has one started behind the scenes (`shouldStartChat`). **Add project** asks for a name and creates <slug> in the projects folder (the one chosen in the setup wizard, else ~/Documents/Github) with a first commit (README, a CLAUDE.md stub, a .gitignore with `.claude/`), a private GitHub repo under the account `gh` is signed in as with main pushed (checked from outside to be private), starts its Patches chat and opens its board; if GitHub fails the project is still created and the rail shows why and the command to retry. **Add existing folder…** (in the same form) registers a folder that already exists, selects it and starts its Patches chat. New projects are PR-based by default. Hide one; remove one only by typing its name (files are never touched). The "+" next to Tasks (and on the project's sidebar row) starts a task directly in its own clean chat: the first message becomes its brief, and it hangs under that project's Patches (started first if the project has none yet). |
| Chat | Every chat belongs to a task; a project shows its board only, with no chat. Click a task (rail, Tasks row, Needs you, sidebar) and its chat opens here, between the rail and the board; a research or build thread opens here too and keeps the right side on its task (`scope.ts`). The back control in the chat header returns to the project board. To talk to Patches, start a task with "+". **Patches**, one chat per project and no other, still runs behind the scenes in that project's main checkout so she follows its CLAUDE.md, and every task thread hangs under her, but her project chat is never shown: its thread id opens the project board. Each Patches chat sees and starts only its own project's tasks (instructions, `task_status`, and tools refuse another project's task and name its chat); the 4-build limit and Claude usage are shared by every project. |
| Board | A tab per visible project along the top: the same selection as the rail, and each opens that project's board. **Builds x/4** and usage are always global. **The project board** (nothing open, "+", or another agent's thread) shows only that project. Each tab carries iOS-style badges: **orange** counts its items in Needs you, **green** counts its research and build threads working (and builds preparing), so other projects' items still show. Below: **Needs you** (one ticket per task), **Tasks** (Research → Build → PR → You), **Other agents** (collapsible; every thread outside a Patches chat and an open task, with its live state from the liveness check: working, waiting, needs you, idle, or red with the reason; trouble and working first, each with its last activity. Closed tasks' threads are not listed: they are under that task in Completed. Idle threads untouched for 2 days fold into **Older (N)**. It opens by itself while something in it works, needs the owner or is in trouble, until the owner opens or closes it; their choice is kept in the dossier, meta `ui_other_agents_open`), **Other open PRs** (every project's PRs no task owns), and **Completed · N** (collapsed; N is every closed task of the project in view. Open, it lists them newest first, 25 a page with Previous/Next, with a search over title, brief, note, id and PR number, and when and how each finished: landed commit, merged or closed PR, done, deleted, archived; its header has the **Archive chats of done tasks after 10 min** switch). **Click a completed task** and it opens by its own route (`closed:<taskId>`, `archive.ts`), not its thread: its chat in the chat column, transcript only with no message box, and on the right its dossier summary (how it finished with the commit or PR, brief, note, decisions, questions and the owner's answers, withdrawn questions, released claims, research and build summaries) and its threads, each opening the same way; a deleted chat is listed but cannot be opened. Opening one never unarchives or changes anything. **With a task open** the right side is that task only: an **All tasks in <project>** link back to the board, its Needs-you ticket (with its Answer boxes), its one row, and its **Threads** (the task thread, each research and each build, with its live state; each opens in the chat column, the open one highlighted), and below them **Live · N working**: a dark terminal pane per thread of the task that is working (at most 6), each showing its newest commands with the tail of their output, file reads and edits, tool calls and messages, secrets masked (`activity.ts`), asked for every 2 s while the box is open and the tab on screen; with nothing working it keeps the last active thread's activity to look over. Clicking a row's **Building** cell opens the builder's chat with the box beside it. Other agents, Other open PRs and Completed are hidden there. Hovering a task row in the rail's Tasks list, the Tasks lanes or Completed shows an **×** to delete it (see How a task moves). |

Liveness: a task row (and its sidebar row) spins while any of its agents is
mid-turn, shows a clock while one waits for memory or the browser, and a red
warning with the reason when one is stuck. Every 30 s the server checks each
open task's threads against the host (status and newest event, not the
dossier stage) and the board fetches that check in one call; the header says
"Agents checked 12s ago", or **Disconnected** with the reason when the board's
own polling fails or no check has landed for 90 s. Stuck means: a thread in
error; a working turn with no event for 12 min (the Bash tool caps one command
at 10); a build the dossier calls running whose builder is gone or errored; or
an agent the memory guard stopped or killed a process of; or a thread bb
will not deliver messages to (a queued message with a failure reason, such as
a locked checkout: **blocked**). An errored thread shows bb's own error
("Provisioning thread failed: …"). A stuck research
thread is stopped and its task told once; a dead or silent build fails through
the usual build failure (the owner sees it past 2). The task's own thread erroring or
going silent goes to Needs you with **Restart** (retry the failed turn, or stop
the silent one and tell it to carry on); a blocked one offers no Restart,
since nothing reaches it. A Patches chat that is blocked, errored or silent
gets a red line at the top of the board. Policy: `liveness.ts`.
The same check reads loose threads for Other agents (up to 40 a beat: running,
or touched in the last 2 days, outside every chat and task): display only,
never told, stopped or ticketed.

Task threads always hang under their project's current Patches chat: bb tells
only a thread's parent when it goes idle, so a task under no chat, an archived
chat or another project's chat is heard by nobody. Each beat re-attaches any
that are not (`parentFixes`), starting the project's chat if it has none, and
tells that chat once which tasks it got back; until then the row says
**Stalled · Patches not told**, not "Idle · waiting on Patches". Never archive
a Patches chat with open tasks under it: bb archives its children too. A build
refused on claims is recorded (meta `claim_wait:<task>`) and its task told
once, on the first beat its claims are free, to call build again
(`claimWaitsToWake`), whatever released them.

### Usage limits

The header shows Claude usage for the fullest window that limits every model
("Usage 72% · resets 18:00"), read on the same 30 s beat from
provider-claude-code's cached usage (a fresh reading at most every 5 min). At
90% it turns amber with a line under the header, and new builds and research
are refused with the reset time; work in flight carries on, the owner's own Retry
still runs, and each refused task is told once when the window has room again.

When the limit hits, every mid-turn agent's turn fails and bb's provider-retry
queues it for just after the reset. The Orchestrator records each hit of its
own agents (task, research, builder, Patches chat) in the dossier. Until the
reset the row reads "waiting until 18:00: usage limit": not an error, not Needs
you, no Restart (Restart refuses while a retry is queued, since it would run
the turn twice), and a builder's failure does not fail its build. After the
reset plus 3 min, a hit with no retry queued and its thread still in error
(provider-retry declines resets past its 6-hour maximum wait, such as the
weekly limit) is re-queued once. If that does not bring it back either, a
builder's build fails as usual, research tells its task, and a task thread or
chat is left in error for the usual Needs you or alert line. A retry that is
held by the memory guard counts as queued. Policy: `usage.ts`.

### Claude signed out

When Claude's session expires every agent turn fails ("Failed to authenticate:
OAuth session expired"). That is one cause, so it is one item: **Claude is
signed out** at the top of Needs you, with how many agents wait and the command
only the owner can run (`claude auth login`). The Orchestrator records each failed
turn of its own agents (dossier meta `signin_failures`); their rows read
"waiting for ⟨the owner's first name⟩ to sign in to Claude": not an error, not a failed build, no
Restart, no chat alert line. New agent turns are held at the dispatch hook
(the owner's own messages never are) and new builds and research are refused, each
refused task told once afterwards. Sign-in counts as working again when a
Claude turn completes or a usage reading comes back ok (forced fresh once a
minute while signed out), either one newer than the latest failure;
`claude auth status` is not trusted. Then the item clears, held turns run, and
each failed turn is retried once, never while a retry is already queued. A
turn that fails on sign-in again after its retry brings the item back, and is
left in error for the usual Needs you or alert line once sign-in works again.

While signed out the board also shows a popup, **Claude is signed out**, with a
**Sign in with Claude** button; the same button sits on the Needs you item. A
click asks the primary host to start `claude auth login` (`claudeSignIn`),
which opens the browser's sign-in tab itself. The host passes no account and
never reads what the command prints: its output goes nowhere, so no token or
code is captured or logged; the server logs only that it started, or why it
could not. `claude` is looked for on the host's PATH, then in `~/.local/bin`,
Homebrew and npm's global dirs. A second click stops the first sign-in and
opens the tab again; one nobody finishes is stopped after 10 minutes. If it
cannot start, the popup says why and the command with Copy is the fallback.
The popup can be dismissed (Not now, close, Escape): it stays away for the
failure that was on screen, comes back on a newer one, and goes by itself once
sign-in works. Dismissal is kept in the page, so a reload shows it again. The
item counts in every project's tab badge, and once in the total.
Policy: `signin.ts`.

### A locked checkout

Task, research and Patches threads share each project's one checkout
environment (bb allows one environment per project and path). While bb sets a
thread up there it binds that environment to it (`owner_thread_id`,
`claim_path` in `~/.bb/bb.db`) and lets go when the thread attaches. If bb dies
in between and the thread comes back idle, nothing lets go (bb 0.43.4): every
other thread there gets HTTP 409 `workspace_busy`, "Cannot checkout branch
while another thread is using this workspace" (no branch is involved; it is
bb's generic text), and a new thread on that path fails after 15 min with
"Workspace is being prepared by another thread". Restarting bb does not clear
it; the owner itself still works. The board shows every thread there as
blocked. Spawns reuse the environment (`checkout.ts`) so The Orchestrator no
longer creates the claim, but a bb crash during any other setup still can.

Find the owner:

```sh
sqlite3 -readonly ~/.bb/bb.db "select id, owner_thread_id, claim_path from environments where status = 'ready' and owner_thread_id is not null"
```

Clear it: archiving the owner makes bb cancel its setup, which on a shared
environment only drops the claim; but archiving a task thread closes the task
and cleans up its worktree. For a thread with work, clear the two fields
exactly as bb's own sweep does, guarded on the owner (bb keeps no copy in
memory):

```sh
sqlite3 ~/.bb/bb.db ".timeout 5000" "update environments set owner_thread_id = null, claim_path = null where id = '<env>' and owner_thread_id = '<owner>' and status = 'ready'"
```

bb retries the refused messages on its own within minutes.

PR colours: amber and animated while checks run, green when ready, red when
failing or conflicting, grey with a warning when the preview comment was built
from an older commit than the PR's head.

Really red CI on an open PR is always someone's (`ci.ts`). Once per PR head,
the task that owns the PR is told to fix it, or an open PR no task owns gets a
"Fix failing CI" task of its own (at most one new task per pass, so a backlog
of stale red PRs does not start a burst). Both wait behind the usage and memory
gates like any new work: deferred, never dropped, and retried on the liveness
beat. Cancelled, skipped, neutral and stale runs (a concurrency group cancelling
a run when a newer push lands) do not count as failures.

## The sidebar

The app's left sidebar lists The Orchestrator's projects and tasks instead of
every thread: one row per project, named for the project, with the same badges
as the tabs, which opens that project's board (never its Patches chat), and
under the project in view its open tasks with their research and build
threads, each opening its task, then "Other agents (N)", counting what the
board lists there (not Older, not closed tasks' threads). Every row opens on
the board; on the board, a task row opens the task's chat and its Research or
Build cell opens that researcher's or builder's chat, both with the right side
narrowed to that task, and a hidden project's name in the rail opens its board. The board switches the sidebar to this list once, the first
time it opens. To go back to the full thread list, pick it under **Settings →
Appearance → thread list**; the board never switches it again.

## How a task moves

1. The owner presses "+" next to Tasks (or on the project's sidebar row) and starts
   the task directly in its own clean chat: every chat belongs to a task. (The
   project's Patches chat still runs behind the scenes; when she calls
   `start_task` it records a dossier and starts a task thread under her chat,
   in the project's main checkout (read-only), always in her own project.)
   A task started with "+" gets its own chat: their first message becomes its brief,
   it is created the same way (`task_new`, `newtask.ts`) and hangs under that
   project's Patches, and it names any open task the ask belongs to before
   doing anything. A project with no Patches chat yet has it started first,
   in its own project: never another project's chat. Its title
   starts as the brief's first sentence; a few seconds later the cheapest
   model (`TITLE_MODEL`, one `claude -p` on the host) summarises the brief
   into a short title for the board and the thread. If that fails, or the
   title was changed meanwhile, the first sentence stays.
2. The task checks the premise, plans, records decisions, and asks at most 3
   questions through `ask_sam` — one ticket, answered from the board: asks
   join the task's one open ticket, and `replace: true` supersedes its
   questions. Each ask
   says exactly what the owner does: a decision with options and the task's pick, or
   a command only they can run (their login, account or device). Anything else the
   task runs itself (`attention.ts`).
3. `build(touches)` claims files (refused on overlap with another task, and
   above 4 builds in flight), creates `<repo>/.claude/worktrees/<slug>` on its
   own branch, copies `.env*`-style files, installs dependencies, and starts a
   builder thread in that worktree. A failed build (setup, worktree, or a
   builder that dies) goes back to the task to fix; the next build reuses its
   worktree. The owner sees it, with Retry and Dismiss, only after 2 failures. A
   task with an open PR builds its next round on that PR's head branch (read
   from GitHub, fast-forwarded to its head), never a new branch from main:
   one PR per effort (`prbranch.ts`).
4. `open_pr` pushes the branch (never forced, never a default branch) and opens
   the PR. With a PR already open it pushes to that PR's head branch, a
   checked fast-forward when the worktree is on another branch, and reports
   "pushed to PR #N" only once GitHub shows #N's head at the pushed commit.
   `ready_for_review` validates it for the head commit — checks,
   preview, E2E and iOS sticky comments — adds `ai-tests` last, then hands the owner
   the PR with a test list derived from the diff.

   Claims hold at hand-off too: `open_pr`, `ready_for_review` and `land`
   refuse a branch that changes any file outside its task's claims
   (`outsideClaims`), naming the files. Nothing is widened automatically: the
   task widens its claims with `build(touches, claimOnly: true)`, which
   re-checks overlaps and starts nothing, or drops those changes. A claimed
   `package.json` implies the lockfile in its own directory (never a root
   lockfile shared by nested packages); generated files must be claimed, and a
   rename counts both its old and new path. An adopted PR that was never built
   is not checked.
5. The owner tests and merges. A merged or closed PR closes the task, releases its
   claims and removes its worktree if nothing is uncommitted or unpushed.

Merging anything that deploys is never automated. The one exception is The
Orchestrator's own repo (profile `land: "main"`): a local app in development,
where a task's `land` rebases its branch onto main and fast-forwards the main
checkout — no PR — removes its worktree, pushes main to its private GitHub
backup (`origin`, never forced; a failed push is reported and the land stands),
then runs `bb plugin build` in the main checkout. A failed build goes back to
the task (`failBuildFor`), never un-landed. When it passes, `bb plugin reload
the-orchestrator` starts detached, a second later, writing its exit code and
output to a file; land replies "reload started, not live yet" and the task
stays open, its reload pending in meta (`reload_pending:<id>`). Old and new
instances check it every 2 s (`reload.ts`): exit 0 seen by an instance started
after the land closes the task and tells its thread "Reloaded"; a non-zero
exit, or nothing after 3 minutes, is a failed build of the task's, with bb's own
reason (`bb plugin list --json`). Nobody reloads or archives a landed task by
hand.

A task with several build-and-land steps passes `more` to land: what is still
left, one step per line (`steps.ts`). The steps and the landed commit are
recorded in meta (`steps_left:<id>`) when it lands, and once the reload is live
the task is not closed: its claims and build slot go back, it returns to the
first column as "Step landed, N left", and its thread is told to carry on and
call build again for the next step. Neither the landed check nor a `Done:`
report closes a task with steps left. The final land omits `more` and closes
it as usual; `release_task` with close, deleting or archiving it close it too,
and every close drops the record. A failed build or reload keeps it. No
successor task per step.

A failed build or reload also rolls `dist/` back to the last good build,
and a branch that changes a guard must change and pass its tests before it
lands: see Recovery.

Work can reach main without `land` (a task that committed on main itself). A
research- or build-stage task still closes as "Landed on main" when a commit on
main (local or origin), newer than the task, is its own — it carries its
`Orchestrator-Task: <id>` trailer, or is its branch's tip or its verifiedSha —
and nothing of the task is open: no build in flight or failed, no reload
pending, no open ticket, no thread of it running (`landed.ts`; checked when the
task thread goes idle and once a minute from the liveness loop). A sha its
report only mentions never counts: a report may name another task's commit.
Until then the board's first column says what the task is doing: Planning only
while its thread runs, else Waiting on ⟨the owner's first name⟩, Step landed, N left, "Done, with a follow-up", Says
landed ⟨sha⟩ not closed, Waiting to plan, Not running, or Idle · waiting on
Patches.

A research-only task (no build, branch, worktree, PR, claim, open ticket or
running thread) has no commit or PR to prove it finished, so its own word has
to do: it closes as "Done" when its last report's status line leads with done
(`Done: …`, `Status: Done. …`, `Status: task complete`; not "Step 1 done", not
"done but waiting") and its thread has then sat idle for 30 min with all of
that still true (`done.ts`; the note records the status line). The grace
period is the check: a thread that is not finished gets messaged, works again
and resets it. Checked with the landed check, for every project.

A done report that still names work left (a `Left: <item>` line, which task
threads put above their `Done:` line, or "open item", "after approval",
"follow-up", "TODO", "once X, do Y" and the like; "nothing left" does not
count) is not closed: the board shows "Done, with a follow-up" and the task's
Patches chat is told once, with the item quoted, to start a follow-up task or
ask the owner, then close it with `release_task`. A task that lands on main still
closes, and Patches is told the same way if its report names work left.

A closed task's chats (task, research and build threads) are archived 10 min
after it closes, by the liveness loop, skipping any thread still working until
the next pass. One switch turns it off: **Archive chats of done tasks after 10
min** in Completed (meta `archive_closed_chats`, on by default). Archived
threads can be restored from Archived. They stay readable on the board: open
the task from **Completed** (see Board above); that reads the chat and the
dossier and never unarchives it.

The owner can delete a task with the **×** on its row (after a confirm). It closes
the task ("Deleted"), releasing its claims and build slot, stops and archives
its task, research and build threads (archived, not erased), and removes its
worktree only if nothing is uncommitted or unpushed; otherwise it keeps it and
says why. It never closes a PR or deletes a branch, local or remote: those are
the owner's. On a task already in Completed it only archives and cleans up.

Worktree cleanup runs whenever a task closes (land, release_task, the landed
auto-close, a stale close, delete) and again from a sweep 10 s after the
plugin starts and then hourly: every closed task that still records a
worktree is tried again (`worktrees.ts` sweepTargets). land waits for its
cleanup before the reload, which used to abort `git worktree remove` midway.
A worktree whose only changes are deleted tracked files (that aborted
removal) is half-removed, not dirty (`porcelainDirty`): with nothing unpushed
it is removed with `--force`. An untracked symlink (a builder's node_modules
link) holds nothing either. Anything else untracked or modified, or any
unpushed commit, still keeps it, with the reason on the task. A recorded
folder that no longer exists clears the task's record.

The sweep also takes orphans, folders under `.claude/worktrees` no task
records (`orphanDecision`): an unregistered folder holding no files is
removed, a registered worktree only when clean, every commit on main or
patch-equivalent (`unlandedCommits`), no process inside it, idle an hour.
Each kept one is logged: `worktree sweep: kept <path>: <reason>`.

A thread's tools and instructions are fixed when bb starts it, which is before
`threads.spawn` returns the id the dossier records. `configure` therefore falls
back to the spawn's metadata (`roles.ts`): a task still waiting for its thread,
or a child hanging under its task's thread. Without it task threads started
with no `build`/`land` tools and committed on main by hand.

The tool schemas are fixed then too: a parameter added by a later land is
unknown to a thread started before it, and the model sends it untyped. Boolean
tool params therefore also take the strings "true" / "false" (`flag()`,
`toolargs.ts`); any other new param is unusable from an old thread until it
restarts (the owner restarts the chat as a fresh session).

Claims (and the build slot) go back when the task's work is finished: its PR
merges or closes (matched by number, or by branch if the PR moved after the
task began), its branch is gone locally and on origin with its last seen tip
on the default branch (merged through another task's PR), it lands, or its
thread is archived. Each release is recorded in the dossier with its reason
(`task_status` shows them). When a build is refused for overlap, the repos are
re-read first so a finished holder releases before the refusal stands. For
anything the board cannot see, Patches has `release_task` (optionally
closing the task); tasks do not.

An open questions ticket is open work. The automatic closes (land's reload-live
or no-reload close, a merged or closed PR, a gone branch) give its claims back
but leave the task open until the owner answers or the ticket is withdrawn
(`tickets.ts`). A task withdraws only its own ticket, Patches any in her
project, through `ask_sam` withdraw `{ticket, questions?, reason}`; the reason
is recorded in the dossier.

### Builder guard

bb has no spawn-level sandbox or network setting and no tool-call hook (its
only hook is `message.dispatch`), so builders are guarded through Claude
Code's own settings in the worktree. `prepareWorktree` writes
`<worktree>/.claude/settings.local.json` (keeping what includes put there,
e.g. an MCP setup; `guarded: true` in its result, or no builder starts):

- `sandbox`: on, `failIfUnavailable`, `allowUnsandboxedCommands: false` (no
  `dangerouslyDisableSandbox` escape), network only to `registry.npmjs.org`.
  Writes only under the worktree (and the temp dir). Builders need no network:
  the host runs setup (`npm ci`), and open_pr and land push host-side.
- `permissions.deny`: `Read` of the main checkout's `.env*` and
  `mobile/.env*` (plus the profile's env-like includes), `Bash(git push:*)`,
  and `Edit` of the worktree's own `.claude/`.
- A PreToolUse hook on Bash: `node <plugin>/builderguard.ts <worktree>`
  (`|| exit 2`, so no node or a crash blocks the call). `checkCommand`
  refuses `rm -r` outside the worktree (or of it), every `git push`, prod DB
  and infra CLIs (vercel, eas, neon, supabase, psql and friends off
  localhost, drizzle-kit/prisma migrations without a local `DATABASE_URL`,
  non-GET curl/wget off localhost), reading the main checkout's env files,
  and e2e runs (Playwright, `e2e*` scripts, maestro,
  `scripts/ios-e2e-local.sh`): a project's Playwright config may load the real
  `.env`, which is the production DB. It follows `sh -c`, `$(...)`, `eval`,
  `xargs`, wrappers (`sudo`, `env`, `npx`, ...) and `npm`/`pnpm`/`yarn`
  scripts through package.json, five levels deep. What it can't parse it
  refuses.

The builder spawn pins `permissionMode: "auto"`: "full" would bypass the
sandbox. What this does not cover: code inside a script file (`node x.js`,
`bash deploy.sh`) is not inspected, so the sandbox is the real boundary and
the hook the second line (Claude Code #88462); in auto mode Claude Code may
still approve a per-command `allowed_domains`; and the worktree's own copies
of included env files stay readable until the owner decides what builders get.

## The chat mic

The composer's mic transcribes on this Mac, not through OpenAI: The
Orchestrator registers the voice service `local` (model `apple`), which
decodes the recording with ffmpeg and runs Apple's on-device speech
(SpeechAnalyzer on macOS 26, which downloads the language's model on first
use; on-device SFSpeechRecognizer before that). It needs Homebrew ffmpeg
(`brew install ffmpeg`) and the Xcode command line tools, since the small Swift
helper is compiled on first use into `~/Library/Caches/the-orchestrator/voice/`.

```
bb-app config set BB_TRANSCRIPTION local/apple            # on-device
bb-app config set BB_TRANSCRIPTION codex/gpt-transcribe   # back to Codex/OpenAI
```

If macOS asks, allow "The Orchestrator Transcriber" under System Settings →
Privacy & Security → Speech Recognition.

## First run

The first time the board opens on an install with no projects and no folder in
its config, a setup wizard opens by itself (`setupwizard.ts` `needsSetup`). An
install that already has projects never sees it uninvited; **Set up…** under
Add project opens it any time. It asks for:

- **Your first name**, prefilled from git's `user.name`. It is written to the
  config only when you change it.
- **The folder The Orchestrator may work in**, prefilled with
  `~/Documents/Github`. It must be inside your home folder and not the home
  folder itself; the app checks as you type and the host checks again against
  the real home directory, symlinks followed. Add project makes new folders
  there.
- **Which repos to add.** The host lists the folder's immediate subfolders
  (no dot-folders, no symlinks, at most 200) and says which have a `.git` and
  their origin. Nothing is ticked for you; projects already added show as
  added. None found is fine: add projects later.
- **Sign-in**, shown only: GitHub (`gh api user`) and Claude (`claude auth
  status`, and signed out whenever an agent turn has failed on sign-in), each
  with who is signed in or the command to run. No token or credential file is
  read.

Save writes `projectsDir` (and the name) into
`~/.config/the-orchestrator/config.json`, keeping every other key, through a
temp file renamed into place (0600). A file that has a problem is never written
over: the wizard says what is wrong and saves nothing. Then each ticked repo is
added the way Add existing folder… adds one, each with its own result; the
first one is opened.

## Your own project rules

The rules for your own projects, and your Chrome account, are not in this
repo. They are in one file on your machine:

`~/.config/the-orchestrator/config.json`

With no file, every project gets the default profile (a PR, no CI gates,
`CLAUDE.md` held whole) and browser agents use whichever Chrome has the Claude
extension connected. Nothing writes the file: you do. Every key is optional.

| Key | Holds |
| --- | --- |
| `ownerName` | What agents and the board call you, 1 to 40 characters. Absent: the first word of `git config --global user.name`, and "the owner" when git has none. Tool names never change. A new name reaches tool descriptions at the next start. |
| `chromeAccount` | The Google account of the Chrome profile browser agents use, or `null`. With one set, an agent picks the connected browser signed in as it and no other. |
| `projectsDir` | An absolute path, inside your home folder, to the folder The Orchestrator may work in: Add project makes new folders there and the setup wizard lists its repos. Without it: `~/Documents/Github`. The setup wizard writes it. |
| `profiles` | Up to 50 project profiles, each with every field of `ProjectProfile` in `profiles.ts`: `key`, `names`, `remotes` (`owner/repo`), `checks`, `ci`, `markers`, `iosPaths`, `aiTestsLabel`, `aiRanPatterns`, `sharedPaths`, `mirrors`, `build`, `land`, `backup`, `afterLand`, `worktreeInclude`, `productionEnv`, `setup`, `testRules`, `rules`. |

A project finds its profile by its GitHub remote, then by its name: yours
first, then the built-in one for The Orchestrator itself, then the default.

The file is read when The Orchestrator starts and every 30 s after, so an
edit takes effect without a reload. A file that is wrong is not used at all,
not even its good parts, and it is said out loud:

- one red line at the top of the board with the first thing wrong;
- `build`, `open_pr` and `ready_for_review` refuse for every project except
  The Orchestrator's own, with the same sentence, until the file loads.
  Falling back to the default profile would drop a project's ai-tests gate,
  its held paths and its production-env rule.

What makes a file wrong: not JSON, over 200 KB, an unknown key, a wrong or
missing field, two profiles with one key, or a profile with the key `default`
or `the-orchestrator`. Two rules hold whatever the file says:

- **`land: "main"` is refused.** Merge is a production deploy; only the
  built-in Orchestrator profile lands on main.
- **A `productionEnv: true` profile never copies an env file.** A
  `worktreeInclude` pattern that could match `.env*` makes the file wrong, and
  the build drops such a pattern again when it makes the worktree
  (`worktreeIncludeOf`).

A failed read (the host not answering) keeps the last file read. Before the
first read, the same three tools refuse.

The file is in no git repo, so it is yours to back up. Each time a valid file
is read and differs from the last copy, the host keeps one copy of it at
`local-config.last-good.json` in the plugin's data dir, next to `last-good/`
(see Recovery). That is one copy on the same disk, not a backup.

## Recovery

The Orchestrator lands its own code on main and reloads itself, so a bad land
could leave it unable to load after a restart of bb. What bb allows, and what
it does not:

- bb loads this plugin from its install path, the main checkout: `<repo>/dist/`
  after `bb plugin build`. A path install has no pinned build and no version
  history, and there is no way to point the plugin at another build folder
  without reinstalling it. So the fallback has to be a working `dist/`.
- When `bb plugin reload` fails before the new instance starts, bb keeps the
  previous instance running (status "running", statusDetail "reload failed:
  …"). That old instance is the one that sees the reload failed.

**Last-good build** (`recovery.ts`, host `keepLastGood` / `restoreLastGood`).
When a reload is confirmed live and no other reload is pending (another land
may have rebuilt `dist/` since), the host copies `<repo>/dist/` to
`last-good/` in the plugin's host data folder (`experimental_paths.dataDir`,
under `~/.bb`), with its sha, built beside it and swapped in whole. When a
reload fails, or the build after a land fails (a half-written `dist/`), the
host copies `last-good/dist` back over `<repo>/dist` (via `dist.rollback-tmp`
and `dist.bad`), so a restart of bb loads the last good build. main still has
the bad commit: the task is told, through `failBuildFor`, with "dist/ restored
to last-good <sha>" or why nothing was restored (none kept yet). A later
`bb plugin build` replaces the restored `dist/` as usual.

**Dossier snapshots.** Before any pending migration, and once a day (checked
at start and hourly; meta `dossier_snapshot_at`), the server writes a
consistent copy of the dossier with SQLite's `VACUUM INTO` (never a file copy)
to `~/.bb/plugins/the-orchestrator/snapshots/dossier-<UTC stamp>-<daily|migration>.db`.
The newest 14 are kept. They stay on this Mac, outside the repo, and are never
pushed anywhere. A failed snapshot is logged and never stops the plugin
loading or migrating. To restore one by hand:

```
bb plugin disable the-orchestrator
cp ~/.bb/plugins/the-orchestrator/snapshots/dossier-<stamp>-<reason>.db ~/.bb/plugins/the-orchestrator/data.db
rm -f ~/.bb/plugins/the-orchestrator/data.db-wal ~/.bb/plugins/the-orchestrator/data.db-shm
bb plugin enable the-orchestrator
```

**Guard files** (`landguard.ts`). `memory.ts`, `guard.ts`, `claims.ts`,
`reload.ts`, `recovery.ts` and `landguard.ts` guard the Mac and The
Orchestrator's own loading; `landed.ts` and `done.ts` decide when a task
closes. If a branch changes one (a repo-root path), it
must change its `<name>.test.ts` too, and `land` runs those tests in the
worktree (`npx vitest run`, host `runGuardTests`) after the claims check.
A missing test change or a failing run refuses the land; nothing lands. A
guard changes with its tests: mutation-check them.

## Jev (watch only)

Jev is a typed-decision model: asked a question with fixed answers, it gives a
label and a probability for each. "Jev before Opus" is the first rung: for
each new task, The Orchestrator asks Jev two questions in the background, what
**kind** of task it is (research or build) and what **tier** (small, medium,
large). The answer goes in the dossier (`jev_watch`). When the task closes,
what really happened is written next to it: a build child means build;
failures, two builds or questions to the owner mean large; no build or at most 3
files means small; anything else is medium. The project board shows one line,
for example "Jev (watch only): kind 10/12 agree · tier 7/10 · 1 risky miss · 3
errors". Hover it for the confusion table and latency. The line is hidden
until the project has a row.

- **Watch only.** Nothing Jev answers changes what The Orchestrator does. The
  only uses of an answer in `server.ts` are storing it and the board report,
  and `jevwatch.test.ts` fails if that changes. Steering is a later rung that
  the owner turns on.
- **Never in the way.** The ask is fire-and-forget: it is never awaited when a
  task is created. It is capped at 2 s, body included (`JEV_TIMEOUT_MS`).
  After a failure, nothing is asked for 5 minutes. The host reads
  `~/.config/jev/state.json` and `clients.env`. With no box up, or no key, the
  ask is "off": no network call and no row.
- **The box.** `node jev/cli.ts up|down|status|dry-run` rents one Verda box in
  Helsinki, with a key for each client project. The
  box deletes itself after 15 idle minutes or 4 hours, and a $20 cap applies.
  See [jev/README.md](../jev/README.md). `jev up` never runs without the owner's ok.

## Files

| File | Holds |
| --- | --- |
| `server.ts` | Dossier store wiring, agent tools, `configure` instructions, board RPC |
| `host.ts` | git and gh on the machine with the checkouts; the mic's on-device transcription |
| `voice.ts` | The `local/apple` voice service: request limits, ffmpeg arguments, error mapping, the Swift helper's source |
| `store.ts` | SQLite dossier: tasks, claims, releases, tickets, child threads, project prefs |
| `claims.ts` | Overlap rules for `touches`; which builds waiting on claims to wake |
| `release.ts` | When a task's work is finished and its claims go back |
| `ci.ts` | Red CI on an open PR: tell the owning task, or start a Fix failing CI task, once per head |
| `landed.ts` | A task's own commit on main (trailer, branch tip, verifiedSha), and when that closes it |
| `reload.ts` | After land: when the pending reload is live (close, or keep open with steps left) or failed (back to the task) |
| `steps.ts` | A multi-step task: land's `more` as steps left, the record, when a land keeps its task open, what its thread and the board are told |
| `recovery.ts` | When to keep the last-good build, the rollback note, dossier snapshot names, when one is due and which to prune |
| `landguard.ts` | land's guard-file rule: a guard changes with its tests, and which tests land runs |
| `done.ts` | A research-only task that says done and sat idle 30 min; a report naming work left goes to Patches as a follow-up instead; when a closed task's chats are archived |
| `roles.ts` | Which task a thread works for at `configure`, before the dossier has its id |
| `validation.ts` | Stale preview, PR verdict, test-list derivation |
| `model.ts` | Board rows, needs-you grouping, tab badges, how a closed task finished, colours |
| `activity.ts` | The Live box: a thread's item events as terminal lines (command and output tail, read, edit, tool call, message), the limits, secret masking, which threads get a pane |
| `archive.ts` | Closed tasks: a project's list (search, newest first, paged), per-project counts, the dossier summary, the `closed:` route, which chat to show |
| `others.ts` | Other agents: which threads, their live state, Older, the sidebar count, which loose threads the liveness check probes |
| `liveness.ts` | Is each task's agent alive: working, waiting, stale, errored, dead build; who is told |
| `usage.ts` | Claude usage in the header, the 90% pause on new builds and research, bringing agents back after a limit |
| `signin.ts` | Claude signed out: the one Needs you item, holding turns and starts, retrying each failed turn once after sign-in |
| `sidebar.ts` | The sidebar list's rows and the one-time switch to it |
| `chats.ts` | Patches chat keys, each chat's own tasks and refusals, what a project click opens, when opening starts a chat, unread rule, which task threads to re-attach under their chat |
| `newtask.ts` | The owner's "+": when it is off, the parent chat, title and brief from their first message |
| `owner.ts` | The owner's first name for every prompt and the board: the config's `ownerName`, else git's `user.name`, else "the owner" |
| `prompts.ts` | Every instruction an agent gets (Patches, task, research, builder) |
| `profiles.ts` | Per-project checks and rules, as data: the built-in profiles, and how a project finds its own |
| `localconfig.ts` | The owner's local config: its schema, what makes a file refused, what is refused while it is |
| `setupwizard.ts` | The setup wizard: when it opens, which folder is allowed, which repos can be ticked, the config file's new text, what a sign-in check means |
| `newproject.ts` | Add project: slug, name checks, first files, the private `gh repo create`, the visibility check |
| `worktrees.ts` | Worktree naming, `.worktreeinclude`, cleanup rule, half-removed worktrees, the cleanup sweep |
| `jevwatch.ts` | Jev, watch only: the two questions, reading an answer, the host's bounded ask, the actual outcome, the agreement report |
| `jev/` | The Jev box: `cli.ts` (up, down, status, dry-run), `policy.ts` (cap, watchdog, Verda bodies, ledger), `box/` (setup, Caddy, watchdog, AnyJev shim) |
| `builderguard.ts` | The builder guard: the Bash hook's command policy and the worktree's sandbox settings; node runs it directly |

## Memory

The Orchestrator reads the Mac's free memory, and every process bb's agents
started (the agent tree), every 10 s. At most 4 agents work at once; below
20% free, or with the agent tree at 40% of RAM, new agent turns wait (queued,
with the reason), and `build` refuses below 30% or at 40%. At 55% of RAM in
the tree, or one agent process at 25%, it kills the largest agent process
with its process group (a shell's `cmd &` children go with it) and tells its
thread; never claude, bb, Chrome or anything under /Applications/. Below 10%
free it stops the newest builder, then research, then tasks. It logs
"memory guard: live" on its first reading and a heartbeat every 10 minutes.
Keep `./memwatch.sh` running in a terminal tab as the backstop: it watches
bb's whole process tree, kills the largest process before the Mac runs out,
and logs every sample to `.memwatch/`.

One agent at a time uses the owner's Chrome: the `browser` tool's lease, in at most
3 tabs of its own, closed and released when its pass ends.
