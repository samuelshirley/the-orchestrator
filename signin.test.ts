import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RETRY_GRACE_MS,
  signinHoldReason,
  SIGNIN_REFRESH_MS,
  SIGN_IN_ARGS,
  SIGN_IN_BUTTON,
  SIGN_IN_COMMAND,
  SIGN_IN_TIMEOUT_MS,
  isSignedOut,
  isWaiting,
  recordSignedOut,
  signInBack,
  signInHold,
  signInPathDirs,
  signInPopup,
  signInPopupOpen,
  signInSpawnError,
  signInRestartRefusal,
  signInStartRefusal,
  signInStatusLine,
  signInStep,
  signInWakeMessage,
  signedOutItem,
  signedOutOf,
  signedOutSince,
  signedOutView,
  wantsSignInRefresh,
  type SignedOut,
  type SignedOutView,
} from "./signin";
import { parseUsage } from "./usage";
import { setOwner } from "./owner";

// The name is whoever runs it (owner.ts): a neutral one here, the fallback after.
beforeEach(() => setOwner("Alex"));
afterEach(() => setOwner(null));

const NOW = Date.parse("2026-09-30T08:00:00Z");
const MIN = 60_000;

const record = (over: Partial<SignedOut> = {}): SignedOut => ({
  threadId: "thr_a",
  role: "task",
  taskId: "task_1",
  requestId: "req_1",
  since: NOW,
  at: NOW,
  retriedAt: null,
  ...over,
});

describe("signedOutOf", () => {
  it("reads bb's auth category without any text", () => {
    expect(signedOutOf({ errorInfo: { category: "unauthorized" }, text: null })).toBe(true);
  });

  it.each([
    "Provider error: Failed to authenticate: OAuth session expired and could not be refreshed",
    "oauth session expired",
    "OAuth token has expired",
    '{"type":"error","error":{"type":"authentication_error"}}',
    "Please run /login",
    "Invalid API key · fix external API key",
  ])("matches the text %s, whatever the case and category", (text) => {
    expect(signedOutOf({ errorInfo: null, text })).toBe(true);
    expect(signedOutOf({ errorInfo: { category: "unknown" }, text: text.toUpperCase() })).toBe(true);
  });

  it("is never a usage limit, even when its text reads like sign-in", () => {
    expect(signedOutOf({ errorInfo: { category: "rate-limit" }, text: "Rate limited" })).toBe(false);
    expect(signedOutOf({ errorInfo: { category: "rate-limit" }, text: "Failed to authenticate" })).toBe(false);
  });

  it("is not an ordinary error, or one with nothing to read", () => {
    expect(signedOutOf({ errorInfo: { category: "overloaded" }, text: "Provider overloaded" })).toBe(false);
    expect(signedOutOf({ errorInfo: { category: "internal" }, text: "Provisioning thread failed: workspace_busy" })).toBe(false);
    expect(signedOutOf({ errorInfo: null, text: null })).toBe(false);
  });
});

describe("recordSignedOut and the state", () => {
  it("keeps one record per thread, with its first since and its one retry", () => {
    const first = recordSignedOut([], { threadId: "thr_a", role: "build", taskId: "task_1", requestId: "req_1" }, NOW);
    expect(first).toEqual([record({ role: "build" })]);
    const retried = first.map((entry) => ({ ...entry, retriedAt: NOW + MIN }));
    const again = recordSignedOut(retried, { threadId: "thr_a", role: "build", taskId: "task_1", requestId: "req_2" }, NOW + 2 * MIN);
    expect(again).toEqual([record({ role: "build", requestId: "req_2", at: NOW + 2 * MIN, retriedAt: NOW + MIN })]);
    const other = recordSignedOut(again, { threadId: "thr_b", role: "chat", taskId: null, requestId: null }, NOW + 3 * MIN);
    expect(other.map((entry) => entry.threadId)).toEqual(["thr_a", "thr_b"]);
  });

  it("keeps the request id when only thread.failed reports the next failure", () => {
    const next = recordSignedOut([record()], { threadId: "thr_a", role: "task", taskId: "task_1", requestId: null }, NOW + MIN);
    expect(next[0]?.requestId).toBe("req_1");
  });

  it("is signed out from the first failure while any record waits", () => {
    expect(signedOutSince([])).toBeNull();
    expect(isSignedOut([])).toBe(false);
    const records = [record({ threadId: "thr_b", since: NOW + MIN, at: NOW + MIN }), record()];
    expect(signedOutSince(records)).toBe(NOW);
    // Retried and not failed since: no longer waiting.
    expect(isWaiting(record({ retriedAt: NOW + MIN }))).toBe(false);
    expect(isSignedOut([record({ retriedAt: NOW + MIN })])).toBe(false);
    // Failed on sign-in again after the retry: signed out again.
    expect(isSignedOut([record({ retriedAt: NOW + MIN, at: NOW + 2 * MIN })])).toBe(true);
  });
});

describe("signInBack", () => {
  const records = [record(), record({ threadId: "thr_b", at: NOW + 5 * MIN })];

  it("needs a signal", () => {
    expect(signInBack({ records, turnOkAt: null, usageOkAt: null })).toBe(false);
  });

  it("takes either signal, only when newer than the latest failure", () => {
    expect(signInBack({ records, turnOkAt: NOW + 6 * MIN, usageOkAt: null })).toBe(true);
    expect(signInBack({ records, turnOkAt: null, usageOkAt: NOW + 6 * MIN })).toBe(true);
    // Newer than the first failure but not the latest, or at the same instant: proves nothing.
    expect(signInBack({ records, turnOkAt: NOW + 2 * MIN, usageOkAt: NOW + 4 * MIN })).toBe(false);
    expect(signInBack({ records, turnOkAt: NOW + 5 * MIN, usageOkAt: NOW + 5 * MIN })).toBe(false);
  });

  it("is never back when nothing waits", () => {
    expect(signInBack({ records: [], turnOkAt: NOW, usageOkAt: NOW })).toBe(false);
    expect(signInBack({ records: [record({ retriedAt: NOW + MIN })], turnOkAt: NOW + 2 * MIN, usageOkAt: null })).toBe(false);
  });

  it("the usage answers a signed-out provider gives are no reading", () => {
    expect(parseUsage({ observedAt: NOW, usage: { status: "unauthenticated" } })).toBeNull();
    expect(parseUsage({ observedAt: NOW, usage: { status: "expired" } })).toBeNull();
    expect(parseUsage({ observedAt: NOW, usage: { status: "error", message: "401" } })).toBeNull();
  });

  it("forces a usage refresh only while signed out, at most once a minute", () => {
    expect(wantsSignInRefresh({ records: [], lastRefreshAt: null, now: NOW })).toBe(false);
    expect(wantsSignInRefresh({ records: [record()], lastRefreshAt: null, now: NOW })).toBe(true);
    expect(wantsSignInRefresh({ records: [record()], lastRefreshAt: NOW, now: NOW + SIGNIN_REFRESH_MS - 1 })).toBe(false);
    expect(wantsSignInRefresh({ records: [record()], lastRefreshAt: NOW, now: NOW + SIGNIN_REFRESH_MS })).toBe(true);
  });
});

describe("signInStep", () => {
  const step = (over: Partial<Parameters<typeof signInStep>[0]> = {}) =>
    signInStep({ record: record(), status: "error", retryQueued: false, back: true, now: NOW + 10 * MIN, ...over }).kind;

  it("waits while signed out", () => {
    expect(step({ back: false })).toBe("wait");
  });

  it("retries a failed turn once sign-in is back", () => {
    expect(step()).toBe("retry");
  });

  it("never retries while a retry row is queued or the thread is about to start", () => {
    expect(step({ retryQueued: true })).toBe("wait");
    expect(step({ status: "pending" })).toBe("wait");
  });

  it("forgets a thread that is gone or no longer in error", () => {
    expect(step({ status: "gone", back: false })).toBe("forget");
    expect(step({ status: "idle", back: false })).toBe("forget");
    expect(step({ status: "active" })).toBe("forget");
  });

  it("never retries twice: a retry that failed on sign-in again is left in error once back", () => {
    const again = record({ retriedAt: NOW + MIN, at: NOW + 2 * MIN });
    expect(step({ record: again, back: false })).toBe("wait");
    expect(step({ record: again })).toBe("leave");
  });

  it("gives its retry time to start, then forgets a thread that failed on something else", () => {
    const retried = record({ retriedAt: NOW + 10 * MIN });
    expect(step({ record: retried, now: NOW + 10 * MIN + RETRY_GRACE_MS - 1 })).toBe("wait");
    expect(step({ record: retried, now: NOW + 10 * MIN + RETRY_GRACE_MS })).toBe("forget");
    expect(step({ record: retried, status: "active" })).toBe("forget");
    expect(step({ record: retried, retryQueued: true, now: NOW + 60 * MIN })).toBe("wait");
  });
});

describe("holding and refusing", () => {
  it("holds new agent turns while signed out, never the owner's own messages", () => {
    expect(signInHold([record()], false)).toBe("Claude is signed out: waiting for Alex to sign in.");
    expect(signInHold([record()], false)).toBe(signinHoldReason());
    expect(signInHold([record()], true)).toBeNull();
    expect(signInHold([], false)).toBeNull();
    expect(signInHold([record({ retriedAt: NOW + MIN })], false)).toBeNull();
  });

  it("refuses new builds and research while signed out", () => {
    expect(signInStartRefusal([record()], "build")).toBe(
      "No new build: Claude is signed out; it starts once Alex signs in. End your pass saying what waits.",
    );
    expect(signInStartRefusal([record()], "research")).toMatch(/^No new research: Claude is signed out/);
    expect(signInStartRefusal([], "build")).toBeNull();
  });

  it("wakes a paused task once", () => {
    const message = signInWakeMessage([
      { taskId: "task_1", threadId: "thr_a", kind: "build", at: NOW },
      { taskId: "task_1", threadId: "thr_a", kind: "research", at: NOW },
    ]);
    expect(message).toContain("task_1: Claude is signed in again");
    expect(message).toContain("build and research");
  });

  it("refuses Restart on a thread waiting for sign-in, and only on that", () => {
    expect(signInRestartRefusal([record()], "thr_a")).toContain(SIGN_IN_COMMAND);
    expect(signInRestartRefusal([record()], "thr_other")).toBeNull();
    expect(signInRestartRefusal([record({ retriedAt: NOW + MIN })], "thr_a")).toBeNull();
  });
});

describe("the Needs you item", () => {
  it("is one item however many threads failed, counting those that wait", () => {
    const records = [record(), record({ threadId: "thr_b", since: NOW + MIN, at: NOW + MIN }), record({ threadId: "thr_c", retriedAt: NOW + MIN })];
    const view = signedOutView(records);
    expect(view).toEqual({ since: NOW, waiting: 2, latest: NOW + MIN, command: "claude auth login" });
    const item = signedOutItem(view!);
    expect(item.title).toBe("Claude is signed out");
    expect(item.body).toContain("2 agents are waiting");
    expect(item.body).toContain("restart on their own");
    expect(item.command).toBe("claude auth login");
    expect(item.reason).toBe("account");
    expect(signedOutItem({ since: NOW, waiting: 1, latest: NOW, command: SIGN_IN_COMMAND }).body).toContain("1 agent is waiting");
    expect(`${item.title} ${item.body}`).not.toMatch(/\bbb\b/);
  });

  it("is gone when signed in", () => {
    expect(signedOutView([])).toBeNull();
    expect(signedOutView([record({ retriedAt: NOW + MIN })])).toBeNull();
  });

  it("task_status says so while it is", () => {
    expect(signInStatusLine([])).toBeNull();
    expect(signInStatusLine([record()])).toMatch(/^Claude is signed out: 1 agent turn failed/);
  });
});

describe("the sign-in popup", () => {
  const view = (over: Partial<SignedOutView> = {}): SignedOutView => ({ since: NOW, waiting: 2, latest: NOW + MIN, command: SIGN_IN_COMMAND, ...over });

  it("latest is the newest failure still waiting, not one already retried", () => {
    const records = [
      record({ at: NOW + MIN }),
      record({ threadId: "thr_b", at: NOW + 3 * MIN }),
      record({ threadId: "thr_c", at: NOW + 5 * MIN, retriedAt: NOW + 6 * MIN }),
    ];
    expect(signedOutView(records)?.latest).toBe(NOW + 3 * MIN);
  });

  it("is closed when signed in, whatever was dismissed", () => {
    expect(signInPopupOpen(null, null)).toBe(false);
    expect(signInPopupOpen(null, NOW)).toBe(false);
  });

  it("is open while signed out and never dismissed", () => {
    expect(signInPopupOpen(view(), null)).toBe(true);
  });

  it("stays dismissed for the failure that was on screen, and comes back on a newer one", () => {
    expect(signInPopupOpen(view(), NOW + MIN)).toBe(false);
    expect(signInPopupOpen(view(), NOW + 2 * MIN)).toBe(false);
    expect(signInPopupOpen(view({ latest: NOW + MIN + 1 }), NOW + MIN)).toBe(true);
  });

  it("says what it is, with the button and the fallback command, and no account", () => {
    const words = signInPopup(view());
    expect(words.title).toBe("Claude is signed out");
    expect(words.button).toBe("Sign in with Claude");
    expect(words.button).toBe(SIGN_IN_BUTTON);
    expect(words.body).toBe("2 agents are waiting and new turns are held. Sign in and they restart on their own.");
    expect(signInPopup(view({ waiting: 1 })).body).toContain("1 agent is waiting");
    expect(words.command).toBe("claude auth login");
    expect(words.dismiss).toBe("Not now");
    expect(words.started).toBe("Finish signing in in the browser tab that opened. Agents restart on their own once you are signed in.");
    expect(words.failed).toBe("Run the command in a terminal instead.");
    const all = Object.values(words).join(" ");
    expect(all).not.toMatch(/\bbb\b|\bAlex\b|\bowner\b|@/i);
  });

  it("the Needs you item keeps its words", () => {
    expect(signedOutItem(view()).body).toBe(
      "2 agents are waiting and new turns are held. Run this in a terminal and sign in; they restart on their own once you are signed in.",
    );
  });
});

describe("the host's sign-in", () => {
  it("runs the command the owner is shown, with no account flag", () => {
    expect(SIGN_IN_ARGS).toEqual(["auth", "login"]);
    expect(SIGN_IN_TIMEOUT_MS).toBe(600_000);
  });

  it("looks on the host's PATH first, then the usual install dirs under this user's home", () => {
    expect(signInPathDirs("/usr/bin:/bin", "/Users/friend")).toEqual([
      "/usr/bin",
      "/bin",
      "/Users/friend/.local/bin",
      "/Users/friend/.claude/local",
      "/Users/friend/.npm-global/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ]);
  });

  it("drops relative and empty entries and repeats, and survives no PATH", () => {
    expect(signInPathDirs("/opt/homebrew/bin/::bin:/opt/homebrew/bin:/x", "/home/u/")).toEqual([
      "/opt/homebrew/bin",
      "/x",
      "/home/u/.local/bin",
      "/home/u/.claude/local",
      "/home/u/.npm-global/bin",
      "/usr/local/bin",
    ]);
    expect(signInPathDirs(undefined, "/home/u")[0]).toBe("/home/u/.local/bin");
  });

  it("names a spawn failure in plain words", () => {
    expect(signInSpawnError("ENOENT")).toBe("Could not find the `claude` command.");
    expect(signInSpawnError("EACCES")).toContain("permission denied");
    expect(signInSpawnError("EAGAIN")).toBe("Could not start `claude auth login` (EAGAIN).");
    expect(signInSpawnError(null)).toBe("Could not start `claude auth login`.");
    expect(signInSpawnError(undefined)).toBe("Could not start `claude auth login`.");
  });
});
