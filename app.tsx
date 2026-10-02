// The Orchestrator — frontend entry.
//
// One page: a project rail on the left and the selected project's board —
// what needs the owner, one row per task through Research → Build → PR → You, every
// other agent, and the project's PRs — full width, with no chat. Opening a
// task puts its chat in a fixed column and narrows the right side to that
// task's own work (scope.ts); a closed task opens from Completed with its
// archived chat, read-only, and its dossier summary (archive.ts). Thread state
// is read live from the host; the dossier and repo state come from this
// plugin's server.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  definePluginApp,
  experimental_NewThreadComposer as NewThreadComposer,
  experimental_useSidebarThreads,
  ThreadChat,
  ThreadTitle,
  UrlLink,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSdk,
  type PluginNavPanelProps,
  type PluginSidebarThread,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import type { BoardState, ClosedTaskRow, ClosedTaskView, LivenessView, ProjectView, Repos, SetupList, SetupSaved, SetupState, TaskActivity, TaskView, rpcContract } from "./server";
import {
  LIVENESS_INTERVAL_MS,
  agentIndicator,
  connection,
  taskIndicator,
  type Indicator,
  type Trouble,
} from "./liveness";
import type { PullRequest } from "./contract";
import { usageLabel, usageWarning } from "./usage";
import { SIGN_IN_BUTTON, signInPopup, signInPopupOpen, signedOutItem } from "./signin";
import { reportDetail, reportLine } from "./jevwatch";
import { SONNET_THRESHOLD, routeLabel, routeTooltip, routingLine } from "./modelroute";
import { keyProblemText } from "./typesafe";
import {
  BUILD_CAP,
  PALETTE,
  assignColors,
  colorValue,
  completionLabel,
  completionOf,
  isWorking,
  needsYou,
  prForTask,
  relativeTime,
  tabBadges,
  taskRow,
  untrackedPullRequests,
  type Cell,
  type NeedsYouItem,
  type TabBadge,
  type TaskRow,
} from "./model";
import { projectSlug, validateNewProject } from "./newproject";
import { DEFAULT_PROJECTS_DIR, signInLine, validateProjectsDir } from "./setupwizard";
import { focusedProject } from "./chats";
import { ACTIVITY_IDLE_POLL_MS, NOTHING_RUNNING, activityPollMs } from "./activity";
import { CLOSED_PAGE_SIZE, closedChatThread, closedPath } from "./archive";
import {
  boardScope,
  inScope,
  scopeThread,
  showsChat,
  showsProjectSections,
  taskThreads,
  type BoardScope,
  type ScopeThread,
} from "./scope";
import { newTaskBlock, taskNewInput } from "./newtask";
import { OWNER_FALLBACK, OWNER_NAME_MAX, setOwner } from "./owner";
import { answersFor, withAnswer, type AnswerDraft } from "./answers";
import { otherAgentsView, othersOpen, type OtherAgentsView, type OtherEntry } from "./others";
import { reviewStale } from "./review";
import { THREAD_LIST_ID, shouldAdoptSidebar, sidebarRows, type SidebarRow } from "./sidebar";
import type { Task, Ticket } from "./store";
import { prTone, type PrTone } from "./validation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn, formatHomePathForDisplay } from "@/lib/utils";
import "./app.css";
import patchesAvatar from "./assets/patchesAvatar";

const PANEL_PATH = "board";
const STATE_POLL_MS = 15_000;
const REPO_POLL_MS = 30_000;
const FOCUS_POLL_MS = 8_000;
const PATCHES = "Patches";
/** Seed only: the owner can pick another provider in the composer. */
const PATCHES_PROVIDER = "claude-code";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** The board sub-path that composes a new task for the focused project. */
const NEW_TASK_PATH = "new";

/** Why "+" is off for a project (null: none to work in), or null when it may start a task. */
function newTaskBlockFor(state: BoardState, projectId: string | null): string | null {
  return newTaskBlock({ project: state.projects.find((project) => project.id === projectId) ?? null });
}

const DELETE_CONFIRM =
  "Delete task and its chats?\n\nIts chats are archived, not erased: you can restore them from Archived. Its worktree is removed only if nothing is uncommitted or unpushed. Open PRs and remote branches are left for you.";

type DeletableTask = Pick<TaskView, "id" | "title">;

/** The owner's ×: deletes the task (task_delete) after a confirm. Never opens the row it sits on. */
function DeleteTaskButton({ task, onDelete }: { task: DeletableTask; onDelete: (task: DeletableTask) => void }) {
  return (
    <button
      type="button"
      aria-label="Delete task"
      title="Delete task"
      className="orc-delete"
      onClick={(event) => {
        event.stopPropagation();
        onDelete(task);
      }}
    >
      ×
    </button>
  );
}

/** The owner's "+": starts a task in its own clean chat. The span carries the tooltip, which a disabled button would not. */
function NewTaskButton({ blocked, onClick }: { blocked: string | null; onClick: () => void }) {
  return (
    <span className="flex shrink-0" title={blocked ?? "New task"}>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 text-muted-foreground"
        aria-label="New task"
        disabled={blocked !== null}
        onClick={onClick}
      >
        <Icon name="Plus" className="size-4" />
      </Button>
    </span>
  );
}

// ---------------------------------------------------------------- data hooks

function useBoardState(rpc: Rpc) {
  const [state, setState] = useState<BoardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    rpc.call("board_state", {}).then(
      (next) => {
        // This bundle's own copy of the name (owner.ts), before anything renders with it.
        setOwner(next.ownerName);
        setState(next);
        setError(null);
      },
      (cause: unknown) => setError(message(cause)),
    );
  }, [rpc]);
  useRealtime("dossier", load);
  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, STATE_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);
  return { state, error, reload: load };
}

function useRepos(rpc: Rpc) {
  const [repos, setRepos] = useState<Repos | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(
    (force: boolean) => {
      setRefreshing(true);
      rpc
        .call("repos_snapshot", { force })
        .then(
          (next) => {
            setRepos(next);
            setError(null);
          },
          (cause: unknown) => setError(message(cause)),
        )
        .finally(() => setRefreshing(false));
    },
    [rpc],
  );
  useEffect(() => {
    load(false);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load(false);
    }, REPO_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);
  return { repos, error, refreshing, refresh: () => load(true) };
}

/** What each working agent is on right now: its in-progress todo. */
function useWorkingFocus(threadIds: readonly string[]) {
  const sdk = useSdk();
  const [focus, setFocus] = useState<ReadonlyMap<string, string>>(new Map());
  const key = threadIds.join(",");
  useEffect(() => {
    if (key === "") {
      setFocus(new Map());
      return;
    }
    const ids = key.split(",");
    let cancelled = false;
    const poll = async () => {
      const entries = await Promise.all(
        ids.map(async (threadId) => {
          try {
            const status = await sdk.status.get({ threadId });
            const items = status.pendingTodos?.items ?? [];
            const current =
              items.find((item) => item.status === "in_progress") ??
              items.find((item) => item.status === "pending");
            return current === undefined ? null : ([threadId, current.text] as const);
          } catch {
            // A status hiccup just leaves the cell without a focus line.
            return null;
          }
        }),
      );
      if (!cancelled) setFocus(new Map(entries.filter((entry) => entry !== null)));
    };
    void poll();
    const timer = setInterval(() => void poll(), FOCUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sdk, key]);
  return focus;
}

/** The server's last liveness check, asked for once per beat: one call covers every task. */
function useLiveness(rpc: Rpc) {
  const [view, setView] = useState<LivenessView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      rpc.call("liveness", {}).then(
        (next) => {
          if (cancelled) return;
          setView(next);
          setError(null);
        },
        (cause: unknown) => {
          if (!cancelled) setError(message(cause));
        },
      );
    };
    load();
    const timer = setInterval(load, LIVENESS_INTERVAL_MS);
    // Back on screen: ask at once rather than show an old check as disconnected.
    document.addEventListener("visibilitychange", load);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [rpc]);
  return { view, error };
}

/**
 * Each task's indicator (spinner, waiting, trouble) and each of its threads':
 * the live status spins at once, the last check says stuck or waiting.
 */
function useIndicators(state: BoardState | null, threads: readonly PluginSidebarThread[], view: LivenessView | null) {
  return useMemo(() => {
    const byTask = new Map<string, Indicator>();
    const byThread = new Map<string, Indicator>();
    const trouble = new Map<string, readonly Trouble[]>();
    if (state === null) return { byTask, byThread, trouble };
    const live = new Map(threads.map((thread) => [thread.id, thread]));
    const checks = new Map((view?.tasks ?? []).map((entry) => [entry.taskId, entry]));
    for (const task of state.tasks) {
      const check = checks.get(task.id);
      if (check !== undefined) trouble.set(task.id, check.trouble);
      const mine = state.children.filter((child) => child.taskId === task.id);
      const liveWorking =
        task.buildState === "preparing" ||
        [task.threadId, ...mine.map((child) => child.threadId)].some((id) => id !== null && isWorking(live.get(id)));
      const indicator = taskIndicator(check, liveWorking);
      byTask.set(task.id, indicator);
      if (task.threadId !== null) byThread.set(task.threadId, indicator);
      for (const child of mine) {
        const agent = check?.agents.find((entry) => entry.threadId === child.threadId);
        byThread.set(child.threadId, agentIndicator(agent, isWorking(live.get(child.threadId))));
      }
    }
    return { byTask, byThread, trouble };
  }, [state, threads, view]);
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Each project's tint, as a CSS colour. */
function useProjectColors(projects: readonly ProjectView[]) {
  return useMemo(() => {
    const keys = assignColors(
      projects.map((project) => project.id),
      new Map(projects.map((project) => [project.id, project.color])),
    );
    return new Map([...keys].map(([id, key]) => [id, colorValue(key)]));
  }, [projects]);
}

const EMPTY: never[] = [];

/** What the plugin owns, what needs the owner, and the per-chat badges: one derivation for the board and the sidebar. */
function useAttention(
  state: BoardState | null,
  threads: readonly PluginSidebarThread[],
  trouble: ReadonlyMap<string, readonly Trouble[]>,
  /** Why a task's review ticket no longer holds; only the board has the PRs to tell. */
  staleReview?: (task: Task) => string | null,
) {
  const tasks = state?.tasks ?? EMPTY;
  const children = state?.children ?? EMPTY;
  const tickets = state?.tickets ?? EMPTY;
  const patchesChats = state?.patchesChats;
  const projects = state?.projects ?? EMPTY;
  const signedOut = state !== null && state.signedOut !== null;
  const owned = useMemo(() => {
    const ids = new Set<string>();
    for (const chat of patchesChats ?? []) ids.add(chat.threadId);
    for (const task of tasks) if (task.threadId !== null) ids.add(task.threadId);
    for (const child of children) ids.add(child.threadId);
    return ids;
  }, [patchesChats, tasks, children]);
  const needs = useMemo(
    () => needsYou({ tasks, tickets, children, threads, ownedThreadIds: owned, trouble, reviewStale: staleReview }),
    [tasks, tickets, children, threads, owned, trouble, staleReview],
  );
  const badges = useMemo(
    () => tabBadges({ needsYou: needs, tasks, children, threads, signedOut, projectIds: projects.map((project) => project.id) }),
    [needs, tasks, children, threads, signedOut, projects],
  );
  return { owned, needs, badges };
}

/**
 * Once: put The Orchestrator's list in the sidebar, unless the owner already picked
 * one. The dossier records it, so switching back in Settings → Appearance sticks.
 */
function useAdoptSidebar(state: BoardState | null, rpc: Rpc) {
  const sdk = useSdk();
  const provider = state?.sidebar.provider ?? null;
  const adopted = state?.sidebar.adopted ?? true;
  useEffect(() => {
    if (provider === null || adopted) return;
    let cancelled = false;
    void (async () => {
      try {
        const current = (await sdk.system.uiPreferences.list()).preferences["sidebar.threadListProvider"];
        if (cancelled) return;
        if (shouldAdoptSidebar(current.value, adopted)) {
          await sdk.system.uiPreferences.set({
            key: "sidebar.threadListProvider",
            value: provider,
            expectedRevision: current.revision,
          });
        }
        await rpc.call("sidebar_adopted", {});
      } catch (cause) {
        // Not recorded, so the next board visit tries again.
        console.warn("The Orchestrator: could not switch the sidebar list", cause);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sdk, rpc, provider, adopted]);
}

// ------------------------------------------------------------ presentational

/** Project tint: the one inline colour on the page, as a CSS variable. */
const tint = (color: string): CSSProperties => ({ ["--orc-project" as string]: color });

function Chip({ children, title, className }: { children: ReactNode; title?: string; className?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex max-w-full items-center gap-1 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}

function Dots() {
  return (
    <span aria-hidden className="orc-dots">
      <span />
      <span />
      <span />
    </span>
  );
}

function WorkingLine({ focus, fallback }: { focus: string | undefined; fallback: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-foreground">
      <Dots />
      <span className="truncate" title={focus ?? fallback}>
        {focus ?? fallback}
      </span>
    </span>
  );
}

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-xs text-destructive">
      {children}
    </p>
  );
}

/** The row's liveness mark: a spinner while an agent works, a clock while one waits, a warning when stuck. */
function LiveMark({ indicator }: { indicator: Indicator }) {
  if (indicator === null) return null;
  if (indicator.kind === "working") {
    return <span role="img" aria-label="Working" title="Working (checked every 30 s)" className="orc-spinner" />;
  }
  if (indicator.kind === "waiting") {
    return (
      <span role="img" aria-label={indicator.reason} title={indicator.reason} className="orc-live-waiting flex shrink-0">
        <Icon name="Clock" className="size-3.5" />
      </span>
    );
  }
  return (
    <span role="img" aria-label={indicator.reason} title={indicator.reason} className="orc-live-trouble flex shrink-0">
      <Icon name="AlertTriangle" className="size-3.5" />
    </span>
  );
}

/** A Patches chat in trouble (liveness.ts chatTrouble), one line each; her chat is not shown, so the line says it. */
function ChatTroubleLines({
  chats,
  projects,
}: {
  chats: LivenessView["chats"];
  projects: readonly { id: string; name: string }[];
}) {
  if (chats.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 border-b border-border px-3 py-2">
      {chats.map((chat) => (
        <ErrorLine key={chat.threadId}>
          {PATCHES} · {projects.find((project) => project.id === chat.projectId)?.name ?? "a project"}: {chat.trouble}
        </ErrorLine>
      ))}
    </div>
  );
}

/** "Usage 72% · resets 18:00" in the header; amber near the limit, red at it. */
function UsageStatus({ usage }: { usage: LivenessView["usage"] }) {
  const now = useNow(30_000);
  if (usage === null) return null;
  const label = usageLabel(usage, now);
  return (
    <span
      title={`Claude usage, fullest window: ${usage.label}`}
      className={cn(
        "shrink-0",
        usage.level === "near" && "orc-live-waiting font-medium",
        usage.level === "limit" && "orc-live-trouble font-medium",
      )}
    >
      {label}
    </span>
  );
}

/** "Headroom: on · 1.2M tokens removed (8.6%)" in the header (headroom.ts headroomView); amber while it is down. */
function HeadroomStatus({ headroom }: { headroom: LivenessView["headroom"] }) {
  if (headroom === null) return null;
  return (
    <span
      title={`${headroom.line}. Every agent's requests go through the local Headroom proxy while it is healthy; when it is not, they go straight to Claude.`}
      className={cn("orc-headroom min-w-0 truncate", headroom.state === "down" && "orc-live-waiting")}
    >
      {headroom.line}
    </span>
  );
}

/** Near or at the limit: what that means for new work, one line under the header. */
function UsageWarningLine({ usage }: { usage: LivenessView["usage"] }) {
  const now = useNow(30_000);
  const warning = usageWarning(usage, now);
  if (warning === null) return null;
  return (
    <div className="border-b border-border px-3 py-2">
      <p role="status" className={cn("text-xs", usage?.level === "limit" ? "orc-live-trouble" : "orc-live-waiting")}>
        {warning}
      </p>
    </div>
  );
}

/** Jev's watch-only agreement for this project: one line, hidden with no rows. */
function JevWatchLine({ entry }: { entry: BoardState["jevWatch"][number] | undefined }) {
  const line = entry === undefined ? null : reportLine(entry.report);
  if (entry === undefined || line === null) return null;
  return (
    <div className="border-b border-border px-3 py-2">
      <p className="text-xs text-muted-foreground" title={reportDetail(entry.report)}>
        {line}
      </p>
    </div>
  );
}

type RouteView = BoardState["modelRoutes"][number];

/** How a thread's model was picked (modelroute.ts): "Sonnet · Jev 0.86" or "Default model", the reason in its tooltip. */
function RouteMark({ route }: { route: RouteView | undefined }) {
  if (route === undefined) return null;
  return (
    <span
      className="orc-route truncate text-[11px] text-muted-foreground"
      title={routeTooltip({ reason: route.reason, probability: route.probability, jevModel: route.answeredBy })}
    >
      {routeLabel(route)}
    </span>
  );
}

/** Jev's model routing for this project: agents on Sonnet in the last 7 days, or why there is none. Hidden while the host cannot say. */
function ModelRoutingLine({
  routes,
  projectId,
  routeKey,
}: {
  routes: readonly RouteView[];
  projectId: string | null;
  routeKey: BoardState["modelRouteKey"];
}) {
  const now = useNow(60_000);
  if (routeKey === null || projectId === null) return null;
  const line = routingLine(
    routes.filter((route) => route.projectId === projectId),
    now,
    routeKey,
  );
  const detail = routeKey.present
    ? `Jev picks Sonnet for a task, research or build agent when it is at least ${SONNET_THRESHOLD} sure; anything else keeps the provider default. Patches always does.`
    : keyProblemText(routeKey.problem);
  return (
    <div className="border-b border-border px-3 py-2">
      <p className="text-xs text-muted-foreground" title={detail}>
        {line}
      </p>
    </div>
  );
}

/** "Agents checked 12s ago", or Disconnected when the board has stopped hearing. */
function LivenessStatus({ checkedAt, error }: { checkedAt: number | null; error: string | null }) {
  const now = useNow(5_000);
  const state = connection({ checkedAt, error, now });
  return (
    <span
      role={state.kind === "disconnected" ? "alert" : "status"}
      title={state.label}
      className={cn("flex min-w-0 shrink items-center gap-1.5 truncate", state.kind === "disconnected" && "font-medium text-destructive")}
    >
      <span aria-hidden className={cn("orc-live-dot shrink-0", state.kind !== "live" && `orc-live-dot-${state.kind}`)} />
      <span className="truncate">{state.label}</span>
    </span>
  );
}

function AgentRestart({ taskId, rpc, reload }: { taskId: string; rpc: Rpc; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="flex flex-col gap-1" onClick={(event) => event.stopPropagation()}>
      <div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            rpc
              .call("agent_restart", { taskId })
              .then(
                (next) => {
                  setResult({ ok: true, text: next.message });
                  reload();
                },
                (cause: unknown) => setResult({ ok: false, text: message(cause) }),
              )
              .finally(() => setBusy(false));
          }}
        >
          Restart
        </Button>
      </div>
      {result === null ? null : result.ok ? (
        <p className="text-xs text-muted-foreground">{result.text}</p>
      ) : (
        <ErrorLine>{result.text}</ErrorLine>
      )}
    </div>
  );
}

const TONE_LABEL: Record<PrTone, string> = {
  running: "checks running",
  ready: "green",
  failing: "failing",
  stale: "stale preview",
  draft: "draft",
  merged: "merged",
  closed: "closed",
  open: "no checks",
};

function PrBadge({ pr, tone }: { pr: PullRequest; tone: PrTone }) {
  return (
    <span className={cn("orc-pr", `orc-pr-${tone}`)} title={`#${pr.number} · ${TONE_LABEL[tone]}`}>
      {tone === "stale" ? <Icon name="AlertTriangle" className="size-3" /> : null}
      <UrlLink
        href={pr.url}
        onClick={(event) => event.stopPropagation()}
        className="font-medium hover:underline"
      >
        #{pr.number}
      </UrlLink>
      <span>{TONE_LABEL[tone]}</span>
    </span>
  );
}

// ------------------------------------------------------------------ the rail

function ProjectRail({
  projects,
  colors,
  tasks,
  primaryHostId,
  projectsDir,
  onSetup,
  focusProjectId,
  onFocusProject,
  selectedTaskId,
  onSelectThread,
  newTaskBlocked,
  onNewTask,
  onDeleteTask,
  rpc,
  reload,
}: {
  projects: readonly ProjectView[];
  /** Where Add project makes the new folder (the local config's folder, else the default). */
  projectsDir: string;
  /** Open the setup wizard. */
  onSetup: () => void;
  colors: ReadonlyMap<string, string>;
  tasks: readonly TaskView[];
  primaryHostId: string | null;
  focusProjectId: string | null;
  onFocusProject: (projectId: string) => void;
  /** The task whose chat (or research/build thread) is open. */
  selectedTaskId: string | null;
  onSelectThread: (threadId: string) => void;
  newTaskBlocked: string | null;
  onNewTask: () => void;
  onDeleteTask: (task: DeletableTask) => void;
  rpc: Rpc;
  reload: () => void;
}) {
  const sdk = useSdk();
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [githubFailure, setGithubFailure] = useState<{ path: string; error: string; retry: string } | null>(null);
  const parentDir = projectsDir;
  const newCheck = validateNewProject(
    newName,
    {
      names: projects.map((project) => project.name),
      paths: projects.flatMap((project) => (project.path === null ? [] : [project.path])),
    },
    parentDir,
  );
  const visible = projects.filter((project) => !project.hidden);
  const hidden = projects.filter((project) => project.hidden);
  const shownTasks = tasks.filter((task) => task.projectId === focusProjectId);

  const run = (work: Promise<unknown>) => {
    work.then(
      () => {
        setError(null);
        reload();
      },
      (cause: unknown) => setError(message(cause)),
    );
  };

  const addFolder = async () => {
    if (primaryHostId === null) {
      setError("No machine to pick a folder on.");
      return;
    }
    try {
      const picked = await sdk.hosts.pickFolder({ hostId: primaryHostId, clientHostId: primaryHostId });
      if (picked.path !== null) addPath(picked.path);
    } catch (cause) {
      setError(`${message(cause)} Paste the folder's path instead.`);
      setTyping(true);
    }
  };

  const addPath = (path: string) => {
    if (primaryHostId === null) return;
    const clean = path.trim().replace(/\/+$/, "");
    if (!clean.startsWith("/")) {
      setError("Use the folder's full path, starting with /.");
      return;
    }
    const name = clean.split("/").pop() || clean;
    run(rpc.call("project_add", { hostId: primaryHostId, path: clean, name }).then((added) => onFocusProject(added.projectId)));
    setTyping(false);
    setTyped("");
  };

  const createProject = () => {
    if (primaryHostId === null) {
      setError("No machine to create the project on.");
      return;
    }
    if (!newCheck.ok || busy) return;
    setBusy(true);
    rpc.call("project_create", { hostId: primaryHostId, name: newName.trim() }).then(
      (made) => {
        setBusy(false);
        setError(null);
        setCreating(false);
        setNewName("");
        setGithubFailure(made.github.ok ? null : { path: made.path, error: made.github.error, retry: made.github.retry });
        onFocusProject(made.projectId);
      },
      (cause: unknown) => {
        setBusy(false);
        setError(message(cause));
      },
    );
  };

  const cycleColor = (project: ProjectView) => {
    const current = PALETTE.findIndex((entry) => entry.value === colors.get(project.id));
    const next = PALETTE[(current + 1) % PALETTE.length]!;
    run(rpc.call("project_prefs", { projectId: project.id, color: next.key }));
  };

  return (
    <nav aria-label="Projects" className="flex w-60 shrink-0 flex-col border-r border-border">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-sm font-medium text-foreground">Projects</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setCreating((value) => !value);
            setError(null);
          }}
          aria-label="Create a new project"
          aria-expanded={creating}
        >
          <Icon name="FolderPlus" className="size-4" />
          Add project
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {creating ? (
          <form
            className="mb-2 flex flex-col gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              createProject();
            }}
          >
            <div className="flex gap-1">
              <input
                aria-label="New project name"
                placeholder="Project name"
                value={newName}
                autoFocus
                disabled={busy}
                onChange={(event) => setNewName(event.target.value)}
                className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-2 text-xs text-foreground"
              />
              <Button type="submit" size="sm" disabled={busy || !newCheck.ok}>
                {busy ? "Creating…" : "Create"}
              </Button>
            </div>
            {newName.trim() === "" ? null : newCheck.ok ? (
              <p className="truncate font-mono text-xs text-muted-foreground" title={newCheck.path}>
                {newCheck.path}
              </p>
            ) : (
              <p className="text-xs text-destructive">{newCheck.reason}</p>
            )}
            <p className="text-xs text-muted-foreground">
              A new folder with a first commit, a private GitHub repo and its own {PATCHES} chat.
            </p>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                disabled={busy}
                onClick={() => {
                  setCreating(false);
                  void addFolder();
                }}
              >
                Add existing folder…
              </button>
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                disabled={busy}
                onClick={() => {
                  setCreating(false);
                  onSetup();
                }}
              >
                Set up…
              </button>
            </div>
          </form>
        ) : null}
        {githubFailure !== null ? (
          <div role="alert" className="mb-2 flex flex-col gap-1 rounded-md border border-destructive/40 p-2 text-xs text-destructive">
            <p>
              Created {githubFailure.path}, but GitHub needs a look: {githubFailure.error.replace(/\.$/, "")}. Run in Terminal:
            </p>
            <code className="select-all break-all rounded bg-muted px-1 py-0.5 font-mono text-foreground">{githubFailure.retry}</code>
            <button
              type="button"
              className="self-start text-muted-foreground hover:text-foreground hover:underline"
              onClick={() => setGithubFailure(null)}
            >
              Dismiss
            </button>
          </div>
        ) : null}
        {typing ? (
          <form
            className="mb-2 flex gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              addPath(typed);
            }}
          >
            <input
              aria-label="Folder path"
              placeholder="/Users/you/Github/repo"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-2 text-xs text-foreground"
            />
            <Button type="submit" size="sm" disabled={typed.trim() === ""}>
              Add
            </Button>
          </form>
        ) : null}
        {projects.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            No projects yet. Add project to give {PATCHES} one to work in, or{" "}
            <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={onSetup}>
              set up
            </button>{" "}
            to pick from the repos you have.
          </p>
        ) : null}
        <ul className="flex flex-col gap-0.5">
          {visible.map((project) => {
            const open = tasks.filter((task) => task.projectId === project.id).length;
            const color = colors.get(project.id) ?? PALETTE[0].value;
            const focused = focusProjectId === project.id;
            return (
              <li
                key={project.id}
                className={cn("group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50", focused && "bg-accent")}
                style={tint(color)}
              >
                <button
                  type="button"
                  className="orc-swatch"
                  aria-label={`Change ${project.name}'s colour`}
                  title="Change colour"
                  onClick={() => cycleColor(project)}
                />
                <button
                  type="button"
                  aria-current={focused ? "true" : undefined}
                  className="min-w-0 flex-1 truncate text-left text-sm text-foreground"
                  title={project.path ?? undefined}
                  onClick={() => onFocusProject(project.id)}
                >
                  {project.name}
                </button>
                {open > 0 ? <span className="text-xs text-muted-foreground">{open}</span> : null}
                <button
                  type="button"
                  className="hidden text-xs text-muted-foreground hover:text-foreground group-hover:inline"
                  onClick={() => run(rpc.call("project_prefs", { projectId: project.id, hidden: true }))}
                >
                  Hide
                </button>
              </li>
            );
          })}
        </ul>
        {hidden.length > 0 ? (
          <button
            type="button"
            className="mt-2 px-2 text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => setShowHidden((value) => !value)}
          >
            {showHidden ? "Done" : `${hidden.length} hidden`}
          </button>
        ) : null}
        {showHidden ? (
          <ul className="mt-1 flex flex-col gap-1">
            {hidden.map((project) => (
              <li key={project.id} className="flex flex-col gap-1 rounded-md border border-border p-2">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-current={focusProjectId === project.id ? "true" : undefined}
                    className={cn(
                      "min-w-0 flex-1 truncate text-left text-sm text-muted-foreground hover:text-foreground hover:underline",
                      focusProjectId === project.id && "font-medium text-foreground",
                    )}
                    title={`Open ${project.name}'s board`}
                    onClick={() => onFocusProject(project.id)}
                  >
                    {project.name}
                  </button>
                  <button
                    type="button"
                    className="text-xs text-foreground hover:underline"
                    onClick={() => run(rpc.call("project_prefs", { projectId: project.id, hidden: false }))}
                  >
                    Show
                  </button>
                  <button
                    type="button"
                    className="text-xs text-destructive hover:underline"
                    onClick={() => {
                      setRemoving(removing === project.id ? null : project.id);
                      setConfirmName("");
                    }}
                  >
                    Remove…
                  </button>
                </div>
                {removing === project.id ? (
                  <form
                    className="flex flex-col gap-1"
                    onSubmit={(event) => {
                      event.preventDefault();
                      run(rpc.call("project_remove", { projectId: project.id, confirmName }));
                      setRemoving(null);
                    }}
                  >
                    <p className="text-xs text-muted-foreground">
                      Removes the project and its threads from the app. The folder and its files stay on disk.
                      Type <span className="font-mono text-foreground">{project.name}</span> to confirm.
                    </p>
                    <input
                      aria-label={`Type ${project.name} to confirm`}
                      value={confirmName}
                      onChange={(event) => setConfirmName(event.target.value)}
                      className="h-7 rounded border border-border bg-background px-2 text-xs text-foreground"
                    />
                    <Button type="submit" variant="destructive" size="sm" disabled={confirmName !== project.name}>
                      Remove {project.name}
                    </Button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {error !== null ? <div className="px-2 pt-2"><ErrorLine>{error}</ErrorLine></div> : null}

        <div className="mt-4 flex items-center justify-between px-2 pb-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Tasks</span>
          <NewTaskButton blocked={newTaskBlocked} onClick={onNewTask} />
        </div>
        {shownTasks.length === 0 ? (
          <p className="px-2 text-xs text-muted-foreground">None open. Press + to start one.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {shownTasks.map((task) => (
              <li
                key={task.id}
                style={tint(colors.get(task.projectId) ?? PALETTE[0].value)}
                className="orc-deletable flex items-center"
              >
                <button
                  type="button"
                  disabled={task.threadId === null}
                  onClick={() => task.threadId !== null && onSelectThread(task.threadId)}
                  className={cn(
                    "orc-task-tab min-w-0 flex-1 truncate rounded-md px-2 py-1 text-left text-sm text-foreground hover:bg-accent/50",
                    task.id === selectedTaskId && "bg-accent",
                  )}
                >
                  {task.title}
                </button>
                <DeleteTaskButton task={task} onDelete={onDeleteTask} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
}

// ------------------------------------------------------------- chat column

function ChatColumn({
  state,
  scope,
  boardName,
  onSelect,
  onBack,
  rpc,
  reload,
}: {
  state: BoardState;
  /** Any scope with a chat (showsChat): "+", a task's thread or another agent's. */
  scope: BoardScope;
  /** The project whose board the back control returns to. */
  boardName: string;
  onSelect: (threadId: string) => void;
  /** Back to the project board. */
  onBack: () => void;
  rpc: Rpc;
  reload: () => void;
}) {
  const navigate = useBbNavigate();
  const [error, setError] = useState<string | null>(null);
  const threadId = scopeThread(scope);
  const composingTask = scope.kind === "compose";
  // "+" composes in the selected project.
  const chatProject = state.projects.find((project) => project.id === state.focusProjectId) ?? null;
  const blocked = composingTask ? newTaskBlockFor(state, chatProject?.id ?? null) : null;

  return (
    <aside aria-label={composingTask ? "New task" : "Task chat"} className="flex w-[34rem] shrink-0 flex-col border-r border-border">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <Button variant="ghost" size="sm" onClick={onBack} aria-label={`Back to all tasks in ${boardName}`}>
          <Icon name="ChevronLeft" className="size-4" />
          <span className="max-w-[8rem] truncate">{boardName}</span>
        </Button>
        <img src={patchesAvatar} alt="" className="size-5 shrink-0 rounded-full bg-[#54326F] object-cover" />
        <span className="shrink-0 text-sm font-medium text-foreground">{PATCHES}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {composingTask ? (
            `New task · ${chatProject?.name ?? "no project"}`
          ) : threadId !== null ? (
            <ThreadTitle threadId={threadId} />
          ) : null}
        </span>
        {threadId !== null ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            aria-label="Open this chat full-size"
            onClick={() => navigate.toThread(threadId)}
          >
            <Icon name="ExternalLink" className="size-4" />
          </Button>
        ) : null}
      </div>
      {error !== null ? <div className="border-b border-border px-3 py-2"><ErrorLine>{error}</ErrorLine></div> : null}
      <div className="flex min-h-0 flex-1 flex-col">
        {composingTask ? (
          <div className="flex flex-1 flex-col justify-end gap-3 p-3">
            {blocked !== null || chatProject === null ? (
              <p className="text-sm text-muted-foreground">{blocked}.</p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  A new task with its own chat in {chatProject.name}. Your first message becomes its brief.
                </p>
                <NewThreadComposer
                  key={`newtask:${chatProject.id}`}
                  defaultProjectId={chatProject.id}
                  defaultProviderId={PATCHES_PROVIDER}
                  draftKey={`newtask:${chatProject.id}`}
                  placeholder="What should this task do?"
                  onSubmit={async (request) => {
                    try {
                      // Another project picked in the composer is checked again by the server.
                      const { threadId: created } = await rpc.call("task_new", taskNewInput(request));
                      setError(null);
                      reload();
                      onSelect(created);
                    } catch (cause) {
                      setError(message(cause));
                      // Thrown, so the composer keeps the owner's draft.
                      throw cause;
                    }
                  }}
                />
              </>
            )}
          </div>
        ) : threadId !== null ? (
          <ThreadChat key={threadId} threadId={threadId} variant="compact" className="min-h-0 flex-1" />
        ) : null}
      </div>
    </aside>
  );
}

/**
 * A closed task's chat: the transcript only. ThreadChat's "timeline" variant has
 * no composer, so nothing can be sent and an archived chat stays archived.
 */
function ClosedChatColumn({
  title,
  thread,
  loading,
  boardName,
  onBack,
}: {
  title: string;
  /** The thread to read (closedChatThread); null when the task has none left. */
  thread: ClosedTaskView["threads"][number] | null;
  loading: boolean;
  boardName: string;
  onBack: () => void;
}) {
  const navigate = useBbNavigate();
  return (
    <aside aria-label="Closed task chat" className="flex w-[34rem] shrink-0 flex-col border-r border-border">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <Button variant="ghost" size="sm" onClick={onBack} aria-label={`Back to all tasks in ${boardName}`}>
          <Icon name="ChevronLeft" className="size-4" />
          <span className="max-w-[8rem] truncate">{boardName}</span>
        </Button>
        <img src={patchesAvatar} alt="" className="size-5 shrink-0 rounded-full bg-[#54326F] object-cover" />
        <span className="shrink-0 text-sm font-medium text-foreground">{PATCHES}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</span>
        {thread !== null ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            aria-label="Open this chat full-size"
            onClick={() => navigate.toThread(thread.threadId)}
          >
            <Icon name="ExternalLink" className="size-4" />
          </Button>
        ) : null}
      </div>
      {thread !== null ? (
        <>
          <p className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
            {thread.state === "archived" ? "Archived chat" : "Closed task"} · read-only
          </p>
          <ThreadChat key={thread.threadId} threadId={thread.threadId} variant="timeline" className="min-h-0 flex-1" />
        </>
      ) : (
        <p className="p-3 text-sm text-muted-foreground">{loading ? "Loading…" : "This task's chat is not available."}</p>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------- needs you

function QuestionForm({
  ticket,
  taskTitle,
  rpc,
  reload,
}: {
  ticket: Ticket;
  taskTitle: string;
  rpc: Rpc;
  reload: () => void;
}) {
  const [draft, setDraft] = useState<AnswerDraft>({});
  const answers = answersFor(ticket.questions, draft);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        setSending(true);
        rpc
          .call("ticket_answer", { ticketId: ticket.id, answers: answersFor(ticket.questions, draft), note })
          .then(
            () => {
              setError(null);
              reload();
            },
            (cause: unknown) => setError(message(cause)),
          )
          .finally(() => setSending(false));
      }}
    >
      {ticket.questions.map((question, index) => {
        const ask = ticket.asks[index];
        const answer = answers[index];
        const setAnswer = (value: string) => setDraft((current) => withAnswer(current, question, value));
        return (
        <div key={index} className="flex flex-col gap-1.5 text-sm text-foreground">
          <span>
            <span className="text-muted-foreground">{index + 1}.</span> {ask?.question ?? question}
          </span>
          {ask?.kind === "decision" ? (
            <div className="flex flex-wrap gap-1.5">
              {ask.options.map((option, optionIndex) => (
                <Button
                  key={option}
                  type="button"
                  size="sm"
                  variant={answer === option ? "default" : "outline"}
                  onClick={() => setAnswer(option)}
                >
                  {option}
                  {optionIndex === ask.recommended ? <span className="text-[10px] opacity-70">recommended</span> : null}
                </Button>
              ))}
            </div>
          ) : null}
          {ask?.kind === "command" ? (
            <div className="flex flex-col gap-1">
              <div className="flex items-start gap-2">
                <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-muted px-2 py-1 font-mono text-xs">{ask.command}</pre>
                <Button type="button" size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(ask.command)}>
                  Copy
                </Button>
              </div>
              <span className="text-xs text-muted-foreground">
                {ask.cwd ? `Run in ${ask.cwd}. ` : ""}Only you can: it needs your {ask.reason}.
              </span>
            </div>
          ) : null}
          <textarea
            aria-label={ask?.kind === "decision" ? "Or your own answer" : ask?.kind === "command" ? "What happened when you ran it" : "Your answer"}
            placeholder={ask?.kind === "decision" ? "Or your own answer" : ask?.kind === "command" ? "Done, or what it printed" : ""}
            rows={2}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
          />
        </div>
        );
      })}
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Anything else
        <textarea
          rows={1}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
        />
      </label>
      {error !== null ? <ErrorLine>{error}</ErrorLine> : null}
      <div>
        <Button type="submit" size="sm" disabled={sending}>
          Send to {taskTitle}
        </Button>
      </div>
    </form>
  );
}

/** The owner's two moves on a failed build: run the same build again, or drop it. */
function BuildFailedActions({ taskId, rpc, reload }: { taskId: string; rpc: Rpc; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = (work: Promise<unknown>) => {
    setBusy(true);
    work.then(
      () => {
        setError(null);
        reload();
      },
      (cause: unknown) => setError(message(cause)),
    ).finally(() => setBusy(false));
  };
  return (
    <div className="flex flex-col gap-1" onClick={(event) => event.stopPropagation()}>
      <div className="flex gap-1.5">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => act(rpc.call("build_retry", { taskId }))}>
          Retry
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(rpc.call("build_dismiss", { taskId }))}>
          Dismiss
        </Button>
      </div>
      {error !== null ? <ErrorLine>{error}</ErrorLine> : null}
    </div>
  );
}

/** The Sign in with Claude button's one action: the host starts `claude auth login`, which opens the browser's sign-in tab. */
function useClaudeSignIn(rpc: Rpc) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; error: string | null } | null>(null);
  const start = useCallback(() => {
    setBusy(true);
    rpc
      .call("claude_sign_in", {})
      .then(
        (started) => setResult(started),
        (failure: unknown) => setResult({ ok: false, error: failure instanceof Error ? failure.message : String(failure) }),
      )
      .finally(() => setBusy(false));
  }, [rpc]);
  const reset = useCallback(() => setResult(null), []);
  return { busy, result, start, reset };
}

/** What a click led to: where to finish signing in, or why it did not start and what to do instead. */
function SignInResult({ result, words }: { result: { ok: boolean; error: string | null } | null; words: { started: string; failed: string } }) {
  if (result === null) return null;
  if (result.ok) return <p className="text-sm text-foreground">{words.started}</p>;
  return (
    <ErrorLine>
      {result.error ?? "The sign-in could not be started."} {words.failed}
    </ErrorLine>
  );
}

/**
 * The popup while Claude is signed out (signin.ts signInPopupOpen): dismissed
 * for the failure on screen, back on a newer one, gone once signed in.
 */
function SignInPopup({ signedOut, rpc }: { signedOut: BoardState["signedOut"]; rpc: Rpc }) {
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const { busy, result, start, reset } = useClaudeSignIn(rpc);
  useEffect(() => {
    if (signedOut !== null) return;
    setDismissedAt(null);
    reset();
  }, [signedOut, reset]);
  if (signedOut === null) return null;
  const words = signInPopup(signedOut);
  return (
    <Dialog
      open={signInPopupOpen(signedOut, dismissedAt)}
      onOpenChange={(next) => {
        if (!next) setDismissedAt(signedOut.latest);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{words.title}</DialogTitle>
          <DialogDescription>{words.body}</DialogDescription>
        </DialogHeader>
        <Button type="button" disabled={busy} onClick={start}>
          {words.button}
        </Button>
        <SignInResult result={result} words={words} />
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">{words.fallback}</span>
          <div className="flex items-start gap-2">
            <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-muted px-2 py-1 font-mono text-xs">{words.command}</pre>
            <Button type="button" size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(words.command)}>
              Copy
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => setDismissedAt(signedOut.latest)}>
            {words.dismiss}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One sign-in line of the wizard: who is signed in, or the command to run. */
function SetupSignIn({ tool, signIn }: { tool: string; signIn: SetupState["signIn"]["gh"] }) {
  const line = signInLine(tool, signIn, signIn.command);
  return (
    <li className="flex flex-col gap-1 text-sm">
      <span className={line.ok ? "text-foreground" : "text-muted-foreground"}>{line.text}</span>
      {line.command !== null ? (
        <div className="flex items-start gap-2">
          <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-muted px-2 py-1 font-mono text-xs">{line.command}</pre>
          <Button type="button" size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(line.command ?? "")}>
            Copy
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/**
 * The setup wizard (setupwizard.ts): the owner's name, the folder The
 * Orchestrator may work in, which of its git repos become projects, and
 * whether GitHub and Claude are signed in. Save writes the folder to the
 * local config and adds the ticked repos.
 */
function SetupWizard({
  open,
  onClose,
  rpc,
  reload,
  onFocusProject,
}: {
  open: boolean;
  onClose: () => void;
  rpc: Rpc;
  reload: () => void;
  onFocusProject: (projectId: string) => void;
}) {
  const [facts, setFacts] = useState<SetupState | null>(null);
  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [list, setList] = useState<SetupList | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SetupSaved | null>(null);

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setFacts(null);
    setList(null);
    setListError(null);
    setTicked(new Set());
    setSaved(null);
    setError(null);
    rpc.call("setup_state", {}).then(
      (next) => {
        if (stale) return;
        setFacts(next);
        setName(next.ownerName === OWNER_FALLBACK ? "" : next.ownerName);
        setDir(formatHomePathForDisplay(next.suggestedDir));
      },
      (cause: unknown) => {
        if (!stale) setError(message(cause));
      },
    );
    return () => {
      stale = true;
    };
  }, [open, rpc]);

  const home = facts?.home ?? null;
  const check = useMemo(() => (home === null ? null : validateProjectsDir(dir, home)), [dir, home]);
  const checkedPath = check !== null && check.ok ? check.path : null;
  // The folder's repos, a moment after the typing stops; a late answer for an older path is dropped.
  useEffect(() => {
    setList(null);
    setListError(null);
    setTicked(new Set());
    if (!open || checkedPath === null) return;
    let stale = false;
    const timer = setTimeout(() => {
      rpc.call("setup_list", { dir: checkedPath }).then(
        (next) => {
          if (!stale) setList(next);
        },
        (cause: unknown) => {
          if (!stale) setListError(message(cause));
        },
      );
    }, 300);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [open, checkedPath, rpc]);

  const toggle = (repo: string, on: boolean) =>
    setTicked((current) => {
      const next = new Set(current);
      if (on) next.add(repo);
      else next.delete(repo);
      return next;
    });

  const save = () => {
    if (checkedPath === null || busy) return;
    setBusy(true);
    setError(null);
    rpc.call("setup_save", { projectsDir: checkedPath, ownerName: name, repos: [...ticked] }).then(
      (result) => {
        setBusy(false);
        setSaved(result);
        reload();
        const first = result.results.find((entry) => entry.projectId !== null);
        if (first !== undefined && first.projectId !== null) onFocusProject(first.projectId);
        // Nothing to read: straight onto the board.
        if (result.results.length === 0) onClose();
      },
      (cause: unknown) => {
        setBusy(false);
        setError(message(cause));
      },
    );
  };

  const repos = list === null ? [] : list.choices.filter((choice) => choice.selectable || choice.added);
  const others = list === null ? 0 : list.choices.length - repos.length;
  const blocked = facts !== null && facts.configProblem !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <DialogContent className="orc-setup">
        <DialogHeader>
          <DialogTitle>{name.trim() === "" ? "Hello" : `Hello ${name.trim()}`}</DialogTitle>
          <DialogDescription>
            Set up The Orchestrator: what to call you, the folder it may work in, and which of your repos are its projects.
          </DialogDescription>
        </DialogHeader>
        {saved !== null ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-foreground">
              Saved. The Orchestrator works in <span className="font-mono text-xs">{formatHomePathForDisplay(saved.projectsDir)}</span>
              {saved.created ? " (the folder was created)." : "."}
            </p>
            <ul className="flex flex-col gap-1">
              {saved.results.map((result) => (
                <li key={result.name} className={cn("text-sm", result.ok ? "text-foreground" : "text-destructive")}>
                  {result.ok ? `${result.name}: added.` : `${result.name}: not added. ${result.detail}`}
                </li>
              ))}
            </ul>
            <DialogFooter>
              <Button type="button" onClick={onClose}>
                Go to the board
              </Button>
            </DialogFooter>
          </div>
        ) : facts === null ? (
          error !== null ? <ErrorLine>{error}</ErrorLine> : <p className="text-sm text-muted-foreground">Looking at this machine…</p>
        ) : (
          <form
            className="flex min-h-0 flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            {blocked ? <ErrorLine>{facts.configProblem} Setup cannot save until it is fixed.</ErrorLine> : null}
            <label className="flex flex-col gap-1 text-sm text-foreground">
              Your first name
              <Input
                aria-label="Your first name"
                value={name}
                maxLength={OWNER_NAME_MAX}
                placeholder="What the board and the agents call you"
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-sm text-foreground">
              The folder The Orchestrator may work in
              <Input
                aria-label="The folder The Orchestrator may work in"
                className="font-mono text-xs"
                value={dir}
                disabled={busy}
                spellCheck={false}
                onChange={(event) => setDir(event.target.value)}
              />
              {check === null ? (
                <ErrorLine>No machine answered, so the folder cannot be checked. Close this and try again in a moment.</ErrorLine>
              ) : !check.ok ? (
                <ErrorLine>{check.reason}</ErrorLine>
              ) : (
                <span className="text-xs text-muted-foreground">
                  New projects are made here, and the repos below are read from it. Nothing outside your home folder is allowed.
                </span>
              )}
            </label>
            <div className="flex min-h-0 flex-col gap-1">
              <span className="text-sm text-foreground">Repos to add as projects</span>
              {checkedPath === null ? (
                <p className="text-xs text-muted-foreground">Pick a folder first.</p>
              ) : listError !== null ? (
                <ErrorLine>{listError}</ErrorLine>
              ) : list === null ? (
                <p className="text-xs text-muted-foreground">Looking in the folder…</p>
              ) : !list.exists ? (
                <p className="text-xs text-muted-foreground">This folder is not there yet. Save creates it. You can add projects later.</p>
              ) : (
                <>
                  {repos.length > 0 ? (
                    <ul className="orc-setup-repos flex flex-col gap-1 overflow-y-auto rounded-md border border-border p-2">
                      {repos.map((choice) => (
                        <li key={choice.name}>
                          <label className="flex items-center gap-2 text-sm text-foreground">
                            <Checkbox
                              checked={choice.added || ticked.has(choice.name)}
                              disabled={choice.added || busy}
                              onCheckedChange={(on) => toggle(choice.name, on === true)}
                              aria-label={`Add ${choice.name}`}
                            />
                            <span className="min-w-0 truncate">{choice.name}</span>
                            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={choice.remote ?? undefined}>
                              {choice.added ? "Added" : (choice.remote ?? "No remote")}
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {list.note !== null ? <p className="text-xs text-muted-foreground">{list.note}</p> : null}
                  {others > 0 && repos.length > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {others === 1 ? "1 other folder is not a git repo." : `${others} other folders are not git repos.`}
                    </p>
                  ) : null}
                </>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-sm text-foreground">Signed in</span>
              <ul className="flex flex-col gap-2">
                <SetupSignIn tool="GitHub" signIn={facts.signIn.gh} />
                <SetupSignIn tool="Claude" signIn={facts.signIn.claude} />
              </ul>
            </div>
            {error !== null ? <ErrorLine>{error}</ErrorLine> : null}
            <DialogFooter>
              <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
                Not now
              </Button>
              <Button type="submit" disabled={busy || blocked || checkedPath === null}>
                {busy ? "Saving…" : ticked.size === 0 ? "Save" : ticked.size === 1 ? "Save and add 1 project" : `Save and add ${ticked.size} projects`}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function NeedsYouSection({
  items,
  state,
  headroom,
  colors,
  onSelect,
  rpc,
  reload,
}: {
  items: readonly NeedsYouItem[];
  state: BoardState;
  /** Headroom down past its restart cap for 30 min (headroom.ts headroomView); null otherwise. */
  headroom: NonNullable<LivenessView["headroom"]>["needsOwner"];
  colors: ReadonlyMap<string, string>;
  onSelect: (threadId: string) => void;
  rpc: Rpc;
  reload: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Claude signed out is one item of its own, whatever the project or task in view.
  const signedOut = state.signedOut === null ? null : signedOutItem(state.signedOut);
  const count = items.length + (signedOut === null ? 0 : 1) + (headroom === null ? 0 : 1);
  const signIn = useClaudeSignIn(rpc);
  const resetSignIn = signIn.reset;
  useEffect(() => {
    if (state.signedOut === null) resetSignIn();
  }, [state.signedOut, resetSignIn]);
  return (
    <section aria-label="Needs you" className="border-b border-border p-3">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Needs you {count > 0 ? `· ${count}` : ""}
      </h2>
      {count === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing is waiting on you.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {signedOut !== null ? (
            <li className="orc-ticket orc-ticket-danger rounded-lg border border-border bg-card p-3" style={tint("var(--destructive)")}>
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium text-foreground">{signedOut.title}</p>
                <p className="text-sm text-foreground">{signedOut.body}</p>
                <div className="flex items-start gap-2">
                  <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-muted px-2 py-1 font-mono text-xs">{signedOut.command}</pre>
                  <Button type="button" size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(signedOut.command)}>
                    Copy
                  </Button>
                  <Button type="button" size="sm" disabled={signIn.busy} onClick={signIn.start}>
                    {SIGN_IN_BUTTON}
                  </Button>
                </div>
                {state.signedOut !== null ? <SignInResult result={signIn.result} words={signInPopup(state.signedOut)} /> : null}
                <span className="text-xs text-muted-foreground">Only you can: it needs your {signedOut.reason}.</span>
              </div>
            </li>
          ) : null}
          {headroom !== null ? (
            <li className="orc-ticket rounded-lg border border-border bg-card p-3" style={tint("var(--warning)")}>
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium text-foreground">{headroom.title}</p>
                <p className="text-sm text-foreground">{headroom.body}</p>
                <div className="flex items-start gap-2">
                  <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-muted px-2 py-1 font-mono text-xs">{headroom.command}</pre>
                  <Button type="button" size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(headroom.command)}>
                    Copy
                  </Button>
                </div>
              </div>
            </li>
          ) : null}
          {items.map((item) => {
            const task = state.tasks.find((candidate) => candidate.id === item.taskId);
            const questions = state.tickets.find((ticket) => ticket.id === item.questionTicketId);
            const expanded = open === item.key;
            return (
              <li
                key={item.key}
                className={cn("orc-ticket rounded-lg border border-border bg-card p-3", `orc-ticket-${item.tone}`)}
                style={tint(colors.get(item.projectId) ?? PALETTE[0].value)}
              >
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-sm font-medium text-foreground hover:underline"
                    onClick={() => {
                      if (item.threadId !== null) onSelect(item.threadId);
                      setOpen(expanded ? null : item.key);
                    }}
                  >
                    {item.summary}
                  </button>
                  {task?.prUrl ? (
                    <UrlLink href={task.prUrl} className="text-xs text-muted-foreground hover:underline">
                      Open PR
                    </UrlLink>
                  ) : null}
                  <Button variant="ghost" size="sm" onClick={() => setOpen(expanded ? null : item.key)}>
                    {expanded ? "Hide" : questions !== undefined ? "Answer" : item.buildFailed || item.agentTrouble !== null ? "Fix" : "Open"}
                  </Button>
                </div>
                {expanded ? (
                  <div className="mt-3 flex flex-col gap-3">
                    {questions !== undefined && task !== undefined ? (
                      <QuestionForm ticket={questions} taskTitle={task.title} rpc={rpc} reload={reload} />
                    ) : null}
                    {item.reviewTicketId !== null && task !== undefined ? (
                      <div className="flex flex-col gap-2">
                        <p className="text-sm text-foreground">
                          Proven for <span className="font-mono">{task.verifiedSha?.slice(0, 7) ?? "the branch"}</span>. Test
                          these, then merge it yourself:
                        </p>
                        <ul className="list-disc pl-5 text-sm text-foreground">
                          {task.testList.length === 0 ? <li>Nothing beyond CI.</li> : task.testList.map((test) => <li key={test}>{test}</li>)}
                        </ul>
                        <div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              rpc.call("ticket_close", { ticketId: item.reviewTicketId as string }).then(
                                () => {
                                  setError(null);
                                  reload();
                                },
                                (cause: unknown) => setError(message(cause)),
                              )
                            }
                          >
                            Tested: clear this ticket
                          </Button>
                        </div>
                      </div>
                    ) : null}
                    {item.buildFailed && task !== undefined ? (
                      <div className="flex flex-col gap-2">
                        <p className="text-sm text-foreground">
                          The build failed {task.buildFailures} times and the task could not fix it. Retry runs the same build
                          again; Dismiss drops it and tells the task.
                        </p>
                        {task.buildError ? (
                          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted px-2 py-1 font-mono text-xs">
                            {task.buildError}
                          </pre>
                        ) : null}
                        <BuildFailedActions taskId={task.id} rpc={rpc} reload={reload} />
                      </div>
                    ) : null}
                    {item.agentTrouble !== null && item.agentBlocked ? (
                      <p className="text-sm text-foreground">
                        {item.agentTrouble}. bb holds every message to it, so Restart cannot reach it. A locked checkout stays
                        locked until bb's stale claim on it is cleared: docs/how-it-works.md, "A locked checkout".
                      </p>
                    ) : null}
                    {item.agentTrouble !== null && !item.agentBlocked && task !== undefined ? (
                      <div className="flex flex-col gap-2">
                        <p className="text-sm text-foreground">
                          {item.agentTrouble}. Nothing below the task can restart it. Restart retries a failed turn, or stops a
                          silent one and tells the task to carry on.
                        </p>
                        <AgentRestart taskId={task.id} rpc={rpc} reload={reload} />
                      </div>
                    ) : null}
                    {item.asking ? (
                      <p className="text-sm text-muted-foreground">It is waiting on you in its chat, open on the left.</p>
                    ) : null}
                    {error !== null ? <ErrorLine>{error}</ErrorLine> : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- task rows

const CELL_ICON: Record<Cell["state"], string | null> = {
  pending: null,
  working: null,
  done: "Check",
  blocked: "MessageQuestion",
  failed: "AlertTriangle",
  skipped: null,
};

/** A stage with its own thread (researcher, builder) opens it, not the task's. */
function StageCell({
  cell,
  focus,
  onSelect,
}: {
  cell: Cell;
  focus: ReadonlyMap<string, string>;
  onSelect: (threadId: string) => void;
}) {
  const threadId = cell.threadId;
  const Root = threadId === null ? "div" : "button";
  const open =
    threadId === null
      ? undefined
      : {
          type: "button" as const,
          onClick: (event: { stopPropagation(): void }) => {
            // The row opens the task's thread; this cell opens its own.
            event.stopPropagation();
            onSelect(threadId);
          },
        };
  if (cell.state === "working") {
    return (
      <Root className={cn("orc-cell orc-cell-working", open && "orc-cell-link")} {...open}>
        <span aria-hidden className="orc-progress" />
        <WorkingLine focus={threadId === null ? undefined : focus.get(threadId)} fallback={cell.label} />
      </Root>
    );
  }
  const icon = CELL_ICON[cell.state];
  return (
    <Root className={cn("orc-cell", `orc-cell-${cell.state}`, open && "orc-cell-link")} title={cell.label} {...open}>
      {icon !== null ? <Icon name={icon} className="size-3.5 shrink-0" /> : null}
      <span className="truncate">{cell.state === "pending" && cell.label === "" ? "–" : cell.label}</span>
    </Root>
  );
}

const TaskRowView = memo(function TaskRowView({
  row,
  indicator,
  project,
  color,
  focus,
  selected,
  onSelect,
  onDelete,
  rpc,
  reload,
  routes,
}: {
  row: TaskRow;
  indicator: Indicator;
  project: string;
  color: string;
  focus: ReadonlyMap<string, string>;
  /** Each thread's model route (modelroute.ts), by thread id. */
  routes: ReadonlyMap<string, RouteView>;
  selected: boolean;
  onSelect: (threadId: string) => void;
  onDelete: (task: DeletableTask) => void;
  rpc: Rpc;
  reload: () => void;
}) {
  const task = row.task;
  return (
    <tr
      className={cn("orc-row orc-deletable cursor-pointer", selected && "orc-row-selected")}
      style={tint(color)}
      onClick={() => task.threadId !== null && onSelect(task.threadId)}
    >
      <td className="orc-td orc-td-task">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <LiveMark indicator={indicator} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{task.title}</span>
            <DeleteTaskButton task={task} onDelete={onDelete} />
          </span>
          {indicator !== null && indicator.kind !== "working" ? (
            <span
              className={cn("truncate text-[11px]", indicator.kind === "trouble" ? "orc-live-trouble" : "orc-live-waiting")}
              title={indicator.reason}
            >
              {indicator.reason}
            </span>
          ) : null}
          <span className="truncate text-xs text-muted-foreground">
            {project}
            {task.note ? ` · ${task.note}` : ""}
          </span>
          <RouteMark route={task.threadId === null ? undefined : routes.get(task.threadId)} />
          {task.worktreePath !== null ? (
            <span className="truncate font-mono text-[11px] text-muted-foreground" title={task.worktreePath}>
              {formatHomePathForDisplay(task.worktreePath)}
            </span>
          ) : null}
          {task.worktreeNote !== null ? (
            <span className="flex items-center gap-1 text-[11px] text-warning-text">
              <Icon name="AlertTriangle" className="size-3" />
              {task.worktreeNote}
            </span>
          ) : null}
        </div>
      </td>
      <td className="orc-td">
        <div className="flex min-w-0 flex-col gap-1">
          <StageCell cell={row.research} focus={focus} onSelect={onSelect} />
          <RouteMark route={row.research.threadId === null ? undefined : routes.get(row.research.threadId)} />
        </div>
      </td>
      <td className="orc-td">
        <div className="flex min-w-0 flex-col gap-1">
          <StageCell cell={row.build} focus={focus} onSelect={onSelect} />
          <RouteMark route={row.build.threadId === null ? undefined : routes.get(row.build.threadId)} />
          {task.buildState === "failed" ? <BuildFailedActions taskId={task.id} rpc={rpc} reload={reload} /> : null}
        </div>
      </td>
      <td className="orc-td">
        <div className="flex min-w-0 flex-col gap-1">
          {row.pr.pr !== null && row.pr.tone !== null ? <PrBadge pr={row.pr.pr} tone={row.pr.tone} /> : null}
          {row.pr.branch !== null ? (
            <Chip title={row.pr.branch}>
              <Icon name="GitBranch" className="size-3" />
              {row.pr.branch}
              {row.pr.pr === null ? " · no PR" : ""}
            </Chip>
          ) : row.pr.pr === null ? (
            <span className="text-xs text-muted-foreground">–</span>
          ) : null}
          {task.verdict !== null && task.stage === "pr" && task.verdict.reasons[0] ? (
            <span className="line-clamp-2 text-[11px] text-muted-foreground" title={task.verdict.reasons.join(" ")}>
              {task.verdict.reasons[0]}
            </span>
          ) : null}
        </div>
      </td>
      <td className="orc-td">
        {row.you.questions > 0 || row.you.asking ? (
          <span className="orc-you orc-you-attention">
            <Icon name="MessageQuestion" className="size-3.5" />
            {row.you.questions > 0 ? `${row.you.questions} Q${row.you.questions === 1 ? "" : "s"}` : "In chat"}
          </span>
        ) : row.you.review ? (
          <span className="orc-you orc-you-ready">
            <Icon name="CircleCheck" className="size-3.5" />
            Test &amp; merge
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">–</span>
        )}
      </td>
    </tr>
  );
});

// ----------------------------------------------------------- other agents

/** What otherAgentsView (others.ts) needs from the server: one derivation for the board and the sidebar's count. */
function useOtherInputs(state: BoardState | null, liveness: LivenessView | null) {
  const closedThreadIds = useMemo(() => new Set(state?.closedThreadIds ?? EMPTY), [state?.closedThreadIds]);
  const live = useMemo(
    () => new Map((liveness?.others ?? EMPTY).map((entry) => [entry.threadId, entry] as const)),
    [liveness?.others],
  );
  return { closedThreadIds, liveness: live };
}

/** The owner's Other agents open/closed choice: saved in the dossier, applied at once. */
function useOtherAgentsOpen(rpc: Rpc, saved: boolean | null) {
  const [local, setLocal] = useState<boolean | null>(null);
  const set = useCallback(
    (open: boolean) => {
      setLocal(open);
      rpc.call("ui_pref", { otherAgentsOpen: open }).catch(() => setLocal(null));
    },
    [rpc],
  );
  return [local ?? saved, set] as const;
}

function OtherAgentChip({
  entry,
  projectName,
  colors,
  focus,
  now,
  onSelect,
}: {
  entry: OtherEntry;
  projectName: (projectId: string) => string;
  colors: ReadonlyMap<string, string>;
  focus: ReadonlyMap<string, string>;
  now: number;
  onSelect: (threadId: string) => void;
}) {
  const { thread, state, reason } = entry;
  return (
    <button
      type="button"
      onClick={() => onSelect(thread.id)}
      style={tint(colors.get(thread.projectId) ?? "transparent")}
      className={cn(
        "orc-agent relative flex max-w-[26rem] items-center gap-1.5 overflow-hidden rounded-md border border-border bg-card px-2 py-1 text-left text-xs text-foreground hover:bg-accent/50",
        state === "needs-you" && "orc-agent-asking",
      )}
      title={`${thread.displayTitle} · ${projectName(thread.projectId)}${reason !== null ? ` · ${reason}` : ""}`}
    >
      {state === "working" ? <span aria-hidden className="orc-progress" /> : null}
      <span className="orc-dot" />
      <span className="truncate font-medium">{thread.displayTitle}</span>
      {state === "working" ? (
        <WorkingLine focus={focus.get(thread.id)} fallback="Working" />
      ) : state === "waiting" ? (
        <span className="flex min-w-0 items-center gap-1 text-muted-foreground" title={reason ?? "waiting"}>
          <Icon name="Clock" className="size-3.5 shrink-0" />
          <span className="truncate">{reason ?? "waiting"}</span>
        </span>
      ) : state === "needs-you" ? (
        <span className="shrink-0 text-warning-text">needs you</span>
      ) : state === "trouble" ? (
        <span className="flex min-w-0 items-center gap-1 text-destructive" title={reason ?? "in trouble"}>
          <Icon name="AlertTriangle" className="size-3.5 shrink-0" />
          <span className="max-w-[12rem] truncate">{reason ?? "in trouble"}</span>
        </span>
      ) : (
        <span className="shrink-0 text-muted-foreground">idle</span>
      )}
      <span className="shrink-0 text-muted-foreground">· {relativeTime(entry.lastActivity, now)}</span>
    </button>
  );
}

function OtherAgents({
  view,
  savedOpen,
  onToggle,
  projectName,
  colors,
  focus,
  now,
  onSelect,
}: {
  view: OtherAgentsView;
  /** The owner's saved choice; null until they toggle. */
  savedOpen: boolean | null;
  onToggle: (open: boolean) => void;
  projectName: (projectId: string) => string;
  colors: ReadonlyMap<string, string>;
  focus: ReadonlyMap<string, string>;
  now: number;
  onSelect: (threadId: string) => void;
}) {
  const [showOlder, setShowOlder] = useState(false);
  const open = othersOpen(savedOpen, view.hasActive);
  const tally = (state: OtherEntry["state"]) => view.entries.filter((entry) => entry.state === state).length;
  const counts = [
    { n: tally("working"), label: "working", className: "text-foreground" },
    { n: tally("needs-you"), label: "needs you", className: "text-warning-text" },
    { n: tally("trouble"), label: "in trouble", className: "text-destructive" },
  ].filter((count) => count.n > 0);
  const chip = (entry: OtherEntry) => (
    <OtherAgentChip
      key={entry.thread.id}
      entry={entry}
      projectName={projectName}
      colors={colors}
      focus={focus}
      now={now}
      onSelect={onSelect}
    />
  );
  return (
    <section aria-label="Other agents" className="border-b border-border p-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
          onClick={() => onToggle(!open)}
        >
          <span aria-hidden className="w-3">{open ? "▾" : "▸"}</span>
          Other agents · {view.count}
        </button>
        {!open
          ? counts.map((count) => (
              <span key={count.label} className={cn("text-xs", count.className)}>
                {count.n} {count.label}
              </span>
            ))
          : null}
      </div>
      {open ? (
        <>
          {view.entries.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No other agents.</p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-1.5">{view.entries.map(chip)}</div>
          )}
          {view.older.length > 0 ? (
            <>
              <button
                type="button"
                aria-expanded={showOlder}
                className="mt-2 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setShowOlder((value) => !value)}
              >
                <span aria-hidden className="w-3">{showOlder ? "▾" : "▸"}</span>
                Older ({view.older.length})
              </button>
              {showOlder ? <div className="mt-1.5 flex flex-wrap gap-1.5">{view.older.map(chip)}</div> : null}
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function OpenPullRequests({
  entries,
  colors,
  errors,
}: {
  entries: readonly { projectId: string; projectName: string; pr: PullRequest; tone: PrTone }[];
  colors: ReadonlyMap<string, string>;
  errors: readonly { projectName: string; error: string }[];
}) {
  return (
    <section aria-label="Pull requests without a task" className="p-3">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Other open PRs · {entries.length}
      </h2>
      {entries.length === 0 ? <p className="text-sm text-muted-foreground">None.</p> : null}
      <div className="flex flex-wrap gap-1.5">
        {entries.map(({ projectId, projectName, pr, tone }) => (
          <div
            key={`${projectId}:${pr.number}`}
            style={tint(colors.get(projectId) ?? "transparent")}
            className="orc-agent flex max-w-[26rem] items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs"
            title={`${projectName} · ${pr.headRefName}`}
          >
            <span className="orc-dot" />
            <PrBadge pr={pr} tone={tone} />
            <span className="truncate text-foreground">{pr.title}</span>
          </div>
        ))}
      </div>
      {errors.map(({ projectName, error }) => (
        <p key={projectName} className="mt-1 text-xs text-muted-foreground">
          {projectName}: {error}
        </p>
      ))}
    </section>
  );
}

// --------------------------------------------------------------- completed

/** One closed task's dossier (closed_task), refetched when the task or `version` changes; a stale answer is dropped. */
function useClosedTask(rpc: Rpc, taskId: string | null, version: number) {
  const [result, setResult] = useState<{ taskId: string; view: ClosedTaskView | null; error: string | null } | null>(null);
  useEffect(() => {
    if (taskId === null) return;
    let stale = false;
    rpc.call("closed_task", { taskId }).then(
      (view) => {
        if (!stale) setResult({ taskId, view, error: null });
      },
      (cause: unknown) => {
        if (!stale) setResult({ taskId, view: null, error: message(cause) });
      },
    );
    return () => {
      stale = true;
    };
  }, [rpc, taskId, version]);
  const own = result !== null && result.taskId === taskId ? result : null;
  return { view: own?.view ?? null, error: own?.error ?? null, loading: taskId !== null && own === null };
}

function CompletedSection({
  projectId,
  count,
  color,
  version,
  now,
  onOpen,
  onDelete,
  archiveChats,
  onArchiveChats,
  rpc,
}: {
  /** The project in view; every list is one project's. */
  projectId: string | null;
  /** Its closed tasks, from board_state; a change refetches the page. */
  count: number;
  color: string;
  /** Bumped after a delete, to refetch. */
  version: number;
  now: number;
  onOpen: (taskId: string) => void;
  onDelete: (task: DeletableTask) => void;
  /** "Archive chats of done tasks after 10 min" (done.ts). */
  archiveChats: boolean;
  onArchiveChats: (enabled: boolean) => void;
  rpc: Rpc;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<{ rows: ClosedTaskRow[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // A new search or project starts at the first page.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(input.trim());
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [input]);
  useEffect(() => {
    setOffset(0);
    setPage(null);
  }, [projectId]);
  useEffect(() => {
    if (!open || projectId === null) return;
    let stale = false;
    setLoading(true);
    rpc.call("closed_tasks", { projectId, query, offset, limit: CLOSED_PAGE_SIZE }).then(
      (result) => {
        if (stale) return;
        setLoading(false);
        setError(null);
        // The page emptied under us (a search narrowed, tasks went): back to the last one.
        if (result.rows.length === 0 && result.total > 0 && offset > 0) {
          setOffset(Math.floor((result.total - 1) / CLOSED_PAGE_SIZE) * CLOSED_PAGE_SIZE);
          return;
        }
        setPage(result);
      },
      (cause: unknown) => {
        if (stale) return;
        setLoading(false);
        setError(message(cause));
      },
    );
    return () => {
      stale = true;
    };
  }, [rpc, open, projectId, query, offset, count, version]);

  const rows = page?.rows ?? [];
  const total = page?.total ?? 0;
  return (
    <section aria-label="Completed" className="border-t border-border p-3">
      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-expanded={open}
          className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
          onClick={() => setOpen((value) => !value)}
        >
          <span aria-hidden className="w-3">{open ? "▾" : "▸"}</span>
          Completed · {count}
        </button>
        <span className="flex-1" />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input type="checkbox" checked={archiveChats} onChange={(event) => onArchiveChats(event.target.checked)} />
          Archive chats of done tasks after 10 min
        </label>
      </div>
      {open ? (
        count === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Nothing finished yet.</p>
        ) : (
          <>
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="search"
                aria-label="Search completed tasks"
                placeholder="Search title, brief, note or PR number"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                className="h-7 w-72 rounded-md border border-border bg-background px-2 text-xs text-foreground"
              />
              <span className="flex-1" />
              {page !== null && total > 0 ? (
                <span>
                  {offset + 1}–{offset + rows.length} of {total}
                </span>
              ) : null}
              <Button variant="ghost" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - CLOSED_PAGE_SIZE))}>
                Previous
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={offset + rows.length >= total}
                onClick={() => setOffset(offset + CLOSED_PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
            {error !== null ? (
              <div className="mt-2">
                <ErrorLine>{error}</ErrorLine>
              </div>
            ) : null}
            {page === null ? (
              error === null ? <p className="mt-2 text-sm text-muted-foreground">Loading…</p> : null
            ) : rows.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">
                {query === "" ? "Nothing finished yet." : `No completed task matches “${query}”.`}
              </p>
            ) : (
              <ul className={cn("mt-2 flex flex-col gap-1", loading && "opacity-60")} style={tint(color)}>
                {rows.map((task) => {
                  const completion = completionOf(task);
                  const how = completionLabel(completion);
                  return (
                    <li key={task.id} className="orc-deletable flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-accent/50">
                      <span className="orc-dot" />
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left text-sm text-foreground hover:underline"
                        onClick={() => onOpen(task.id)}
                      >
                        {task.title}
                      </button>
                      {completion.kind === "merged" && task.prUrl ? (
                        <UrlLink href={task.prUrl} className="shrink-0 text-muted-foreground hover:underline">
                          {how}
                        </UrlLink>
                      ) : (
                        <span className="shrink-0 text-muted-foreground">{how}</span>
                      )}
                      <span className="w-16 shrink-0 text-right text-muted-foreground">
                        {task.closedAt !== null ? relativeTime(task.closedAt, now) : ""}
                      </span>
                      <DeleteTaskButton task={task} onDelete={onDelete} />
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )
      ) : null}
    </section>
  );
}

function SummaryBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

/** A closed task on the right side: its dossier summary and its threads, none of the open board. */
function ClosedTaskSection({
  view,
  error,
  boardName,
  currentThreadId,
  now,
  onBack,
  onOpenThread,
}: {
  /** Null while loading, or when the task is unknown (then `error` says so). */
  view: ClosedTaskView | null;
  error: string | null;
  boardName: string;
  /** The thread the chat column shows. */
  currentThreadId: string | null;
  now: number;
  onBack: () => void;
  onOpenThread: (threadId: string) => void;
}) {
  const back = (
    <div className="border-b border-border px-3 py-2">
      <button
        type="button"
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
        onClick={onBack}
      >
        <Icon name="ChevronLeft" className="size-3.5" />
        All tasks in {boardName}
      </button>
    </div>
  );
  if (view === null) {
    return (
      <>
        {back}
        <div className="p-3">
          {error !== null ? (
            <ErrorLine>This closed task could not be opened: {error}</ErrorLine>
          ) : (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
        </div>
      </>
    );
  }
  const summaries = view.threads.filter((entry) => entry.summary !== null);
  return (
    <>
      {back}
      <section aria-label="Closed task" className="flex flex-col gap-4 border-b border-border p-3 text-sm text-foreground">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-medium">{view.title}</h2>
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span>{view.how}</span>
            {view.sha !== null ? <span className="font-mono">{view.sha}</span> : null}
            {view.prNumber !== null ? (
              view.prUrl ? (
                <UrlLink href={view.prUrl} className="hover:underline">
                  PR #{view.prNumber}
                </UrlLink>
              ) : (
                <span>PR #{view.prNumber}</span>
              )
            ) : null}
            {view.branch !== null ? <span className="font-mono">{view.branch}</span> : null}
            {view.closedAt !== null ? (
              <span title={new Date(view.closedAt).toLocaleString()}>closed {relativeTime(view.closedAt, now)}</span>
            ) : null}
          </p>
        </div>
        {view.brief !== "" ? (
          <SummaryBlock title="Brief">
            <p className="whitespace-pre-wrap">{view.brief}</p>
          </SummaryBlock>
        ) : null}
        {view.note ? (
          <SummaryBlock title="Note">
            <p className="whitespace-pre-wrap">{view.note}</p>
          </SummaryBlock>
        ) : null}
        {view.decisions.length > 0 ? (
          <SummaryBlock title={`Decisions · ${view.decisions.length}`}>
            <ul className="flex flex-col gap-1">
              {view.decisions.map((entry, index) => (
                <li key={index}>
                  <span className="text-muted-foreground">{entry.question}</span> → {entry.decision}
                </li>
              ))}
            </ul>
          </SummaryBlock>
        ) : null}
        {view.questions.length > 0 ? (
          <SummaryBlock title={`Questions asked · ${view.questions.length}`}>
            <ul className="flex flex-col gap-1">
              {view.questions.map((entry, index) => (
                <li key={index}>
                  <span className="text-muted-foreground">{entry.question}</span> →{" "}
                  {entry.answer !== null ? entry.answer : <span className="text-muted-foreground">not answered</span>}
                </li>
              ))}
            </ul>
          </SummaryBlock>
        ) : null}
        {view.withdrawals.length > 0 ? (
          <SummaryBlock title={`Questions withdrawn · ${view.withdrawals.length}`}>
            <ul className="flex flex-col gap-1">
              {view.withdrawals.map((entry, index) => (
                <li key={index}>
                  <span className="text-muted-foreground">{entry.questions.join(" · ")}</span> → withdrawn by{" "}
                  {entry.by === "patches" ? PATCHES : "the task"}: {entry.reason}
                </li>
              ))}
            </ul>
          </SummaryBlock>
        ) : null}
        {view.releases.length > 0 ? (
          <SummaryBlock title={`Released claims · ${view.releases.length}`}>
            <ul className="flex flex-col gap-1">
              {view.releases.map((entry, index) => (
                <li key={index}>
                  <span className="font-mono text-xs">{entry.paths.join(", ")}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {entry.by === "patches" ? PATCHES : "automatic"}: {entry.reason}
                  </span>
                </li>
              ))}
            </ul>
          </SummaryBlock>
        ) : null}
        {summaries.length > 0 ? (
          <SummaryBlock title="Research and build summaries">
            <ul className="flex flex-col gap-2">
              {summaries.map((entry) => (
                <li key={entry.threadId}>
                  <span className="text-muted-foreground">
                    {entry.kind === "research" ? "Research" : "Build"}: {entry.label}
                  </span>
                  <p className="whitespace-pre-wrap">{entry.summary}</p>
                </li>
              ))}
            </ul>
          </SummaryBlock>
        ) : null}
      </section>
      <section aria-label="This task's threads" className="border-b border-border p-3">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Threads · {view.threads.length}</h2>
        {currentThreadId === null ? (
          <p className="mb-2 text-xs text-muted-foreground">
            {view.threads.length === 0 ? "This task never had a chat." : "This chat is not available."}
          </p>
        ) : null}
        <ul className="flex flex-col gap-0.5">
          {view.threads.map((entry) => {
            const label =
              entry.kind === "task" ? `Task: ${entry.label}` : `${entry.kind === "research" ? "Research" : "Build"}: ${entry.label}`;
            const current = entry.threadId === currentThreadId;
            const classes = cn(
              "flex w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-2 text-left",
              entry.kind === "task" ? "pl-2 text-sm text-foreground" : "pl-6 text-xs text-muted-foreground",
              current && "bg-accent text-foreground",
            );
            return (
              <li key={entry.threadId}>
                {entry.state === "gone" ? (
                  <span className={cn(classes, "opacity-60")} title="This chat is not available">
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    <span className="shrink-0 text-[11px]">not available</span>
                  </span>
                ) : (
                  <button
                    type="button"
                    aria-current={current ? "true" : undefined}
                    onClick={() => onOpenThread(entry.threadId)}
                    title={label}
                    className={cn(classes, "hover:bg-accent/50")}
                  >
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    {entry.state === "archived" ? <span className="shrink-0 text-[11px] text-muted-foreground">archived</span> : null}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}

// -------------------------------------------------------------- board tabs

/** iOS-style count badges over a tab's top-right corner: orange needs the owner, green working. */
function TabBadges({ badge, className = "orc-tab-badges" }: { badge: TabBadge | undefined; className?: string }) {
  if (badge === undefined || (badge.needsYou === 0 && badge.working === 0)) return null;
  return (
    <span className={className}>
      {badge.needsYou > 0 ? (
        <span className="orc-badge orc-badge-needs" title={`${badge.needsYou} need you`}>
          {badge.needsYou}
        </span>
      ) : null}
      {badge.working > 0 ? (
        <span className="orc-badge orc-badge-working" title={`${badge.working} working`}>
          {badge.working}
        </span>
      ) : null}
    </span>
  );
}

/** A task's own threads (scope.ts taskThreads), each opening in the chat column; the open one highlighted. */
function TaskThreadsSection({
  threads,
  indicators,
  onSelect,
}: {
  threads: readonly ScopeThread[];
  indicators: ReadonlyMap<string, Indicator>;
  onSelect: (threadId: string) => void;
}) {
  return (
    <section aria-label="This task's threads" className="border-b border-border p-3">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Threads · {threads.length}</h2>
      <ul className="flex flex-col gap-0.5">
        {threads.map((entry) => {
          const indicator = indicators.get(entry.threadId) ?? null;
          return (
            <li key={entry.threadId}>
              <button
                type="button"
                aria-current={entry.current ? "true" : undefined}
                onClick={() => onSelect(entry.threadId)}
                title={indicator !== null && indicator.kind !== "working" ? `${entry.label}: ${indicator.reason}` : entry.label}
                className={cn(
                  "flex w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-2 text-left hover:bg-accent/50",
                  entry.kind === "task" ? "pl-2 text-sm text-foreground" : "pl-6 text-xs text-muted-foreground",
                  entry.current && "bg-accent text-foreground",
                )}
              >
                <span className="min-w-0 flex-1 truncate">{entry.kind === "task" ? `Task: ${entry.label}` : entry.label}</span>
                <LiveMark indicator={indicator} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The Live box's panes (activity.ts), asked for only while the box is open and
 * the tab on screen: every 2 s while something works, every 10 s when nothing
 * does, never two calls at once. Another task starts empty.
 */
function useTaskActivity(rpc: Rpc, taskId: string, enabled: boolean) {
  const [loaded, setLoaded] = useState<{ taskId: string; view: TaskActivity | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let asking = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      if (cancelled || asking || document.visibilityState !== "visible") return;
      asking = true;
      clearTimeout(timer);
      rpc.call("task_activity", { taskId }).then(
        (view) => {
          asking = false;
          if (cancelled) return;
          setLoaded({ taskId, view, error: null });
          timer = setTimeout(load, activityPollMs(view.panes.filter((pane) => pane.working).length));
        },
        (cause: unknown) => {
          asking = false;
          if (cancelled) return;
          // The last panes stay; the line above them says why they are old.
          setLoaded((last) => ({ taskId, view: last?.taskId === taskId ? last.view : null, error: message(cause) }));
          timer = setTimeout(load, ACTIVITY_IDLE_POLL_MS);
        },
      );
    };
    load();
    // Back on screen: ask at once; a hidden tab asks nothing.
    document.addEventListener("visibilitychange", load);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [rpc, taskId, enabled]);
  return loaded !== null && loaded.taskId === taskId ? loaded : { taskId, view: null, error: null };
}

type LivePaneView = TaskActivity["panes"][number];

/** One thread as a terminal: its lines, newest at the bottom, following them unless the owner scrolled up. */
function LivePane({ pane, indicator }: { pane: LivePaneView; indicator: Indicator }) {
  const body = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useEffect(() => {
    const element = body.current;
    if (element !== null && following.current) element.scrollTop = element.scrollHeight;
  }, [pane.lines]);
  return (
    <div className="orc-term flex min-h-0 flex-col overflow-hidden rounded-md">
      <div className="orc-term-head flex items-center gap-1.5 px-2 py-1 text-xs">
        <span className="min-w-0 flex-1 truncate" title={pane.label}>
          {pane.label}
        </span>
        {indicator !== null ? (
          <LiveMark indicator={indicator} />
        ) : pane.working ? (
          <span role="img" aria-label="Working" className="orc-spinner" />
        ) : null}
      </div>
      <div
        ref={body}
        className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5 font-mono text-xs leading-relaxed"
        onScroll={(event) => {
          const element = event.currentTarget;
          following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        }}
      >
        {pane.lines.length === 0 ? (
          <p className="orc-term-dim">No activity yet.</p>
        ) : (
          pane.lines.map((line) => (
            <div key={line.id} className={cn("whitespace-pre-wrap break-words", `orc-term-${line.kind}`)}>
              {line.text}
              {line.running ? <span role="img" aria-label="Running" className="orc-term-running" /> : null}
              {line.output !== null ? <div className="orc-term-dim">{line.output}</div> : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Live: what the task's agents are doing, one terminal per working thread
 * (activity.ts); with none working, the last thread's activity stays to look
 * over. It fills what is left of the task view and scrolls inside itself.
 */
function LiveSection({ rpc, taskId, indicators }: { rpc: Rpc; taskId: string; indicators: ReadonlyMap<string, Indicator> }) {
  const [open, setOpen] = useState(true);
  const { view, error } = useTaskActivity(rpc, taskId, open);
  const panes = view?.panes ?? [];
  const working = panes.filter((pane) => pane.working).length;
  return (
    <section aria-label="Live" className={cn("flex flex-col p-3", open && "min-h-0 shrink-0 grow basis-72")}>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
          onClick={() => setOpen((value) => !value)}
        >
          <span aria-hidden className="w-3">{open ? "▾" : "▸"}</span>
          Live · {working} working
        </button>
      </div>
      {open ? (
        <>
          {error !== null ? (
            <div className="mt-2">
              <ErrorLine>{error}</ErrorLine>
            </div>
          ) : null}
          {view !== null && working === 0 ? <p className="mt-2 text-xs text-muted-foreground">{NOTHING_RUNNING}</p> : null}
          <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
            <div className={cn("grid h-full auto-rows-[minmax(220px,1fr)] gap-2", panes.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
              {panes.map((pane) => (
                <LivePane key={pane.threadId} pane={pane} indicator={indicators.get(pane.threadId) ?? null} />
              ))}
            </div>
          </div>
        </>
      ) : null}
    </section>
  );
}

/** One tab per project; the active tab is the same focus the rail sets. Each opens that project's board. */
function BoardTabs({
  projects,
  colors,
  focusProjectId,
  badges,
  onFocusProject,
}: {
  projects: readonly ProjectView[];
  colors: ReadonlyMap<string, string>;
  focusProjectId: string | null;
  badges: ReadonlyMap<string, TabBadge>;
  onFocusProject: (projectId: string) => void;
}) {
  const tabs = projects.map((project) => ({ id: project.id, name: project.name, color: colors.get(project.id) ?? PALETTE[0].value }));
  return (
    <div role="tablist" aria-label="Chats" className="orc-tabs flex min-w-0 items-end gap-1.5 overflow-x-auto">
      {tabs.map((tab) => {
        const active = tab.id === focusProjectId;
        const badge = badges.get(tab.id);
        const label = [
          tab.name,
          badge?.needsYou ? `${badge.needsYou} need you` : null,
          badge?.working ? `${badge.working} working` : null,
        ]
          .filter(Boolean)
          .join(", ");
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={label}
            onClick={() => onFocusProject(tab.id)}
            style={tint(tab.color)}
            className={cn(
              "orc-tab relative flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
              active
                ? "border-border bg-accent font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            <span className="orc-dot" />
            <span className="max-w-[10rem] truncate">{tab.name}</span>
            <TabBadges badge={badge} />
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------- page

function BoardPage({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const now = useNow(30_000);
  const { state, error: stateError, reload } = useBoardState(rpc);
  const { repos, error: repoError, refreshing, refresh } = useRepos(rpc);
  const { view: liveness, error: livenessError } = useLiveness(rpc);
  const sidebar = experimental_useSidebarThreads();

  const threads = sidebar.threads;
  const threadsById = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);
  const projects = state?.projects ?? EMPTY;
  const colors = useProjectColors(projects);
  useAdoptSidebar(state, rpc);
  const projectName = useCallback(
    (projectId: string) => projects.find((project) => project.id === projectId)?.name ?? "Personal",
    [projects],
  );

  const tasks = state?.tasks ?? EMPTY;
  const children = state?.children ?? EMPTY;
  const tickets = state?.tickets ?? EMPTY;
  const patchesChats = state?.patchesChats;
  const indicators = useIndicators(state, threads, liveness);
  const pullRequestsFor = useCallback(
    (projectId: string) => repos?.repos.find((entry) => entry.projectId === projectId)?.repo?.pullRequests ?? [],
    [repos],
  );
  const reviewLabelFor = useCallback(
    (projectId: string) => projects.find((project) => project.id === projectId)?.reviewLabel ?? null,
    [projects],
  );
  const staleReview = useCallback(
    (task: Task) =>
      reviewStale({ task, pr: prForTask(task, pullRequestsFor(task.projectId)), aiTestsLabel: reviewLabelFor(task.projectId) }),
    [pullRequestsFor, reviewLabelFor],
  );
  const { owned, needs, badges } = useAttention(state, threads, indicators.trouble, staleReview);

  const rows = useMemo(
    () =>
      tasks.map((task) =>
        taskRow({
          task,
          threads: threadsById,
          children,
          tickets,
          pullRequests: pullRequestsFor(task.projectId),
          liveness: liveness?.tasks.find((entry) => entry.taskId === task.id),
          aiTestsLabel: reviewLabelFor(task.projectId),
          followUp: task.followUp ?? null,
          stepsLeft: task.stepsLeft ?? 0,
        }),
      ),
    [tasks, threadsById, children, tickets, pullRequestsFor, liveness, reviewLabelFor],
  );
  const otherPrs = useMemo(
    () =>
      (repos?.repos ?? []).flatMap((entry) =>
        entry.repo === null
          ? []
          : untrackedPullRequests(
              entry.repo.pullRequests,
              tasks.filter((task) => task.projectId === entry.projectId),
            ).map((pr) => {
              const tone = prTone(pr);
              return { projectId: entry.projectId, projectName: projectName(entry.projectId), pr, tone };
            }),
      ),
    [repos, tasks, projectName],
  );
  const repoErrors = (repos?.repos ?? [])
    .map((entry) => ({ projectName: projectName(entry.projectId), error: entry.error ?? entry.repo?.pullRequestError ?? null }))
    .filter((entry): entry is { projectName: string; error: string } => entry.error !== null);

  const workingIds = threads.filter(isWorking).map((thread) => thread.id);
  const focus = useWorkingFocus(workingIds);
  const routes = useMemo(
    () => new Map((state?.modelRoutes ?? EMPTY).map((route) => [route.threadId, route] as const)),
    [state?.modelRoutes],
  );
  const otherInputs = useOtherInputs(state, liveness);
  const [otherAgentsOpen, setOtherAgentsOpen] = useOtherAgentsOpen(rpc, state?.ui.otherAgentsOpen ?? null);

  // A project is its board; a task (or its research/build thread) narrows the right side to it.
  const scope = useMemo(
    () =>
      boardScope({
        subPath,
        newTaskPath: NEW_TASK_PATH,
        tasks,
        children,
        patchesChats: patchesChats ?? EMPTY,
        liveThreadIds: new Set(threadsById.keys()),
      }),
    [subPath, tasks, children, patchesChats, threadsById],
  );
  const selectedThreadId = scopeThread(scope);
  // A closed task opens by its own route (archive.ts closedPath); opening it changes nothing.
  const closedTaskId = scope.kind === "closed" ? scope.taskId : null;
  const [closedVersion, setClosedVersion] = useState(0);
  const closedTask = useClosedTask(rpc, closedTaskId, closedVersion);
  const openClosed = useCallback(
    (taskId: string, threadId?: string) =>
      navigate.toPluginPanel(PANEL_PATH, { subPath: closedPath(taskId, threadId), replace: true }),
    [navigate],
  );
  const select = useCallback(
    (threadId: string | null) =>
      navigate.toPluginPanel(PANEL_PATH, { subPath: threadId ?? "", replace: true }),
    [navigate],
  );
  const [focusError, setFocusError] = useState<string | null>(null);
  // The setup wizard: opened from the rail, or by itself on a first run until it is closed once.
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupDismissed, setSetupDismissed] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), 10_000);
    return () => clearTimeout(timer);
  }, [notice]);
  const deleteTask = useCallback(
    (task: DeletableTask) => {
      if (!window.confirm(DELETE_CONFIRM)) return;
      rpc.call("task_delete", { taskId: task.id }).then(
        (result) => {
          const worktree =
            result.worktree === "kept"
              ? ` Worktree kept: ${result.reason ?? "it has work that is not pushed."}`
              : result.worktree === "removed"
                ? " Its worktree is removed."
                : "";
          setNotice({ ok: true, text: `Deleted “${task.title}”; its chats are archived.${worktree}` });
          setClosedVersion((value) => value + 1);
          reload();
        },
        (cause: unknown) => setNotice({ ok: false, text: message(cause) }),
      );
    },
    [rpc, reload],
  );
  const setArchiveChats = useCallback(
    (enabled: boolean) => {
      rpc.call("archive_closed_chats", { enabled }).then(
        () => reload(),
        (cause: unknown) => setNotice({ ok: false, text: message(cause) }),
      );
    },
    [rpc, reload],
  );
  const sendFocus = useCallback(
    (projectId: string) => {
      rpc.call("focus_set", { projectId }).then(
        () => {
          setFocusError(null);
          reload();
        },
        (cause: unknown) => setFocusError(message(cause)),
      );
    },
    [rpc, reload],
  );
  /** Show a project's board: no chat, all of its tasks. */
  const focusProject = useCallback(
    (projectId: string) => {
      select(null);
      sendFocus(projectId);
    },
    [select, sendFocus],
  );

  if (state === null) {
    return (
      <div className="flex h-full flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        {stateError ?? "Loading The Orchestrator…"}
      </div>
    );
  }

  // Always one project in view (the server resolves it too); null only with no projects.
  const focusedProjectId = focusedProject(state.focusProjectId, projects);
  // A task's board is its own project's, open or closed, whatever the tab; anything else follows the selected tab.
  const scopedTaskId = scope.kind === "task" ? scope.taskId : null;
  const scopedTask = tasks.find((task) => task.id === scopedTaskId) ?? null;
  const boardProjectId = scopedTask?.projectId ?? closedTask.view?.projectId ?? focusedProjectId;
  const boardName = boardProjectId === null ? "No project" : projectName(boardProjectId);
  // Builds x/y and usage stay global.
  const inFocus = (projectId: string) => projectId === boardProjectId;
  const shownNeeds = inScope(scope, needs.filter((item) => inFocus(item.projectId)), (item) => item.taskId);
  const shownRows = inScope(scope, rows.filter((row) => inFocus(row.task.projectId)), (row) => row.task.id);
  const projectSections = showsProjectSections(scope);
  const shownThreads = threads.filter((thread) => inFocus(thread.projectId));
  const others = otherAgentsView({ threads: shownThreads, ownedThreadIds: owned, ...otherInputs, now });
  const shownPrs = otherPrs.filter((entry) => inFocus(entry.projectId));
  const closedChat = closedTask.view === null ? null : closedChatThread(closedTask.view.threads, selectedThreadId);
  const ownThreads =
    scopedTask === null
      ? []
      : taskThreads({ task: scopedTask, children, liveThreadIds: new Set(threadsById.keys()), currentThreadId: selectedThreadId });

  return (
    <div className="flex h-full min-h-0 flex-1">
      <ProjectRail
        projects={projects}
        colors={colors}
        tasks={tasks}
        primaryHostId={state.primaryHostId}
        projectsDir={state.projectsDir ?? DEFAULT_PROJECTS_DIR}
        onSetup={() => setSetupOpen(true)}
        focusProjectId={focusedProjectId}
        onFocusProject={focusProject}
        selectedTaskId={scopedTask?.id ?? null}
        onSelectThread={select}
        newTaskBlocked={newTaskBlockFor(state, focusedProjectId)}
        onNewTask={() => navigate.toPluginPanel(PANEL_PATH, { subPath: NEW_TASK_PATH })}
        onDeleteTask={deleteTask}
        rpc={rpc}
        reload={reload}
      />
      {scope.kind === "closed" ? (
        <ClosedChatColumn
          title={closedTask.view?.title ?? "Closed task"}
          thread={closedChat}
          loading={closedTask.loading}
          boardName={boardName}
          onBack={() => (boardProjectId !== null ? focusProject(boardProjectId) : select(null))}
        />
      ) : showsChat(scope) ? (
        <ChatColumn
          state={state}
          scope={scope}
          boardName={boardName}
          onSelect={select}
          onBack={() => (boardProjectId !== null ? focusProject(boardProjectId) : select(null))}
          rpc={rpc}
          reload={reload}
        />
      ) : null}
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-11 shrink-0 items-center gap-3 border-b border-border px-3 text-xs text-muted-foreground">
          <BoardTabs
            projects={projects.filter((project) => !project.hidden || project.id === focusedProjectId)}
            colors={colors}
            focusProjectId={focusedProjectId}
            badges={badges}
            onFocusProject={focusProject}
          />
          <span className="flex-1" />
          <LivenessStatus checkedAt={liveness?.checkedAt ?? null} error={livenessError ?? stateError ?? liveness?.error ?? null} />
          <UsageStatus usage={liveness?.usage ?? null} />
          <HeadroomStatus headroom={liveness?.headroom ?? null} />
          <span className="shrink-0" title="Across every project">
            Builds {state.buildsInFlight}/{state.buildCap || BUILD_CAP}
          </span>
          {repos !== null ? <span className="shrink-0">PRs updated {relativeTime(repos.fetchedAt, now)}</span> : null}
          <Button variant="ghost" size="sm" onClick={refresh} disabled={refreshing} aria-label="Refresh pull requests">
            <Icon name="ArrowReloadHorizontal" className={cn("size-4", refreshing && "motion-safe:animate-spin")} />
          </Button>
        </div>
        {stateError !== null || repoError !== null || focusError !== null ? (
          <div className="border-b border-border px-3 py-2">
            <ErrorLine>{stateError ?? repoError ?? focusError}</ErrorLine>
          </div>
        ) : null}
        {notice !== null ? (
          <div className="border-b border-border px-3 py-2" role="status">
            {notice.ok ? <p className="text-xs text-muted-foreground">{notice.text}</p> : <ErrorLine>{notice.text}</ErrorLine>}
          </div>
        ) : null}
        {(liveness?.configProblem ?? null) !== null ? (
          <div className="border-b border-border px-3 py-2">
            <ErrorLine>{liveness?.configProblem}</ErrorLine>
          </div>
        ) : null}
        <ChatTroubleLines chats={liveness?.chats ?? []} projects={state.projects} />
        <UsageWarningLine usage={liveness?.usage ?? null} />
        {/* A task's view is a column so its Live box takes the height left over. */}
        <div className={cn("min-h-0 flex-1 overflow-y-auto", scopedTask !== null && "flex flex-col")}>
          {scopedTask !== null && boardProjectId !== null ? (
            <div className="border-b border-border px-3 py-2">
              <button
                type="button"
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
                onClick={() => focusProject(boardProjectId)}
              >
                <Icon name="ChevronLeft" className="size-3.5" />
                All tasks in {boardName}
              </button>
            </div>
          ) : null}
          <SignInPopup signedOut={state.signedOut} rpc={rpc} />
          <SetupWizard
            open={setupOpen || (state.needsSetup && !setupDismissed)}
            onClose={() => {
              setSetupOpen(false);
              setSetupDismissed(true);
            }}
            rpc={rpc}
            reload={reload}
            onFocusProject={focusProject}
          />
          {scope.kind === "closed" ? (
            <ClosedTaskSection
              view={closedTask.view}
              error={closedTask.error}
              boardName={boardName}
              currentThreadId={closedChat?.threadId ?? null}
              now={now}
              onBack={() => (boardProjectId !== null ? focusProject(boardProjectId) : select(null))}
              onOpenThread={(threadId) => openClosed(scope.taskId, threadId)}
            />
          ) : (
            <>
              <NeedsYouSection
                items={shownNeeds}
                state={state}
                headroom={liveness?.headroom?.needsOwner ?? null}
                colors={colors}
                onSelect={select}
                rpc={rpc}
                reload={reload}
              />
              <section aria-label="Tasks" className="border-b border-border p-3">
                <table className="orc-table w-full table-fixed border-separate border-spacing-y-1">
                  <colgroup>
                    <col className="w-[28%]" />
                    <col className="w-[17%]" />
                    <col className="w-[17%]" />
                    <col className="w-[24%]" />
                    <col className="w-[14%]" />
                  </colgroup>
                  <thead>
                    <tr className="text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 font-medium">Task</th>
                      <th className="px-3 font-medium">Research</th>
                      <th className="px-3 font-medium">Build</th>
                      <th className="px-3 font-medium">PR</th>
                      <th className="px-3 font-medium">You</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownRows.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-3 py-4 text-sm text-muted-foreground">
                          {boardProjectId === null
                            ? "No projects yet. Add project in the Projects list to start."
                            : `No open tasks in ${boardName}. Press + to start one.`}
                        </td>
                      </tr>
                    ) : (
                      shownRows.map((row) => (
                        <TaskRowView
                          key={row.task.id}
                          row={row}
                          indicator={indicators.byTask.get(row.task.id) ?? null}
                          project={projectName(row.task.projectId)}
                          color={colors.get(row.task.projectId) ?? PALETTE[0].value}
                          focus={focus}
                          routes={routes}
                          selected={row.task.id === scopedTask?.id}
                          onSelect={select}
                          onDelete={deleteTask}
                          rpc={rpc}
                          reload={reload}
                        />
                      ))
                    )}
                  </tbody>
                </table>
              </section>
              {scopedTask !== null ? (
                <>
                  <TaskThreadsSection threads={ownThreads} indicators={indicators.byThread} onSelect={select} />
                  <LiveSection rpc={rpc} taskId={scopedTask.id} indicators={indicators.byThread} />
                </>
              ) : null}
            </>
          )}
          {projectSections ? (
            <>
              <JevWatchLine entry={(state.jevWatch ?? []).find((entry) => entry.projectId === boardProjectId)} />
              <ModelRoutingLine routes={state.modelRoutes ?? EMPTY} projectId={boardProjectId} routeKey={state.modelRouteKey ?? null} />
              <OtherAgents
                view={others}
                savedOpen={otherAgentsOpen}
                onToggle={setOtherAgentsOpen}
                projectName={projectName}
                colors={colors}
                focus={focus}
                now={now}
                onSelect={select}
              />
              <OpenPullRequests entries={shownPrs} colors={colors} errors={repoErrors} />
              <CompletedSection
                projectId={boardProjectId}
                count={boardProjectId === null ? 0 : (state.closedCounts[boardProjectId] ?? 0)}
                color={(boardProjectId !== null ? colors.get(boardProjectId) : undefined) ?? PALETTE[0].value}
                version={closedVersion}
                now={now}
                onOpen={openClosed}
                onDelete={deleteTask}
                archiveChats={state.archiveClosedChats}
                onArchiveChats={setArchiveChats}
                rpc={rpc}
              />
            </>
          ) : null}
        </div>
      </main>
    </div>
  );
}

// -------------------------------------------------------- sidebar list

/**
 * The app sidebar's thread list, replaced: a row per project, which opens its
 * board, and under the project in view its tasks with their research and
 * build threads, each opening its task. Every row opens on the board.
 */
function ChatsSidebar({ activeThreadId, onNavigate }: PluginThreadListProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const now = useNow(60_000);
  const { state, error: stateError, reload } = useBoardState(rpc);
  const { threads } = experimental_useSidebarThreads();
  const { view: liveness, error: livenessError } = useLiveness(rpc);
  const indicators = useIndicators(state, threads, liveness);
  const { owned, badges } = useAttention(state, threads, indicators.trouble);
  const otherInputs = useOtherInputs(state, liveness);
  const othersCount = useMemo(
    () => otherAgentsView({ threads, ownedThreadIds: owned, ...otherInputs, now }).count,
    [threads, owned, otherInputs, now],
  );
  const colors = useProjectColors(state?.projects ?? EMPTY);
  const [error, setError] = useState<string | null>(null);
  const rows = useMemo(
    () =>
      state === null
        ? []
        : sidebarRows({
            projects: state.projects,
            patchesChats: state.patchesChats,
            tasks: state.tasks,
            children: state.children,
            liveThreadIds: new Set(threads.map((thread) => thread.id)),
            badges,
            indicators: indicators.byThread,
            focusProjectId: state.focusProjectId,
            activeThreadId,
            otherAgents: othersCount,
          }),
    [state, threads, badges, indicators, activeThreadId, othersCount],
  );

  if (state === null) {
    return <p className="px-3 py-2 text-xs text-muted-foreground">{stateError ?? "Loading…"}</p>;
  }

  const setFocus = (projectId: string) =>
    rpc.call("focus_set", { projectId }).then(
      () => {
        setError(null);
        reload();
      },
      (cause: unknown) => setError(message(cause)),
    );
  const open = (row: SidebarRow) => {
    if (row.kind === "chat") {
      // The project's board, never its Patches chat.
      navigate.toPluginPanel(PANEL_PATH, { subPath: "" });
      void setFocus(row.projectId);
    } else if (row.kind === "task") {
      // Keep the board on the task's project.
      if (state.focusProjectId !== row.projectId) void setFocus(row.projectId);
      navigate.toPluginPanel(PANEL_PATH, { subPath: row.threadId });
    } else {
      navigate.toPluginPanel(PANEL_PATH, { subPath: "" });
    }
    onNavigate();
  };
  const newTask = (projectId: string) => {
    if (state.focusProjectId !== projectId) void setFocus(projectId);
    navigate.toPluginPanel(PANEL_PATH, { subPath: NEW_TASK_PATH });
    onNavigate();
  };

  return (
    <nav aria-label="Chats and tasks" className="flex flex-col gap-0.5 px-2 py-1">
      {rows.map((row) => {
        if (row.kind === "chat") {
          const label = [
            row.name,
            row.badge.needsYou ? `${row.badge.needsYou} need you` : null,
            row.badge.working ? `${row.badge.working} working` : null,
          ]
            .filter(Boolean)
            .join(", ");
          const button = (
            <button
              key={row.key}
              type="button"
              aria-label={label}
              aria-current={row.active || (row.focused && activeThreadId === null) ? "true" : undefined}
              onClick={() => open(row)}
              style={tint(colors.get(row.projectId) ?? PALETTE[0].value)}
              className={cn(
                "flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent/50",
                row.active ? "bg-accent text-foreground" : "text-muted-foreground",
                row.focused && "font-medium text-foreground",
              )}
            >
              <span className="orc-dot" />
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
              <TabBadges badge={row.badge} className="orc-side-badges" />
            </button>
          );
          const { projectId } = row;
          if (!row.focused) return button;
          return (
            <div key={row.key} className="flex min-w-0 items-center gap-0.5">
              <div className="flex min-w-0 flex-1 flex-col">{button}</div>
              <NewTaskButton blocked={newTaskBlockFor(state, projectId)} onClick={() => newTask(projectId)} />
            </div>
          );
        }
        if (row.kind === "task") {
          return (
            <button
              key={row.key}
              type="button"
              aria-current={row.active ? "true" : undefined}
              onClick={() => open(row)}
              title={row.indicator !== null && row.indicator.kind !== "working" ? `${row.title}: ${row.indicator.reason}` : row.title}
              className={cn(
                "flex min-w-0 items-center gap-1.5 rounded-md py-1 pr-2 text-left hover:bg-accent/50",
                row.depth === 0 ? "pl-7 text-sm text-foreground" : "pl-10 text-xs text-muted-foreground",
                row.active && "bg-accent text-foreground",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{row.title}</span>
              <LiveMark indicator={row.indicator} />
            </button>
          );
        }
        return (
          <button
            key={row.key}
            type="button"
            onClick={() => open(row)}
            className="mt-1 flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          >
            Other agents ({row.count})
          </button>
        );
      })}
      <div className="px-2 pt-1 text-[11px] text-muted-foreground">
        <LivenessStatus checkedAt={liveness?.checkedAt ?? null} error={livenessError ?? stateError ?? liveness?.error ?? null} />
      </div>
      {error !== null ? <div className="px-2 pt-1"><ErrorLine>{error}</ErrorLine></div> : null}
    </nav>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "board",
    title: "The Orchestrator",
    icon: "Workflow",
    path: PANEL_PATH,
    component: BoardPage,
  });
  app.slots.experimental_threadList({
    id: THREAD_LIST_ID,
    title: "The Orchestrator",
    description: "Each project's board; tasks are the threads.",
    component: ChatsSidebar,
  });
});
