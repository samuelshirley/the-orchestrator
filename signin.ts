// Claude signed out, and coming back after the owner signs in. Pure; signin.test.ts
// pins it. server.ts records each failed turn, holds new ones, and acts on
// what this decides on the liveness beat. The usage limit's design (usage.ts),
// with one difference: no clock brings it back, only the owner can.
//
// Where the facts come from (checked on the host, not guessed):
// - The failure: bb's turn.failed carries errorInfo.category ("unauthorized"
//   for an auth failure) and no text; the text ("Failed to authenticate: OAuth
//   session expired and could not be refreshed") is the thread's provider/error
//   or system/error event, and thread.failed's `error`. Both are read.
// - Back again: no event says so, and `claude auth status` can say loggedIn
//   while the refresh fails. What proves it is a Claude turn that completed, or
//   a usage reading with status ok (provider-usage.v1 answers "unauthenticated"
//   or "expired" otherwise, which parseUsage reads as null), either one
//   measured after the latest failure.

import { owner } from "./owner.js";
import type { HitRole, PausedStart, StartKind } from "./usage.js";

/** The command only the owner can run (`claude auth --help`: login, logout, status). */
export const SIGN_IN_COMMAND = "claude auth login";
/** While signed out, a fresh usage reading (refresh: true) is asked for at most this often. */
export const SIGNIN_REFRESH_MS = 60_000;
/** After our retry, how long its turn gets to start (or fail again) before an errored thread counts as failed on something else. */
export const RETRY_GRACE_MS = 60_000;
/** The reason on the retry row The Orchestrator queues once sign-in is back. */
export const SIGNIN_RETRY_REASON = "The Orchestrator: Claude signed in again";
/** What a held turn's row says. */
export const signinHoldReason = () => `Claude is signed out: waiting for ${owner()} to sign in.`;

/** The part of a failed turn this reads: bb's classification, and the error text when the server found one. */
export interface SignInFailure {
  errorInfo: { category?: string | null } | null;
  text: string | null;
}

const SIGNED_OUT_TEXT =
  /failed to authenticate|oauth session expired|oauth token has expired|authentication_error|please run \/login|invalid api key/i;

/**
 * Whether a failed turn is the Claude sign-in error. A usage limit is never
 * one, whatever its text says: it resets on a clock (usage.ts).
 */
export function signedOutOf(failure: SignInFailure): boolean {
  const category = failure.errorInfo?.category ?? null;
  if (category === "rate-limit") return false;
  if (category === "unauthorized") return true;
  return failure.text !== null && SIGNED_OUT_TEXT.test(failure.text);
}

/** One of our agents whose turn failed because Claude is signed out. Kept in the dossier until it is back. */
export interface SignedOut {
  threadId: string;
  role: HitRole;
  taskId: string | null;
  /** The failed turn's request id: what threads.retry takes. Null when only thread.failed said so (the latest turn is retried). */
  requestId: string | null;
  /** Its first sign-in failure. */
  since: number;
  /** Its latest sign-in failure. */
  at: number;
  /** When The Orchestrator retried it itself; null until then. At most once. */
  retriedAt: number | null;
}

/** Record a failure; a thread failing again keeps its first `since` and its one retry. */
export function recordSignedOut(
  records: readonly SignedOut[],
  failure: Omit<SignedOut, "since" | "at" | "retriedAt">,
  now: number,
): SignedOut[] {
  const previous = records.find((entry) => entry.threadId === failure.threadId);
  const next: SignedOut = {
    ...failure,
    requestId: failure.requestId ?? previous?.requestId ?? null,
    since: previous?.since ?? now,
    at: now,
    retriedAt: previous?.retriedAt ?? null,
  };
  return [...records.filter((entry) => entry.threadId !== failure.threadId), next];
}

/** Still failed on sign-in: never retried, or failed on it again after the retry. */
export function isWaiting(record: SignedOut): boolean {
  return record.retriedAt === null || record.at > record.retriedAt;
}

/** Since when Claude is signed out: the first failure still waiting; null when signed in. */
export function signedOutSince(records: readonly SignedOut[]): number | null {
  const waiting = records.filter(isWaiting);
  return waiting.length === 0 ? null : Math.min(...waiting.map((entry) => entry.since));
}

export function isSignedOut(records: readonly SignedOut[]): boolean {
  return signedOutSince(records) !== null;
}

/** Whether to force a fresh usage reading now: only while signed out, at most once a minute. */
export function wantsSignInRefresh(args: { records: readonly SignedOut[]; lastRefreshAt: number | null; now: number }): boolean {
  if (!isSignedOut(args.records)) return false;
  return args.lastRefreshAt === null || args.now - args.lastRefreshAt >= SIGNIN_REFRESH_MS;
}

/**
 * Whether sign-in works again. Either signal is enough, and each must be
 * NEWER than the latest sign-in failure: a turn that completed before the
 * session expired, or a usage reading cached from before, proves nothing.
 */
export function signInBack(args: {
  records: readonly SignedOut[];
  /** When a Claude agent turn last completed successfully; null when none was seen. */
  turnOkAt: number | null;
  /** The observedAt of the last usage reading with status ok; null when none. */
  usageOkAt: number | null;
}): boolean {
  const waiting = args.records.filter(isWaiting);
  if (waiting.length === 0) return false;
  const latest = Math.max(...waiting.map((entry) => entry.at));
  return (args.turnOkAt !== null && args.turnOkAt > latest) || (args.usageOkAt !== null && args.usageOkAt > latest);
}

export type SignInStep =
  /** Not yet: still signed out, or a retry is queued or just sent. */
  | { kind: "wait" }
  /** It ran again, is gone, or failed on something else: forget the record. */
  | { kind: "forget" }
  /** Signed in again, still failed, never retried: retry its turn, once. */
  | { kind: "retry" }
  /** Its one retry failed on sign-in too: forget it and leave it in error, where liveness shows it. */
  | { kind: "leave" };

/**
 * One record's next step. `status` is the thread's host status now;
 * `retryQueued` whether bb holds a retry row for it; `back` is signInBack.
 * Never retries while a row exists, and never twice: no duplicate turns.
 */
export function signInStep(args: {
  record: SignedOut;
  status: "starting" | "active" | "stopping" | "pending" | "idle" | "error" | "gone";
  retryQueued: boolean;
  back: boolean;
  now: number;
}): SignInStep {
  const { record, status, retryQueued, back, now } = args;
  if (status === "gone") return { kind: "forget" };
  if (retryQueued || status === "pending") return { kind: "wait" };
  if (status !== "error") return { kind: "forget" };
  if (!isWaiting(record)) {
    // Retried, and in error with nothing queued: the retry has not started
    // yet, or it failed on something that is not sign-in.
    return record.retriedAt !== null && now - record.retriedAt < RETRY_GRACE_MS ? { kind: "wait" } : { kind: "forget" };
  }
  if (!back) return { kind: "wait" };
  return record.retriedAt === null ? { kind: "retry" } : { kind: "leave" };
}

/**
 * Why a new agent turn waits; null when it may run. The owner's own messages are
 * never held (the memory guard's rule): they may be the one signing in.
 */
export function signInHold(records: readonly SignedOut[], sentBySam: boolean): string | null {
  return !sentBySam && isSignedOut(records) ? signinHoldReason() : null;
}

/** Why a new build or research must not start now; null when it may. */
export function signInStartRefusal(records: readonly SignedOut[], kind: StartKind): string | null {
  if (!isSignedOut(records)) return null;
  const what = kind === "build" ? "No new build" : "No new research";
  return `${what}: Claude is signed out; it starts once ${owner()} signs in. End your pass saying what waits.`;
}

/** What a paused task hears when sign-in works again. */
export function signInWakeMessage(entries: readonly PausedStart[]): string {
  const kinds = [...new Set(entries.map((entry) => entry.kind))].join(" and ");
  return `[The Orchestrator] ${entries[0]?.taskId ?? "task"}: Claude is signed in again. The ${kinds} that was paused for it may start now: carry on with it.`;
}

/** Why Restart must not run on a thread waiting for sign-in; null when it may. */
export function signInRestartRefusal(records: readonly SignedOut[], threadId: string): string | null {
  const record = records.find((entry) => entry.threadId === threadId);
  if (record === undefined || !isWaiting(record)) return null;
  return `Claude is signed out, so Restart would fail the same way. Run \`${SIGN_IN_COMMAND}\` in a terminal; its turn restarts on its own once you are signed in.`;
}

/** The board's one item, however many threads failed; null when signed in. */
export interface SignedOutView {
  since: number;
  /** Agents whose turn failed on sign-in and is waiting to be retried. */
  waiting: number;
  /** The latest sign-in failure still waiting: what a dismissed popup is compared with. */
  latest: number;
  command: string;
}

export function signedOutView(records: readonly SignedOut[]): SignedOutView | null {
  const since = signedOutSince(records);
  if (since === null) return null;
  const waiting = records.filter(isWaiting);
  return { since, waiting: waiting.length, latest: Math.max(...waiting.map((entry) => entry.at)), command: SIGN_IN_COMMAND };
}

const waitingWords = (view: SignedOutView) =>
  `${view.waiting === 1 ? "1 agent is" : `${view.waiting} agents are`} waiting and new turns are held.`;

/** The Needs you item's words. Reason "account": only the owner can sign in. */
export function signedOutItem(view: SignedOutView): { title: string; body: string; command: string; reason: "account" } {
  return {
    title: "Claude is signed out",
    body: `${waitingWords(view)} Run this in a terminal and sign in; they restart on their own once you are signed in.`,
    command: view.command,
    reason: "account",
  };
}

/** The button on the popup and on the Needs you item. */
export const SIGN_IN_BUTTON = "Sign in with Claude";

/**
 * Whether the sign-in popup shows. Never when signed in, so it clears itself.
 * `dismissedAt` is the view's `latest` that was on screen when it was
 * dismissed (not a wall clock); only a NEWER failure brings it back.
 */
export function signInPopupOpen(view: SignedOutView | null, dismissedAt: number | null): boolean {
  if (view === null) return false;
  return dismissedAt === null || view.latest > dismissedAt;
}

/** The popup's words. No account, email or name: the same on any install. */
export function signInPopup(view: SignedOutView): {
  title: string;
  body: string;
  button: string;
  dismiss: string;
  fallback: string;
  command: string;
  started: string;
  failed: string;
} {
  return {
    title: "Claude is signed out",
    body: `${waitingWords(view)} Sign in and they restart on their own.`,
    button: SIGN_IN_BUTTON,
    dismiss: "Not now",
    fallback: "Or run this in a terminal:",
    command: view.command,
    started: "Finish signing in in the browser tab that opened. Agents restart on their own once you are signed in.",
    failed: "Run the command in a terminal instead.",
  };
}

/** The host's sign-in: `claude auth login`, as argv after the binary. */
export const SIGN_IN_ARGS: readonly string[] = SIGN_IN_COMMAND.split(" ").slice(1);
/** A sign-in nobody finished is stopped after this long. */
export const SIGN_IN_TIMEOUT_MS = 10 * 60_000;

/**
 * Where the host looks for `claude`, in order: its own PATH, then the usual
 * install dirs (the native installer's ~/.local/bin, Homebrew, npm global),
 * since the host worker's PATH may be minimal. Nothing names a user.
 */
export function signInPathDirs(pathEnv: string | undefined, home: string): string[] {
  const own = (pathEnv ?? "").split(":").filter((dir) => dir.startsWith("/"));
  const usual = [".local/bin", ".claude/local", ".npm-global/bin"].map((dir) => `${home.replace(/\/+$/, "")}/${dir}`);
  return [...new Set([...own, ...usual, "/opt/homebrew/bin", "/usr/local/bin"].map((dir) => dir.replace(/(.)\/+$/, "$1")))];
}

/** A spawn failure in plain words; never the process's output. */
export function signInSpawnError(code: string | null | undefined): string {
  if (code === "ENOENT") return "Could not find the `claude` command.";
  if (code === "EACCES") return "The `claude` command could not be run (permission denied).";
  return `Could not start \`${SIGN_IN_COMMAND}\`${code ? ` (${code})` : ""}.`;
}

/** task_status's line while signed out; null when signed in. */
export function signInStatusLine(records: readonly SignedOut[]): string | null {
  const view = signedOutView(records);
  if (view === null) return null;
  return `Claude is signed out: ${view.waiting} agent turn${view.waiting === 1 ? "" : "s"} failed on it and wait for ${owner()} to run \`${view.command}\`. New turns are held and no build or research starts until then; nothing counts as a failure.`;
}
