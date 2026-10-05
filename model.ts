// Pure board derivation: which task is at which stage, which cell animates,
// and what needs the owner (agents outside any task: others.ts). No React, no SDK
// runtime — model.test.ts pins the policy.
import { owner } from "./owner";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { BUILD_FAILURE_LIMIT, buildNeedsSam } from "./attention";
import type { PullRequest } from "./contract";
import { reportedLandedShas } from "./landed";
import type { AgentLiveness, TaskLiveness, Trouble } from "./liveness";
import { reviewStale } from "./review";
import { stepsLabel } from "./steps";
import type { Child, Stage, Task, Ticket } from "./store";
import { reportItemTitle, reportStatusLabel } from "./report";
import { prTone, type PrTone } from "./validation";

/** The owner's cap on build agents working at once. */
export const BUILD_CAP = 4;
/** orc's rule: a task brings the owner at most this many open questions. */
export const MAX_OPEN_QUESTIONS = 3;

const BUSY = new Set(["starting", "active", "stopping"]);

/** The agent is mid-turn: this is what gets the "working" animation. */
export function isWorking(thread: PluginSidebarThread | undefined): boolean {
  return thread !== undefined && BUSY.has(thread.status);
}

/** Blocked on the owner: a native question or approval in the thread itself. */
export function isAsking(thread: PluginSidebarThread | undefined): boolean {
  return (
    thread !== undefined &&
    (thread.hasPendingInteraction || thread.indicator === "waiting-for-input")
  );
}

// ------------------------------------------------------------------ colours

/** Project tile colours: mid-lightness, so they read on light and dark themes. */
export const PALETTE = [
  { key: "blue", value: "oklch(0.62 0.16 255)" },
  { key: "green", value: "oklch(0.64 0.15 150)" },
  { key: "orange", value: "oklch(0.68 0.16 55)" },
  { key: "magenta", value: "oklch(0.62 0.19 330)" },
  { key: "teal", value: "oklch(0.64 0.11 200)" },
  { key: "violet", value: "oklch(0.58 0.17 290)" },
  { key: "gold", value: "oklch(0.72 0.14 90)" },
  { key: "red", value: "oklch(0.6 0.19 25)" },
] as const;
export type ColorKey = (typeof PALETTE)[number]["key"];

export function colorValue(key: string | null | undefined): string {
  return PALETTE.find((entry) => entry.key === key)?.value ?? PALETTE[0].value;
}

/**
 * A distinct colour per project: the owner's pick where they made one, then the first
 * palette colour nobody holds, in project order. Wraps only past 8 projects.
 */
export function assignColors(
  projectIds: readonly string[],
  picked: ReadonlyMap<string, string | null>,
): Map<string, ColorKey> {
  const out = new Map<string, ColorKey>();
  const used = new Set<string>();
  for (const id of projectIds) {
    const key = picked.get(id);
    if (key != null && PALETTE.some((entry) => entry.key === key)) {
      out.set(id, key as ColorKey);
      used.add(key);
    }
  }
  let cursor = 0;
  for (const id of projectIds) {
    if (out.has(id)) continue;
    const free = PALETTE.find((entry) => !used.has(entry.key));
    const key = free?.key ?? PALETTE[cursor % PALETTE.length]!.key;
    cursor += 1;
    used.add(key);
    out.set(id, key);
  }
  return out;
}

// -------------------------------------------------------------------- rows

export type CellState = "pending" | "working" | "done" | "blocked" | "failed" | "skipped";

export interface Cell {
  state: CellState;
  /** Short words for the cell; the focus line of a working agent replaces it. */
  label: string;
  /** The thread whose current step the cell shows while working. */
  threadId: string | null;
}

export interface TaskRow {
  task: Task;
  thread: PluginSidebarThread | undefined;
  research: Cell;
  build: Cell;
  pr: { pr: PullRequest | null; tone: PrTone | null; branch: string | null };
  you: { questions: number; review: boolean; asking: boolean; report: boolean };
  working: boolean;
}

/** The first non-empty line, for one-line labels; null when there is none. */
export function firstLine(text: string | null | undefined): string | null {
  return text?.split("\n").map((line) => line.trim()).find(Boolean) ?? null;
}

const STAGE_ORDER: Record<Stage, number> = { research: 0, build: 1, pr: 2, you: 3, done: 4 };

/** The task's PR: the one it recorded, else an open PR from its branch. */
export function prForTask(task: Task, pullRequests: readonly PullRequest[]): PullRequest | null {
  if (task.prNumber !== null) {
    const byNumber = pullRequests.find((pr) => pr.number === task.prNumber);
    if (byNumber !== undefined) return byNumber;
  }
  if (task.branch === null) return null;
  const mine = pullRequests.filter((pr) => pr.headRefName === task.branch);
  return mine.find((pr) => pr.state === "open") ?? mine.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}

export function taskRow({
  task,
  threads,
  children,
  tickets,
  pullRequests,
  liveness,
  aiTestsLabel = null,
  followUp = null,
  stepsLeft = 0,
}: {
  task: Task;
  threads: ReadonlyMap<string, PluginSidebarThread>;
  children: readonly Child[];
  tickets: readonly Ticket[];
  pullRequests: readonly PullRequest[];
  /** The last liveness check of this task, when there is one. */
  liveness?: TaskLiveness | undefined;
  /** The label a proven PR must keep (review.ts reviewLabel). */
  aiTestsLabel?: string | null;
  /** A done report's remaining item (done.ts followUpOf), when there is one. */
  followUp?: string | null;
  /** Steps left after the task's last land (steps.ts stepsLeftCount); 0 when none. */
  stepsLeft?: number;
}): TaskRow {
  const thread = task.threadId === null ? undefined : threads.get(task.threadId);
  const mine = children.filter((child) => child.taskId === task.id);
  const researchThreads = mine.filter((child) => child.kind === "research");
  const buildThreads = mine.filter((child) => child.kind === "build");
  const stage = STAGE_ORDER[task.stage];
  const open = tickets.filter((ticket) => ticket.taskId === task.id && ticket.status === "open");
  const questions = open
    .filter((ticket) => ticket.kind === "questions")
    .reduce((sum, ticket) => sum + ticket.questions.length, 0);
  const report = open.some((ticket) => ticket.kind === "report");
  const asking = [thread, ...mine.map((child) => threads.get(child.threadId))].some(isAsking);
  const taskAgent = liveness?.agents.find((agent) => agent.role === "task" && agent.threadId === task.threadId);

  const workingResearch = researchThreads.find((child) => isWorking(threads.get(child.threadId)));
  let research: Cell;
  if (workingResearch !== undefined) {
    research = { state: "working", label: workingResearch.label, threadId: workingResearch.threadId };
  } else if (task.stage === "research" && (isWorking(thread) || taskAgent?.state === "working")) {
    research = { state: "working", label: "Planning", threadId: task.threadId };
  } else if (task.stage === "research") {
    research = {
      ...notPlanning({ task, questions, asking, report, taskAgent, followUp, stepsLeft, unheard: liveness?.unheard ?? null }),
      threadId: task.threadId,
    };
  } else {
    // Finished research stays one click away: the cell opens the latest researcher.
    research = {
      state: "done",
      label: researchThreads.length > 0 ? `${researchThreads.length} researched` : "Planned",
      threadId: researchThreads[researchThreads.length - 1]?.threadId ?? null,
    };
  }

  const latestBuild = buildThreads[buildThreads.length - 1];
  const buildThread = latestBuild === undefined ? undefined : threads.get(latestBuild.threadId);
  let build: Cell;
  if (task.buildState === "failed") {
    const error = firstLine(task.buildError) ?? "Build could not start";
    build = {
      state: "failed",
      label: buildNeedsSam(task) ? error : `Task fixing (${task.buildFailures}/${BUILD_FAILURE_LIMIT}): ${error}`,
      threadId: latestBuild?.threadId ?? null,
    };
  } else if (task.buildState === "preparing") {
    build = { state: "working", label: "Preparing worktree", threadId: null };
  } else if (isWorking(buildThread)) {
    build = { state: "working", label: "Building", threadId: latestBuild?.threadId ?? null };
  } else if (isAsking(buildThread)) {
    build = { state: "blocked", label: "Builder needs an answer", threadId: latestBuild?.threadId ?? null };
  } else if (stage > 1 || (latestBuild !== undefined && task.stage === "build")) {
    build = { state: "done", label: stage > 1 ? "Built" : "Builder finished", threadId: latestBuild?.threadId ?? null };
  } else {
    build = { state: "pending", label: "", threadId: null };
  }

  const pr = prForTask(task, pullRequests);
  return {
    task,
    thread,
    research,
    build,
    pr: { pr, tone: pr === null ? null : prTone(pr), branch: task.branch ?? pr?.headRefName ?? null },
    you: {
      questions,
      // A review ticket counts only while the PR is still what was proven.
      review: open.some((ticket) => ticket.kind === "review") && reviewStale({ task, pr, aiTestsLabel }) === null,
      asking,
      report,
    },
    working:
      isWorking(thread) ||
      mine.some((child) => isWorking(threads.get(child.threadId))) ||
      task.buildState === "preparing",
  };
}

/**
 * A research-stage task whose thread is not running is not planning: it waits
 * on the owner (questions, or a report to review: report.ts), landed a step and has more left (steps.ts: idle, kept open), says
 * it landed (landed.ts closes it once git agrees and nothing is open), waits
 * to start, is stuck (liveness marks why), is stalled because
 * no Patches chat hears it go idle (`unheard`), or is idle until Patches,
 * who was told, sends it something.
 */
export function notPlanning({
  task,
  questions,
  asking,
  report = false,
  taskAgent,
  followUp = null,
  stepsLeft = 0,
  unheard = null,
}: {
  task: Pick<Task, "note">;
  questions: number;
  asking: boolean;
  /** An open report ticket: the owner reviews it, then the task closes. */
  report?: boolean;
  taskAgent: AgentLiveness | undefined;
  /** The done report names work left: kept open for Patches, not planning. */
  followUp?: string | null;
  /** Steps left after the task's last land: kept open and idle, not planning. */
  stepsLeft?: number;
  /** Why Patches is not told when it goes idle (liveness.ts TaskLiveness.unheard). */
  unheard?: string | null;
}): Pick<Cell, "state" | "label"> {
  if (questions > 0 || asking) return { state: "blocked", label: `Waiting on ${owner()}` };
  if (report) return { state: "blocked", label: reportStatusLabel() };
  if (stepsLeft > 0) return { state: "pending", label: stepsLabel(stepsLeft) };
  if (followUp !== null) return { state: "done", label: "Done, with a follow-up" };
  const landed = reportedLandedShas(task.note)[0];
  if (landed !== undefined) return { state: "pending", label: `Says landed ${landed.slice(0, 7)}, not closed` };
  switch (taskAgent?.state) {
    case "waiting":
      return { state: "pending", label: "Waiting to plan" };
    case "stale":
    case "error":
    case "blocked":
    case "gone":
      return { state: "failed", label: "Not running" };
    default:
      // Waiting on Patches is only true when she hears it go idle.
      if (unheard !== null) return { state: "failed", label: "Stalled · Patches not told" };
      return { state: "pending", label: "Idle · waiting on Patches" };
  }
}

// ---------------------------------------------------------------- needs you

export interface NeedsYouItem {
  key: string;
  taskId: string | null;
  /** The thread the chat column opens for this ticket. */
  threadId: string | null;
  title: string;
  projectId: string;
  /** "Subscription tiers · 3 questions" — one line, whatever the count. */
  summary: string;
  tone: "attention" | "danger" | "success";
  questionTicketId: string | null;
  reviewTicketId: string | null;
  /** The task's open report (report.ts): Read report, Mark reviewed, Follow up. */
  report: { ticketId: string; title: string; summary: string | null; path: string } | null;
  /** A thread in the task has a native question or approval open. */
  asking: boolean;
  /** The task's build failed past BUILD_FAILURE_LIMIT: Retry or Dismiss. */
  buildFailed: boolean;
  /** The task's own thread errored or went silent (liveness.ts): Restart. */
  agentTrouble: string | null;
  /** bb refuses the task thread's messages: Restart cannot help, the lock has to go. */
  agentBlocked: boolean;
}

/** The owner answering or closing a task's ticket settles what it put in front of them: a failed build goes back to the task's agent. */
export function answeredTaskPatch(task: Task): Partial<Pick<Task, "buildState" | "buildError" | "buildFailures">> {
  return task.buildState === "failed" ? { buildState: "none", buildError: null, buildFailures: 0 } : {};
}

/**
 * ONE ticket per task, however many questions it has and wherever they came
 * from: open question tickets, a native question in any of the task's
 * threads, a failed build the task could not fix, and the review hand-off
 * all fold into it, and so does the task's own thread in trouble (errored or
 * silent: nobody below the owner can restart it). A failed build the task is still
 * fixing, or a child agent in trouble, is not the owner's: it shows on the task's
 * row instead. Agents outside any task that are blocked on the owner come after,
 * one each.
 */
export function needsYou({
  tasks,
  tickets,
  children,
  threads,
  ownedThreadIds,
  trouble = new Map(),
  reviewStale: staleReview = () => null,
}: {
  tasks: readonly Task[];
  tickets: readonly Ticket[];
  children: readonly Child[];
  threads: readonly PluginSidebarThread[];
  ownedThreadIds: ReadonlySet<string>;
  /** The last liveness check's trouble, by task id. */
  trouble?: ReadonlyMap<string, readonly Trouble[]>;
  /** Why a task's review ticket no longer holds (review.ts), or null; the server closes it soon after. */
  reviewStale?: (task: Task) => string | null;
}): NeedsYouItem[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const items: NeedsYouItem[] = [];
  for (const task of tasks) {
    if (task.closedAt !== null) continue;
    const open = tickets.filter((ticket) => ticket.taskId === task.id && ticket.status === "open");
    const questionTicket = open.find((ticket) => ticket.kind === "questions") ?? null;
    // Never a merge ask for an unproven head: a stale review ticket is not shown.
    const reviewTicket = open.find((ticket) => ticket.kind === "review" && staleReview(task) === null) ?? null;
    const reportTicket = open.find((ticket) => ticket.kind === "report" && ticket.report) ?? null;
    const report =
      reportTicket?.report == null
        ? null
        : { ticketId: reportTicket.id, title: reportTicket.report.title, summary: reportTicket.report.summary, path: reportTicket.report.path };
    const taskThreads = [task.threadId, ...children.filter((c) => c.taskId === task.id).map((c) => c.threadId)]
      .filter((id): id is string => id !== null);
    const askingThread = taskThreads.find((id) => isAsking(byId.get(id))) ?? null;
    const questionCount = questionTicket?.questions.length ?? 0;
    const parts: string[] = [];
    let tone: NeedsYouItem["tone"] | null = null;
    if (questionCount > 0) {
      parts.push(`${questionCount} question${questionCount === 1 ? "" : "s"}`);
      tone = "attention";
    }
    if (askingThread !== null) {
      parts.push("waiting on you in chat");
      tone = "attention";
    }
    const buildFailed = buildNeedsSam(task);
    if (buildFailed) {
      parts.push(`build failed ${task.buildFailures}×: ${firstLine(task.buildError) ?? "no reason recorded"}`);
      tone ??= "danger";
    }
    const samTrouble = trouble.get(task.id)?.find((entry) => entry.samMustAct);
    const agentTrouble = samTrouble?.reason ?? null;
    if (agentTrouble !== null) {
      parts.push(agentTrouble);
      tone ??= "danger";
    }
    if (reviewTicket !== null) {
      parts.push(task.prNumber !== null ? `PR #${task.prNumber} ready: test and merge` : "ready for you");
      tone ??= "success";
    }
    if (report !== null) {
      parts.push("report ready");
      tone ??= "success";
    }
    if (tone === null) continue;
    // A report alone is titled by it: "Review report: <title>".
    const alone = report !== null && parts.length === 1;
    items.push({
      key: `task:${task.id}`,
      taskId: task.id,
      threadId: askingThread ?? task.threadId,
      title: alone ? reportItemTitle(report.title) : task.title,
      projectId: task.projectId,
      summary: alone ? reportItemTitle(report.title) : `${task.title} · ${parts.join(" · ")}`,
      tone,
      questionTicketId: questionTicket?.id ?? null,
      reviewTicketId: reviewTicket?.id ?? null,
      report,
      asking: askingThread !== null,
      buildFailed,
      agentTrouble,
      agentBlocked: samTrouble?.kind === "blocked",
    });
  }
  for (const thread of threads) {
    if (ownedThreadIds.has(thread.id) || thread.isArchived || thread.isHidden) continue;
    if (!isAsking(thread)) continue;
    items.push({
      key: `thread:${thread.id}`,
      taskId: null,
      threadId: thread.id,
      title: thread.displayTitle,
      projectId: thread.projectId,
      summary: `${thread.displayTitle} · waiting on you`,
      tone: "attention",
      questionTicketId: null,
      reviewTicketId: null,
      report: null,
      asking: true,
      buildFailed: false,
      agentTrouble: null,
      agentBlocked: false,
    });
  }
  const rank = { attention: 0, danger: 1, success: 2 } as const;
  return items.sort((a, b) => rank[a.tone] - rank[b.tone]);
}

/** Open PRs no task owns, so every project's PRs are on the board somewhere. */
export function untrackedPullRequests(
  pullRequests: readonly PullRequest[],
  tasks: readonly Task[],
): PullRequest[] {
  const owned = new Set<number>();
  for (const task of tasks) {
    const pr = prForTask(task, pullRequests);
    if (pr !== null) owned.add(pr.number);
  }
  return pullRequests.filter((pr) => pr.state === "open" && !owned.has(pr.number));
}

// ------------------------------------------------------------------ builds

/** Builds holding a slot: preparing a worktree, or building before the PR. */
export function buildsInFlight(tasks: readonly Task[]): Task[] {
  return tasks.filter(
    (task) =>
      task.closedAt === null &&
      task.stage === "build" &&
      (task.buildState === "preparing" || task.buildState === "running"),
  );
}

export function relativeTime(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// -------------------------------------------------------------------- tabs

/** The key a board tab counts under: a project id, or "any" for the totals. */
export type TabKey = string | "any";

export interface TabBadge {
  /** Orange: that project's items in Needs you. */
  needsYou: number;
  /** Green: research and build threads mid-turn, plus builds preparing. */
  working: number;
}

/**
 * The badges on each board tab. Orange counts exactly the Needs you list,
 * by project. Green counts the task's research and build threads that are
 * working, plus a build still preparing its worktree; the task thread itself
 * does not count. Closed tasks never count. "any" holds the totals. Claude
 * signed out is one item on every project's board: +1 on each project, and
 * +1 on "any" once, not once per project.
 */
export function tabBadges({
  needsYou: items,
  tasks,
  children,
  threads,
  signedOut,
  projectIds,
}: {
  needsYou: readonly NeedsYouItem[];
  tasks: readonly Task[];
  children: readonly Child[];
  threads: readonly PluginSidebarThread[];
  /** Claude is signed out (signin.ts). */
  signedOut: boolean;
  /** Every project with a board tab. */
  projectIds: readonly string[];
}): Map<TabKey, TabBadge> {
  const out = new Map<TabKey, TabBadge>([["any", { needsYou: 0, working: 0 }]]);
  const bump = (projectId: string, field: keyof TabBadge) => {
    for (const key of [projectId, "any"]) {
      const badge = out.get(key) ?? { needsYou: 0, working: 0 };
      badge[field] += 1;
      out.set(key, badge);
    }
  };
  for (const item of items) bump(item.projectId, "needsYou");
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const open = new Map(tasks.filter((task) => task.closedAt === null).map((task) => [task.id, task]));
  for (const child of children) {
    const task = open.get(child.taskId);
    if (task !== undefined && isWorking(byId.get(child.threadId))) bump(task.projectId, "working");
  }
  for (const task of open.values()) {
    if (task.buildState === "preparing") bump(task.projectId, "working");
  }
  if (signedOut) {
    for (const key of new Set([...projectIds, "any"])) {
      const badge = out.get(key) ?? { needsYou: 0, working: 0 };
      badge.needsYou += 1;
      out.set(key, badge);
    }
  }
  return out;
}

// --------------------------------------------------------------- completed

export type Completion =
  | { kind: "landed"; target: string; sha: string }
  | { kind: "merged" | "closed"; pr: number }
  | { kind: "archived" | "deleted" | "done" }
  | { kind: "closed" };

/** How a closed task finished, read from the note server.ts hands store.closeTask. */
export function completionOf(task: Pick<Task, "note">): Completion {
  const note = task.note ?? "";
  const landed = /^Landed on (\S+) at ([0-9a-f]{7,40}):/.exec(note);
  if (landed !== null) return { kind: "landed", target: landed[1]!, sha: landed[2]! };
  const pr = /^PR #(\d+) (merged|closed)\./.exec(note);
  if (pr !== null) return { kind: pr[2] as "merged" | "closed", pr: Number(pr[1]) };
  if (note === "Task thread archived.") return { kind: "archived" };
  // Whatever the owner was called when it was deleted (owner.ts).
  if (/^Deleted by [^\n]{1,60}\.$/.test(note)) return { kind: "deleted" };
  // done.ts doneNote: a research-only task that said it was done, then sat idle.
  if (note.startsWith("Done: ")) return { kind: "done" };
  return { kind: "closed" };
}

/** One line for the Completed row: "Landed on main · abc1234", "Merged PR #12". */
export function completionLabel(completion: Completion): string {
  switch (completion.kind) {
    case "landed":
      return `Landed on ${completion.target} · ${completion.sha}`;
    case "merged":
      return `Merged PR #${completion.pr}`;
    case "archived":
      return "Archived";
    case "deleted":
      return "Deleted";
    case "done":
      return "Done";
    case "closed":
      return "pr" in completion ? `PR #${completion.pr} closed` : "Closed";
  }
}
