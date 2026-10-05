// The dossier store: tasks, their area claims, the owner's tickets, the research and
// build threads under each task, and per-project board preferences. SQLite
// through a minimal interface so the tests run it on node:sqlite and the
// plugin on bb's better-sqlite3 handle. Synchronous on purpose: a claim check
// and its insert cannot interleave with another tool call.
import { askLine, type Ask } from "./attention";
import { actualOutcome, type JevAskRecord, type JevWatchRow, type OutcomeFacts } from "./jevwatch";
import type { RouteRecord } from "./modelroute";
import { reportKey } from "./landed";
import type { Claim } from "./claims";
import type { ReportRef } from "./report";

export interface SqlStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
export interface SqlDb {
  exec(sql: string): unknown;
  prepare(sql: string): SqlStatement;
}

/** Append-only: bb.storage.migrate runs each unapplied statement once, in order. */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS project_prefs (
     project_id TEXT PRIMARY KEY,
     color TEXT,
     hidden INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS tasks (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     title TEXT NOT NULL,
     brief TEXT NOT NULL,
     stage TEXT NOT NULL,
     thread_id TEXT,
     branch TEXT,
     base_ref TEXT,
     worktree_path TEXT,
     worktree_note TEXT,
     build_state TEXT NOT NULL DEFAULT 'none',
     build_error TEXT,
     pr_number INTEGER,
     pr_url TEXT,
     verdict TEXT,
     verified_sha TEXT,
     decisions TEXT NOT NULL DEFAULT '[]',
     test_list TEXT NOT NULL DEFAULT '[]',
     note TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     closed_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS claims (
     task_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     path TEXT NOT NULL,
     PRIMARY KEY (task_id, path)
   )`,
  `CREATE TABLE IF NOT EXISTS tickets (
     id TEXT PRIMARY KEY,
     task_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     questions TEXT NOT NULL DEFAULT '[]',
     answers TEXT,
     status TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     closed_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS children (
     thread_id TEXT PRIMARY KEY,
     task_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     label TEXT NOT NULL,
     summary TEXT,
     created_at INTEGER NOT NULL
   )`,
  `ALTER TABLE tasks ADD COLUMN build_failures INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE tasks ADD COLUMN build_request TEXT`,
  `ALTER TABLE tickets ADD COLUMN asks TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE tasks ADD COLUMN head_sha TEXT`,
  `CREATE TABLE IF NOT EXISTS releases (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     task_id TEXT NOT NULL,
     paths TEXT NOT NULL DEFAULT '[]',
     reason TEXT NOT NULL,
     by TEXT NOT NULL,
     closed INTEGER NOT NULL DEFAULT 0,
     at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS browser_lease (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     holder_thread_id TEXT NOT NULL,
     task_id TEXT,
     since INTEGER NOT NULL,
     renewed_at INTEGER NOT NULL
   )`,
  `ALTER TABLE tasks ADD COLUMN labelled_sha TEXT`,
  `CREATE TABLE IF NOT EXISTS withdrawals (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     ticket_id TEXT NOT NULL,
     task_id TEXT NOT NULL,
     questions TEXT NOT NULL,
     reason TEXT NOT NULL,
     by TEXT NOT NULL,
     at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS jev_watch (
     id INTEGER PRIMARY KEY,
     task_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     asked_at INTEGER NOT NULL,
     model TEXT,
     latency_ms INTEGER,
     error TEXT,
     jev_kind TEXT,
     jev_kind_top REAL,
     jev_kind_margin REAL,
     jev_tier TEXT,
     jev_tier_top REAL,
     jev_tier_margin REAL,
     actual_kind TEXT,
     actual_tier TEXT,
     actual_at INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS jev_watch_task ON jev_watch (task_id)`,
  `CREATE TABLE IF NOT EXISTS model_routes (
     thread_id TEXT PRIMARY KEY,
     task_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     role TEXT NOT NULL,
     routed_at INTEGER NOT NULL,
     model TEXT,
     reason TEXT NOT NULL,
     probability REAL,
     jev_model TEXT,
     error TEXT
   )`,
  `ALTER TABLE tickets ADD COLUMN report_path TEXT`,
  `ALTER TABLE tickets ADD COLUMN report_title TEXT`,
  `ALTER TABLE tickets ADD COLUMN report_summary TEXT`,
];

export interface ModelRoute {
  threadId: string;
  taskId: string;
  projectId: string;
  role: string;
  routedAt: number;
  model: string | null;
  reason: string;
  probability: number | null;
  jevModel: string | null;
  error: string | null;
}

export type Stage = "research" | "build" | "pr" | "you" | "done";
export const STAGES: readonly Stage[] = ["research", "build", "pr", "you", "done"];
export type BuildState = "none" | "preparing" | "running" | "failed";

export interface Decision {
  question: string;
  decision: string;
}

export interface VerdictRecord {
  kind: string;
  reasons: string[];
  headSha: string | null;
  at: number;
}

/** What build() was last asked for, so the owner's Retry can ask again. */
export interface BuildRequest {
  touches: string[];
  branch: string | null;
  instructions: string;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  brief: string;
  stage: Stage;
  threadId: string | null;
  branch: string | null;
  baseRef: string | null;
  worktreePath: string | null;
  /** Why a worktree was kept at cleanup, or other worktree trouble; null when fine. */
  worktreeNote: string | null;
  buildState: BuildState;
  buildError: string | null;
  /** Build failures in a row; the task fixes them until BUILD_FAILURE_LIMIT. */
  buildFailures: number;
  buildRequest: BuildRequest | null;
  prNumber: number | null;
  prUrl: string | null;
  /** The last branch tip seen with commits ahead of the base; null until then. */
  headSha: string | null;
  verdict: VerdictRecord | null;
  verifiedSha: string | null;
  /**
   * The head the ai-tests label was last added on: never added twice on one
   * head. Always set by the store; optional so Task literals elsewhere need not change.
   */
  labelledSha?: string | null;
  decisions: Decision[];
  testList: string[];
  note: string | null;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface Ticket {
  id: string;
  taskId: string;
  /**
   * "questions": the owner answers. "review": the PR is proven; the owner tests
   * and merges. "report": a task's findings wait on the owner's review (report.ts).
   */
  kind: "questions" | "review" | "report";
  questions: string[];
  /** The structured form of each question, same order; empty on old tickets. */
  asks: Ask[];
  answers: string[] | null;
  status: "open" | "closed";
  createdAt: number;
  closedAt: number | null;
  /**
   * A report ticket's file, title and summary; null on every other kind.
   * Always set by the store; optional so Ticket literals elsewhere need not change.
   */
  report?: ReportRef | null;
}

/** A task's claims given back: by Patches (release_task) or automatically. */
export interface Release {
  paths: string[];
  reason: string;
  by: "patches" | "auto";
  closed: boolean;
  at: number;
}

/** Questions taken off the owner's Needs you with a reason (ask_sam withdraw; tickets.ts decides who may). */
export interface Withdrawal {
  ticketId: string;
  taskId: string;
  /** The withdrawn questions' text. */
  questions: string[];
  reason: string;
  by: "task" | "patches";
  at: number;
}

export interface Child {
  threadId: string;
  taskId: string;
  kind: "research" | "build";
  label: string;
  summary: string | null;
  createdAt: number;
}

/** The one agent allowed in the owner's Chrome right now (browser.ts decides who). */
export interface BrowserLease {
  holderThreadId: string;
  taskId: string | null;
  since: number;
  renewedAt: number;
}

export interface ProjectPrefs {
  projectId: string;
  color: string | null;
  hidden: boolean;
}

type Row = Record<string, unknown>;

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null =>
  typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : null;

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toTask(row: Row): Task {
  const stage = str(row.stage);
  const build = str(row.build_state);
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    title: String(row.title),
    brief: String(row.brief),
    stage: STAGES.includes(stage as Stage) ? (stage as Stage) : "research",
    threadId: str(row.thread_id),
    branch: str(row.branch),
    baseRef: str(row.base_ref),
    worktreePath: str(row.worktree_path),
    worktreeNote: str(row.worktree_note),
    buildState: (["none", "preparing", "running", "failed"] as const).includes(build as BuildState)
      ? (build as BuildState)
      : "none",
    buildError: str(row.build_error),
    buildFailures: num(row.build_failures) ?? 0,
    buildRequest: parseJson<BuildRequest | null>(row.build_request, null),
    prNumber: num(row.pr_number),
    prUrl: str(row.pr_url),
    headSha: str(row.head_sha),
    verdict: parseJson<VerdictRecord | null>(row.verdict, null),
    verifiedSha: str(row.verified_sha),
    labelledSha: str(row.labelled_sha),
    decisions: parseJson<Decision[]>(row.decisions, []),
    testList: parseJson<string[]>(row.test_list, []),
    note: str(row.note),
    createdAt: num(row.created_at) ?? 0,
    updatedAt: num(row.updated_at) ?? 0,
    closedAt: num(row.closed_at),
  };
}

function toTicket(row: Row): Ticket {
  const kind = row.kind === "review" || row.kind === "report" ? row.kind : "questions";
  const path = str(row.report_path);
  const title = str(row.report_title);
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    kind,
    questions: parseJson<string[]>(row.questions, []),
    asks: parseJson<Ask[]>(row.asks, []),
    answers: parseJson<string[] | null>(row.answers, null),
    status: row.status === "closed" ? "closed" : "open",
    createdAt: num(row.created_at) ?? 0,
    closedAt: num(row.closed_at),
    report: kind === "report" && path !== null && title !== null ? { path, title, summary: str(row.report_summary) } : null,
  };
}

function toChild(row: Row): Child {
  return {
    threadId: String(row.thread_id),
    taskId: String(row.task_id),
    kind: row.kind === "build" ? "build" : "research",
    label: String(row.label),
    summary: str(row.summary),
    createdAt: num(row.created_at) ?? 0,
  };
}

/** Columns a caller may patch on a task, mapped to their SQL names. */
const TASK_COLUMNS = {
  title: "title",
  stage: "stage",
  threadId: "thread_id",
  branch: "branch",
  baseRef: "base_ref",
  worktreePath: "worktree_path",
  worktreeNote: "worktree_note",
  buildState: "build_state",
  buildError: "build_error",
  buildFailures: "build_failures",
  buildRequest: "build_request",
  prNumber: "pr_number",
  prUrl: "pr_url",
  headSha: "head_sha",
  verdict: "verdict",
  verifiedSha: "verified_sha",
  labelledSha: "labelled_sha",
  decisions: "decisions",
  testList: "test_list",
  note: "note",
  closedAt: "closed_at",
} as const;
type TaskPatch = Partial<Pick<Task, keyof typeof TASK_COLUMNS>>;

const SIDEBAR_ADOPTED_KEY = "sidebar_adopted_at";

export function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 12)}`;
}

export class Store {
  constructor(
    private readonly db: SqlDb,
    private readonly now: () => number = Date.now,
  ) {}

  /** For tests and first-run setups that do not go through bb.storage.migrate. */
  static migrateInPlace(db: SqlDb) {
    for (const statement of MIGRATIONS) db.exec(statement);
  }

  private transactionDepth = 0;

  /**
   * Re-entrant: only the outermost call begins and commits. An inner call
   * (a store method that opens its own) just runs, and its error propagates
   * so the outermost rolls everything back.
   */
  transaction<T>(work: () => T): T {
    const outermost = this.transactionDepth === 0;
    this.transactionDepth += 1;
    try {
      if (!outermost) return work();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = work();
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      this.transactionDepth -= 1;
    }
  }

  // ------------------------------------------------------------------ meta
  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
    return row === undefined ? null : str(row.value);
  }
  /** Every meta row whose key starts with `prefix`, in key order. */
  metaWithPrefix(prefix: string): { key: string; value: string }[] {
    const rows = this.db
      .prepare("SELECT key, value FROM meta WHERE substr(key, 1, ?) = ? ORDER BY key")
      .all(prefix.length, prefix) as Row[];
    return rows.map((row) => ({ key: String(row.key), value: String(row.value) }));
  }
  setMeta(key: string, value: string | null) {
    if (value === null) this.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
    else {
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(key, value);
    }
  }

  /** Whether the sidebar was switched to our list once; after that it is the owner's. */
  sidebarAdopted(): boolean {
    return this.getMeta(SIDEBAR_ADOPTED_KEY) !== null;
  }
  markSidebarAdopted() {
    if (!this.sidebarAdopted()) this.setMeta(SIDEBAR_ADOPTED_KEY, String(this.now()));
  }

  // --------------------------------------------------------- project prefs
  projectPrefs(): ProjectPrefs[] {
    return (this.db.prepare("SELECT * FROM project_prefs").all() as Row[]).map((row) => ({
      projectId: String(row.project_id),
      color: str(row.color),
      hidden: num(row.hidden) === 1,
    }));
  }
  setProjectPrefs(projectId: string, patch: { color?: string | null; hidden?: boolean }) {
    const current = this.projectPrefs().find((prefs) => prefs.projectId === projectId);
    const color = patch.color !== undefined ? patch.color : (current?.color ?? null);
    const hidden = patch.hidden !== undefined ? patch.hidden : (current?.hidden ?? false);
    this.db
      .prepare(
        `INSERT INTO project_prefs (project_id, color, hidden) VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET color = excluded.color, hidden = excluded.hidden`,
      )
      .run(projectId, color, hidden ? 1 : 0);
  }

  // ----------------------------------------------------------------- tasks
  createTask(input: { projectId: string; title: string; brief: string }): Task {
    const at = this.now();
    const id = randomId("task");
    this.db
      .prepare(
        `INSERT INTO tasks (id, project_id, title, brief, stage, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'research', ?, ?)`,
      )
      .run(id, input.projectId, input.title, input.brief, at, at);
    return this.task(id) as Task;
  }

  task(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? null : toTask(row);
  }

  taskByThread(threadId: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE thread_id = ?").get(threadId) as Row | undefined;
    return row === undefined ? null : toTask(row);
  }

  /** Open tasks first by recency; closed tasks only when asked for. */
  tasks({ includeClosed }: { includeClosed: boolean }): Task[] {
    const sql = includeClosed
      ? "SELECT * FROM tasks ORDER BY updated_at DESC"
      : "SELECT * FROM tasks WHERE closed_at IS NULL ORDER BY updated_at DESC";
    return (this.db.prepare(sql).all() as Row[]).map(toTask);
  }

  updateTask(id: string, patch: TaskPatch): Task {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(TASK_COLUMNS) as [keyof TaskPatch, string][]) {
      if (!(key in patch)) continue;
      const value = patch[key];
      sets.push(`${column} = ?`);
      values.push(
        key === "decisions" || key === "testList" || key === "verdict" || key === "buildRequest"
          ? value === null
            ? null
            : JSON.stringify(value)
          : (value ?? null),
      );
    }
    sets.push("updated_at = ?");
    values.push(this.now());
    this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    const task = this.task(id);
    if (task === null) throw new Error(`No task ${id}`);
    return task;
  }

  /** Close a task: it leaves the board and gives its claims and build slot back. */
  closeTask(id: string, note: string) {
    this.releaseTask(id, { reason: note, by: "auto", close: true });
  }

  /**
   * Give a task's claims and build slot back, recorded with its reason; with
   * `close`, also close the task and its tickets. Returns the released paths.
   */
  releaseTask(id: string, { reason, by, close }: { reason: string; by: Release["by"]; close: boolean }): string[] {
    return this.transaction(() => {
      const task = this.task(id);
      if (task === null) throw new Error(`No task ${id}`);
      const paths = this.claimsFor(id);
      if (close) this.recordJevActualOnClose(id);
      this.releaseClaims(id);
      this.db
        .prepare("INSERT INTO releases (task_id, paths, reason, by, closed, at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, JSON.stringify(paths), reason, by, close ? 1 : 0, this.now());
      const inFlight = task.buildState === "preparing" || task.buildState === "running";
      this.updateTask(id, {
        ...(inFlight ? { buildState: "none" as const } : {}),
        ...(close ? { stage: "done" as const, closedAt: this.now(), note: reason } : {}),
      });
      if (close) {
        this.db
          .prepare("UPDATE tickets SET status = 'closed', closed_at = ? WHERE task_id = ? AND status = 'open'")
          .run(this.now(), id);
        this.setMeta(reportKey(id), null);
      }
      return paths;
    });
  }

  releases(taskId: string): Release[] {
    return (this.db.prepare("SELECT * FROM releases WHERE task_id = ? ORDER BY id").all(taskId) as Row[]).map(
      (row) => ({
        paths: parseJson<string[]>(row.paths, []),
        reason: String(row.reason),
        by: row.by === "patches" ? "patches" : "auto",
        closed: num(row.closed) === 1,
        at: num(row.at) ?? 0,
      }),
    );
  }

  // ---------------------------------------------------------------- claims
  claims(): Claim[] {
    return (this.db.prepare("SELECT * FROM claims").all() as Row[]).map((row) => ({
      taskId: String(row.task_id),
      projectId: String(row.project_id),
      path: String(row.path),
    }));
  }
  claimsFor(taskId: string): string[] {
    return (this.db.prepare("SELECT path FROM claims WHERE task_id = ? ORDER BY path").all(taskId) as Row[]).map(
      (row) => String(row.path),
    );
  }
  addClaims(taskId: string, projectId: string, paths: readonly string[]) {
    const insert = this.db.prepare(
      "INSERT INTO claims (task_id, project_id, path) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
    );
    for (const path of paths) insert.run(taskId, projectId, path);
  }
  releaseClaims(taskId: string) {
    this.db.prepare("DELETE FROM claims WHERE task_id = ?").run(taskId);
  }

  // --------------------------------------------------------------- tickets
  tickets({ status }: { status: "open" | "all" }): Ticket[] {
    const sql =
      status === "open"
        ? "SELECT * FROM tickets WHERE status = 'open' ORDER BY created_at"
        : "SELECT * FROM tickets ORDER BY created_at";
    return (this.db.prepare(sql).all() as Row[]).map(toTicket);
  }
  ticket(id: string): Ticket | null {
    const row = this.db.prepare("SELECT * FROM tickets WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? null : toTicket(row);
  }
  openTicket(taskId: string, kind: Ticket["kind"]): Ticket | null {
    const row = this.db
      .prepare("SELECT * FROM tickets WHERE task_id = ? AND kind = ? AND status = 'open'")
      .get(taskId, kind) as Row | undefined;
    return row === undefined ? null : toTicket(row);
  }

  /**
   * One open questions ticket per task: new asks join it, or with `replace`
   * supersede its questions (same ticket id; the earlier asks are withdrawn).
   * Refuses past `max` open questions — the rest are decisions the task
   * should make.
   */
  addQuestions(taskId: string, asks: readonly Ask[], max: number, replace = false): Ticket {
    return this.transaction(() => {
      const open = this.openTicket(taskId, "questions");
      const questions = replace ? [] : [...(open?.questions ?? [])];
      const structured = replace ? [] : [...(open?.asks ?? [])];
      for (const ask of asks) {
        const line = askLine(ask);
        if (questions.includes(line)) continue;
        questions.push(line);
        structured.push(ask);
      }
      if (questions.length > max) {
        throw new Error(
          `That makes ${questions.length} open questions for this task; the limit is ${max}. Decide the ones the repo or plain judgement can settle and record them as decisions.`,
        );
      }
      if (open === null) {
        const id = randomId("tkt");
        this.db
          .prepare(
            "INSERT INTO tickets (id, task_id, kind, questions, asks, status, created_at) VALUES (?, ?, 'questions', ?, ?, 'open', ?)",
          )
          .run(id, taskId, JSON.stringify(questions), JSON.stringify(structured), this.now());
        return this.ticket(id) as Ticket;
      }
      this.db
        .prepare("UPDATE tickets SET questions = ?, asks = ? WHERE id = ?")
        .run(JSON.stringify(questions), JSON.stringify(structured), open.id);
      return this.ticket(open.id) as Ticket;
    });
  }

  /** The review hand-off: at most one open per task, replaced on re-validation. */
  openReview(taskId: string): Ticket {
    return this.transaction(() => {
      const open = this.openTicket(taskId, "review");
      if (open !== null) return open;
      const id = randomId("tkt");
      this.db
        .prepare(
          "INSERT INTO tickets (id, task_id, kind, questions, status, created_at) VALUES (?, ?, 'review', '[]', 'open', ?)",
        )
        .run(id, taskId, this.now());
      return this.ticket(id) as Ticket;
    });
  }

  /**
   * A task's report for the owner: at most one open report ticket per task.
   * Submitting again replaces its path, title and summary on the same ticket;
   * it never stacks.
   */
  submitReport(taskId: string, report: ReportRef): { ticket: Ticket; replaced: boolean } {
    return this.transaction(() => {
      const open = this.openTicket(taskId, "report");
      if (open !== null) {
        this.db
          .prepare("UPDATE tickets SET report_path = ?, report_title = ?, report_summary = ? WHERE id = ?")
          .run(report.path, report.title, report.summary, open.id);
        return { ticket: this.ticket(open.id) as Ticket, replaced: true };
      }
      const id = randomId("tkt");
      this.db
        .prepare(
          `INSERT INTO tickets (id, task_id, kind, questions, status, created_at, report_path, report_title, report_summary)
           VALUES (?, ?, 'report', '[]', 'open', ?, ?, ?, ?)`,
        )
        .run(id, taskId, this.now(), report.path, report.title, report.summary);
      return { ticket: this.ticket(id) as Ticket, replaced: false };
    });
  }

  /** The task's newest report ticket, open or closed (Completed's Report link), or null. */
  latestReport(taskId: string): Ticket | null {
    const row = this.db
      .prepare("SELECT * FROM tickets WHERE task_id = ? AND kind = 'report' ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .get(taskId) as Row | undefined;
    return row === undefined ? null : toTicket(row);
  }

  /** Void the task's open review hand-off; returns it, or null when there was none. */
  closeReview(taskId: string): Ticket | null {
    return this.transaction(() => {
      const open = this.openTicket(taskId, "review");
      if (open === null) return null;
      this.closeTicket(open.id, null);
      return open;
    });
  }

  /** Withdraw a whole open ticket: closed with no answers, its questions recorded with the reason. */
  withdrawTicket(id: string, { reason, by }: { reason: string; by: Withdrawal["by"] }): Ticket {
    return this.transaction(() => {
      const ticket = this.ticket(id);
      if (ticket === null || ticket.status !== "open") throw new Error(`${id} is not an open ticket.`);
      this.closeTicket(id, null);
      // A report has no questions: the withdrawal records which report went.
      const what = ticket.kind === "report" && ticket.report ? [`Report: ${ticket.report.title}`] : ticket.questions;
      this.recordWithdrawal(ticket, what, reason, by);
      return this.ticket(id) as Ticket;
    });
  }

  /**
   * Withdraw some questions (1-based) of an open questions ticket, with their
   * asks; the ticket closes, unanswered, when none is left.
   */
  withdrawQuestions(id: string, numbers: readonly number[], { reason, by }: { reason: string; by: Withdrawal["by"] }): Ticket {
    return this.transaction(() => {
      const ticket = this.ticket(id);
      if (ticket === null || ticket.status !== "open") throw new Error(`${id} is not an open ticket.`);
      const gone = (_: unknown, index: number) => numbers.includes(index + 1);
      const removed = ticket.questions.filter(gone);
      if (removed.length !== new Set(numbers).size) throw new Error(`${id} has no question ${numbers.join(", ")}.`);
      const questions = ticket.questions.filter((q, index) => !gone(q, index));
      const asks = ticket.asks.length === ticket.questions.length ? ticket.asks.filter((a, index) => !gone(a, index)) : [];
      this.db
        .prepare("UPDATE tickets SET questions = ?, asks = ? WHERE id = ?")
        .run(JSON.stringify(questions), JSON.stringify(asks), id);
      if (questions.length === 0) this.closeTicket(id, null);
      this.recordWithdrawal(ticket, removed, reason, by);
      return this.ticket(id) as Ticket;
    });
  }

  private recordWithdrawal(ticket: Ticket, questions: readonly string[], reason: string, by: Withdrawal["by"]) {
    this.db
      .prepare("INSERT INTO withdrawals (ticket_id, task_id, questions, reason, by, at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(ticket.id, ticket.taskId, JSON.stringify(questions), reason, by, this.now());
  }

  withdrawals(taskId: string): Withdrawal[] {
    return (this.db.prepare("SELECT * FROM withdrawals WHERE task_id = ? ORDER BY id").all(taskId) as Row[]).map(
      (row) => ({
        ticketId: String(row.ticket_id),
        taskId: String(row.task_id),
        questions: parseJson<string[]>(row.questions, []),
        reason: String(row.reason),
        by: row.by === "patches" ? "patches" : "task",
        at: num(row.at) ?? 0,
      }),
    );
  }

  closeTicket(id: string, answers: readonly string[] | null) {
    this.db
      .prepare("UPDATE tickets SET status = 'closed', answers = ?, closed_at = ? WHERE id = ?")
      .run(answers === null ? null : JSON.stringify(answers), this.now(), id);
  }

  // ------------------------------------------------------------ jev watch
  /** One watch-only ask of Jev (jevwatch.ts); read only by the board's report. */
  recordJevAsk(row: { taskId: string; projectId: string; askedAt: number } & JevAskRecord) {
    this.db
      .prepare(
        `INSERT INTO jev_watch (task_id, project_id, asked_at, model, latency_ms, error,
           jev_kind, jev_kind_top, jev_kind_margin, jev_tier, jev_tier_top, jev_tier_margin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.taskId, row.projectId, row.askedAt, row.model, row.latencyMs, row.error,
        row.jevKind, row.jevKindTop, row.jevKindMargin, row.jevTier, row.jevTierTop, row.jevTierMargin,
      );
  }

  /** What the task turned out to be, on its Jev rows (none: nothing happens). */
  recordJevActual(taskId: string, labels: { kind: string; tier: string }) {
    this.db
      .prepare("UPDATE jev_watch SET actual_kind = ?, actual_tier = ?, actual_at = ? WHERE task_id = ?")
      .run(labels.kind, labels.tier, this.now(), taskId);
  }

  /** A closing task's facts: builds started, failures, questions to the owner, every file it ever claimed. */
  jevFacts(taskId: string): OutcomeFacts {
    const task = this.task(taskId);
    const files = new Set(this.claimsFor(taskId));
    for (const release of this.releases(taskId)) for (const path of release.paths) files.add(path);
    const asks = (this.db.prepare("SELECT * FROM tickets WHERE task_id = ? AND kind = 'questions'").all(taskId) as Row[])
      .map(toTicket)
      .reduce((sum, ticket) => sum + ticket.questions.length, 0);
    const builds = num(
      (this.db.prepare("SELECT COUNT(*) AS n FROM children WHERE task_id = ? AND kind = 'build'").get(taskId) as Row).n,
    );
    return { builds: builds ?? 0, buildFailures: task?.buildFailures ?? 0, asksToSam: asks, filesTouched: files.size };
  }

  private recordJevActualOnClose(taskId: string) {
    // Bookkeeping only: it must never stop a task from closing.
    try {
      const asked = this.db.prepare("SELECT 1 FROM jev_watch WHERE task_id = ? LIMIT 1").get(taskId);
      if (asked !== undefined) this.recordJevActual(taskId, actualOutcome(this.jevFacts(taskId)));
    } catch {
      // A missing table (a dossier mid-migration) or a bad row loses one comparison, nothing else.
    }
  }

  listJevWatch(projectId?: string): JevWatchRow[] {
    const rows = (
      projectId === undefined
        ? this.db.prepare("SELECT * FROM jev_watch ORDER BY id").all()
        : this.db.prepare("SELECT * FROM jev_watch WHERE project_id = ? ORDER BY id").all(projectId)
    ) as Row[];
    return rows.map((row) => ({
      taskId: String(row.task_id),
      projectId: String(row.project_id),
      askedAt: num(row.asked_at) ?? 0,
      model: str(row.model),
      latencyMs: num(row.latency_ms),
      error: str(row.error),
      jevKind: str(row.jev_kind),
      jevKindTop: num(row.jev_kind_top),
      jevKindMargin: num(row.jev_kind_margin),
      jevTier: str(row.jev_tier),
      jevTierTop: num(row.jev_tier_top),
      jevTierMargin: num(row.jev_tier_margin),
      actualKind: str(row.actual_kind),
      actualTier: str(row.actual_tier),
      actualAt: num(row.actual_at),
    }));
  }

  // ------------------------------------------------------------ model routes
  /** How one agent's model was picked (modelroute.ts): one row per thread. */
  recordModelRoute(row: { threadId: string; taskId: string; projectId: string; role: string; routedAt: number } & RouteRecord) {
    this.db
      .prepare(
        `INSERT INTO model_routes (thread_id, task_id, project_id, role, routed_at, model, reason, probability, jev_model, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET routed_at = excluded.routed_at, model = excluded.model, reason = excluded.reason,
           probability = excluded.probability, jev_model = excluded.jev_model, error = excluded.error`,
      )
      .run(row.threadId, row.taskId, row.projectId, row.role, row.routedAt, row.model, row.reason, row.probability, row.jevModel, row.error);
  }

  /** Every recorded route, or those since `since`; newest last. */
  modelRoutes(since?: number): ModelRoute[] {
    const rows = (
      since === undefined
        ? this.db.prepare("SELECT * FROM model_routes ORDER BY routed_at").all()
        : this.db.prepare("SELECT * FROM model_routes WHERE routed_at >= ? ORDER BY routed_at").all(since)
    ) as Row[];
    return rows.map((row) => ({
      threadId: String(row.thread_id),
      taskId: String(row.task_id),
      projectId: String(row.project_id),
      role: String(row.role),
      routedAt: num(row.routed_at) ?? 0,
      model: str(row.model),
      reason: String(row.reason),
      probability: num(row.probability),
      jevModel: str(row.jev_model),
      error: str(row.error),
    }));
  }

  // -------------------------------------------------------------- children
  addChild(child: Omit<Child, "createdAt" | "summary">) {
    this.db
      .prepare(
        "INSERT INTO children (thread_id, task_id, kind, label, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      )
      .run(child.threadId, child.taskId, child.kind, child.label, this.now());
  }
  child(threadId: string): Child | null {
    const row = this.db.prepare("SELECT * FROM children WHERE thread_id = ?").get(threadId) as Row | undefined;
    return row === undefined ? null : toChild(row);
  }
  children(): Child[] {
    return (this.db.prepare("SELECT * FROM children ORDER BY created_at").all() as Row[]).map(toChild);
  }
  setChildSummary(threadId: string, summary: string) {
    this.db.prepare("UPDATE children SET summary = ? WHERE thread_id = ?").run(summary, threadId);
  }

  // --------------------------------------------------------- browser lease
  browserLease(): BrowserLease | null {
    const row = this.db.prepare("SELECT * FROM browser_lease WHERE id = 1").get() as Row | undefined;
    if (row === undefined) return null;
    return {
      holderThreadId: String(row.holder_thread_id),
      taskId: str(row.task_id),
      since: num(row.since) ?? 0,
      renewedAt: num(row.renewed_at) ?? 0,
    };
  }
  /** Record the holder (browser.ts leaseDecision granted it): a renewal keeps `since`. */
  acquireBrowserLease(holderThreadId: string, taskId: string | null): BrowserLease {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO browser_lease (id, holder_thread_id, task_id, since, renewed_at) VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           since = CASE WHEN holder_thread_id = excluded.holder_thread_id THEN since ELSE excluded.since END,
           holder_thread_id = excluded.holder_thread_id,
           task_id = excluded.task_id,
           renewed_at = excluded.renewed_at`,
      )
      .run(holderThreadId, taskId, now, now);
    return this.browserLease() as BrowserLease;
  }
  /** Free the lease if this thread holds it; true when it did. */
  releaseBrowserLease(holderThreadId: string): boolean {
    const held = this.browserLease()?.holderThreadId === holderThreadId;
    if (held) this.db.prepare("DELETE FROM browser_lease WHERE id = 1").run();
    return held;
  }
}
