import { describe, expect, it } from "vitest";
import {
  RESUME_GRACE_MS,
  UNKNOWN_RESET_MS,
  USAGE_REFRESH_MS,
  USAGE_WARN_PERCENT,
  addPaused,
  clock,
  hitDueAt,
  limitHitOf,
  mayWake,
  parseUsage,
  recordHit,
  restartRefusal,
  resumeStep,
  startRefusal,
  usageLabel,
  usageStatusLine,
  usageView,
  usageWarning,
  wakeMessage,
  wantsRefresh,
  type LimitHit,
  type UsageReading,
  type UsageView,
} from "./usage";

const NOW = Date.parse("2026-09-26T12:00:00Z");
const HOUR = 60 * 60_000;

// What provider-claude-code's getResource answered on the owner's Mac (2026-09-26).
const live = {
  accountKey: "anthropic:account:x",
  observedAt: NOW - 60_000,
  usage: {
    status: "ok",
    plan: { id: "max", multiplier: 5 },
    accountEmail: "someone@example.com",
    planLabel: "Max (5x)",
    windows: [
      { kind: "five-hour", id: "0:Current session", label: "Current session", usedPercent: 72, resetsAt: new Date(NOW + HOUR).toISOString(), model: null, cost: null },
      { kind: "weekly", id: "1:Weekly limit", label: "Weekly limit", usedPercent: 73, resetsAt: new Date(NOW + 41 * HOUR).toISOString(), model: null, cost: null },
      { kind: "weekly", id: "2:Fable", label: "Fable", usedPercent: 99, resetsAt: new Date(NOW + 41 * HOUR).toISOString(), model: "fable", cost: null },
    ],
  },
};

const reading = (windows: UsageReading["windows"]): UsageReading => ({ windows, observedAt: NOW });
const view = (over: Partial<UsageView> = {}): UsageView => ({
  level: "ok",
  percent: 50,
  label: "Current session",
  resetsAt: NOW + HOUR,
  observedAt: NOW,
  ...over,
});

describe("parseUsage", () => {
  it("reads the windows that limit every model, and drops model-scoped ones", () => {
    const parsed = parseUsage(live);
    expect(parsed?.observedAt).toBe(NOW - 60_000);
    expect(parsed?.windows).toEqual([
      { label: "Current session", usedPercent: 72, resetsAt: NOW + HOUR },
      { label: "Weekly limit", usedPercent: 73, resetsAt: NOW + 41 * HOUR },
    ]);
  });

  it("is null without a usable reading", () => {
    expect(parseUsage(null)).toBeNull();
    expect(parseUsage({ usage: { status: "unauthenticated" } })).toBeNull();
    expect(parseUsage({ usage: { status: "error", message: "x" } })).toBeNull();
    expect(parseUsage({ usage: { status: "ok", windows: [] } })).toBeNull();
    expect(parseUsage({ usage: { status: "ok", windows: [{ label: "x", usedPercent: "72" }] } })).toBeNull();
  });

  it("keeps a window without a reset time", () => {
    expect(parseUsage({ usage: { status: "ok", windows: [{ label: "", usedPercent: 10, resetsAt: null }] } })?.windows).toEqual([
      { label: "Usage", usedPercent: 10, resetsAt: null },
    ]);
  });
});

describe("wantsRefresh", () => {
  it("refreshes a reading older than USAGE_REFRESH_MS, at most that often", () => {
    expect(wantsRefresh({ observedAt: NOW - USAGE_REFRESH_MS + 1, lastRefreshAt: null, now: NOW })).toBe(false);
    expect(wantsRefresh({ observedAt: NOW - USAGE_REFRESH_MS, lastRefreshAt: null, now: NOW })).toBe(true);
    expect(wantsRefresh({ observedAt: null, lastRefreshAt: null, now: NOW })).toBe(true);
    expect(wantsRefresh({ observedAt: null, lastRefreshAt: NOW - USAGE_REFRESH_MS + 1, now: NOW })).toBe(false);
    expect(wantsRefresh({ observedAt: null, lastRefreshAt: NOW - USAGE_REFRESH_MS, now: NOW })).toBe(true);
  });
});

describe("usageView", () => {
  it("shows the fullest window", () => {
    expect(usageView(parseUsage(live), NOW)).toEqual({
      level: "ok",
      percent: 73,
      label: "Weekly limit",
      resetsAt: NOW + 41 * HOUR,
      observedAt: NOW - 60_000,
    });
  });

  it("is near at USAGE_WARN_PERCENT, not a point before, and at the limit at 100", () => {
    expect(USAGE_WARN_PERCENT).toBe(90);
    const at = (used: number) => usageView(reading([{ label: "Current session", usedPercent: used, resetsAt: NOW + HOUR }]), NOW)?.level;
    expect(at(89.9)).toBe("ok");
    expect(at(90)).toBe("near");
    expect(at(99.9)).toBe("near");
    expect(at(100)).toBe("limit");
  });

  it("counts a window whose reset has passed as empty: the pause lifts at the reset", () => {
    const after = usageView(reading([{ label: "Current session", usedPercent: 100, resetsAt: NOW }]), NOW);
    expect(after).toMatchObject({ level: "ok", percent: 0, resetsAt: null });
    const before = usageView(reading([{ label: "Current session", usedPercent: 100, resetsAt: NOW + 1 }]), NOW);
    expect(before).toMatchObject({ level: "limit", percent: 100, resetsAt: NOW + 1 });
  });

  it("prefers the window that resets later on a tie: it holds longer", () => {
    const tie = usageView(
      reading([
        { label: "Current session", usedPercent: 95, resetsAt: NOW + HOUR },
        { label: "Weekly limit", usedPercent: 95, resetsAt: NOW + 30 * HOUR },
      ]),
      NOW,
    );
    expect(tie?.label).toBe("Weekly limit");
  });

  it("is null without a reading", () => {
    expect(usageView(null, NOW)).toBeNull();
  });
});

describe("words", () => {
  it("formats the time locally, with a weekday beyond the day", () => {
    const at = NOW + HOUR;
    const d = new Date(at);
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    expect(clock(at, NOW)).toBe(hhmm);
    expect(clock(NOW + 41 * HOUR, NOW)).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d\d:\d\d$/);
  });

  it("labels the header", () => {
    expect(usageLabel(view({ percent: 72 }), NOW)).toBe(`Usage 72% · resets ${clock(NOW + HOUR, NOW)}`);
    expect(usageLabel(view({ resetsAt: null }), NOW)).toBe("Usage 50%");
    expect(usageLabel(view({ level: "limit", percent: 100 }), NOW)).toBe(`Usage limit reached · agents resume ${clock(NOW + HOUR, NOW)}`);
  });

  it("warns only near or at the limit", () => {
    expect(usageWarning(null, NOW)).toBeNull();
    expect(usageWarning(view(), NOW)).toBeNull();
    expect(usageWarning(view({ level: "near", percent: 93 }), NOW)).toContain("new builds and research wait until");
    expect(usageWarning(view({ level: "limit", percent: 100 }), NOW)).toContain("resumes after the reset");
    expect(usageStatusLine(null, NOW)).toBe("Claude usage: not read yet.");
    expect(usageStatusLine(view({ level: "near", percent: 93 }), NOW)).toContain("Work in flight carries on");
  });
});

describe("startRefusal", () => {
  it("refuses new builds and research near and at the limit, never below", () => {
    expect(startRefusal(null, "build", NOW)).toBeNull();
    expect(startRefusal(view({ percent: 89 }), "build", NOW)).toBeNull();
    const near = startRefusal(view({ level: "near", percent: 91 }), "build", NOW);
    expect(near).toContain("No new build");
    expect(near).toContain(clock(NOW + HOUR, NOW));
    expect(startRefusal(view({ level: "limit", percent: 100 }), "research", NOW)).toContain("No new research");
    expect(startRefusal(view({ level: "near", resetsAt: null }), "build", NOW)).toContain("until the window resets");
  });
});

describe("paused starts", () => {
  const entry = { taskId: "t1", threadId: "thr_t1", kind: "build" as const, at: NOW };

  it("keeps one per task and kind", () => {
    const once = addPaused([], entry);
    const twice = addPaused(once, { ...entry, at: NOW + 1 });
    expect(twice).toEqual([{ ...entry, at: NOW + 1 }]);
    expect(addPaused(twice, { ...entry, kind: "research" })).toHaveLength(2);
  });

  it("wakes only when the window has room again", () => {
    expect(mayWake(null)).toBe(false);
    expect(mayWake(view({ level: "near" }))).toBe(false);
    expect(mayWake(view({ level: "limit" }))).toBe(false);
    expect(mayWake(view())).toBe(true);
    expect(wakeMessage([entry, { ...entry, kind: "research" }], view({ percent: 4 }))).toContain("build and research that was paused");
  });
});

describe("limitHitOf", () => {
  const windows = [
    { status: "allowed", resetsAtMs: NOW + 30 * HOUR },
    { status: "blocked", resetsAtMs: NOW + HOUR },
  ];

  it("is a hit on a subscription-window rate limit, resetting with the blocked window", () => {
    expect(limitHitOf({ errorInfo: { category: "rate-limit" }, rateLimits: { kind: "subscription-window", status: "blocked", windows } })).toEqual({
      resetsAt: NOW + HOUR,
    });
  });

  it("takes the latest reset among all windows when none says blocked", () => {
    const open = windows.map((w) => ({ ...w, status: "allowed" }));
    expect(limitHitOf({ errorInfo: { category: "rate-limit" }, rateLimits: { kind: "subscription-window", status: "blocked", windows: open } })).toEqual({
      resetsAt: NOW + 30 * HOUR,
    });
  });

  it("is a hit with an unknown reset when the provider sent no windows", () => {
    expect(limitHitOf({ errorInfo: { category: "rate-limit" }, rateLimits: null })).toEqual({ resetsAt: null });
    expect(limitHitOf({ errorInfo: { category: "rate-limit" }, rateLimits: { kind: "unknown", status: "blocked", windows: [] } })).toEqual({ resetsAt: null });
  });

  it("is not a hit for other failures, or limits that do not reset on a clock", () => {
    expect(limitHitOf({ errorInfo: null, rateLimits: null })).toBeNull();
    expect(limitHitOf({ errorInfo: { category: "overloaded" }, rateLimits: null })).toBeNull();
    expect(limitHitOf({ errorInfo: { category: "rate-limit" }, rateLimits: { kind: "credits", status: "blocked", windows } })).toBeNull();
    expect(limitHitOf({ errorInfo: { category: "rate-limit" }, rateLimits: { kind: "spend-control", status: "blocked", windows } })).toBeNull();
  });
});

describe("recordHit", () => {
  const base = { threadId: "thr_b", role: "build" as const, taskId: "t1", requestId: "req1", resetsAt: NOW + HOUR };

  it("records a hit, and a second hit keeps the first since and the one re-queue", () => {
    const first = recordHit([], base, NOW);
    expect(first).toEqual([{ ...base, since: NOW, requeuedAt: null }]);
    const marked = [{ ...first[0]!, requeuedAt: NOW + 2 * HOUR }];
    const again = recordHit(marked, { ...base, requestId: "req2", resetsAt: NOW + 5 * HOUR }, NOW + 2 * HOUR);
    expect(again).toEqual([{ ...base, requestId: "req2", resetsAt: NOW + 5 * HOUR, since: NOW, requeuedAt: NOW + 2 * HOUR }]);
  });

  it("keeps other threads' hits", () => {
    expect(recordHit(recordHit([], base, NOW), { ...base, threadId: "thr_c" }, NOW)).toHaveLength(2);
  });
});

describe("resumeStep", () => {
  const hit = (over: Partial<LimitHit> = {}): LimitHit => ({
    threadId: "thr_b",
    role: "build",
    taskId: "t1",
    requestId: "req1",
    resetsAt: NOW,
    since: NOW - HOUR,
    requeuedAt: null,
    ...over,
  });
  const due = NOW + RESUME_GRACE_MS;
  const step = (over: Partial<Parameters<typeof resumeStep>[0]> = {}) =>
    resumeStep({ hit: hit(), status: "error", retryQueued: false, fallbackResetAt: null, now: due, ...over }).kind;

  it("waits while a retry is queued, however late: never a duplicate", () => {
    expect(step({ retryQueued: true, now: due + 10 * HOUR })).toBe("wait");
    expect(step({ status: "pending", now: due + 10 * HOUR })).toBe("wait");
  });

  it("is back once the thread runs again or is gone", () => {
    for (const status of ["active", "starting", "stopping", "idle", "gone"] as const) expect(step({ status })).toBe("resumed");
  });

  it("waits until the reset plus RESUME_GRACE_MS, not a moment less", () => {
    expect(step({ now: due - 1 })).toBe("wait");
    expect(step({ now: due })).toBe("requeue");
  });

  it("re-queues once, then gives up after another grace", () => {
    const requeued = hit({ requeuedAt: due });
    expect(resumeStep({ hit: requeued, status: "error", retryQueued: false, fallbackResetAt: null, now: due + RESUME_GRACE_MS - 1 }).kind).toBe("wait");
    expect(resumeStep({ hit: requeued, status: "error", retryQueued: false, fallbackResetAt: null, now: due + RESUME_GRACE_MS }).kind).toBe("give-up");
  });

  it("uses the usage reading's reset, then a session window, when the hit has none", () => {
    expect(hitDueAt(hit({ resetsAt: null }), NOW + HOUR)).toBe(NOW + HOUR + RESUME_GRACE_MS);
    expect(hitDueAt(hit({ resetsAt: null }), null)).toBe(NOW - HOUR + UNKNOWN_RESET_MS + RESUME_GRACE_MS);
    expect(step({ hit: hit({ resetsAt: null }), fallbackResetAt: NOW + HOUR })).toBe("wait");
  });
});

describe("restartRefusal", () => {
  it("refuses Restart while a retry is queued, and only then", () => {
    expect(restartRefusal(undefined, NOW)).toBeNull();
    expect(restartRefusal(NOW + HOUR, NOW)).toContain(`queued to retry for ${clock(NOW + HOUR, NOW)}`);
    expect(restartRefusal(null, NOW)).toContain("already queued to retry");
  });
});
