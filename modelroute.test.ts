import { describe, expect, it, vi } from "vitest";
import { JEV_TIMEOUT_MS, STATE_LIMIT } from "./jevwatch";
import {
  MODEL_QUESTION,
  ROUTE_WINDOW_MS,
  SCRUB_RULES,
  SONNET_MODEL,
  SONNET_THRESHOLD,
  applyRule,
  askRoute,
  ownerPickedModel,
  routeDecision,
  routeBackoff,
  routeFailed,
  routeLabel,
  routeRequest,
  routeSkip,
  routeState,
  routeTooltip,
  routingLine,
  scrub,
  skippedRoute,
  spawnModel,
  type RouteReply,
  type RouteRole,
} from "./modelroute";
import { TYPESAFE_BASE_URL } from "./typesafe";

const ok = (choice: string, probabilities: Record<string, number>, model: string | null = "jev-1.13.0"): RouteReply => ({
  ok: true,
  latencyMs: 300,
  model,
  answer: { choice, top: probabilities[choice], margin: 0 },
});

// ------------------------------------------------------------------ scrub

// Fakes, one per rule: each is caught by its own rule alone (the per-rule test).
const FAKES: Record<string, { text: string; secret: string; placeholder: string }> = {
  "url-credentials": {
    text: "Clone https://deploy:hunter2pw@git.example.com/repo.git first",
    secret: "hunter2pw",
    placeholder: "<url>",
  },
  "db-url": { text: "DB at postgresql://db.internal.example:5432/prod", secret: "db.internal.example", placeholder: "<db-url>" },
  "scheme-credentials": { text: "Use ftp://bob:s3cretpw@files.example.net/x now", secret: "s3cretpw", placeholder: "<db-url>" },
  "signed-url": {
    text: "Open https://cdn.example.com/f.png?w=1&access_token=Zq9fakeTok&x=2 please",
    secret: "Zq9fakeTok",
    placeholder: "<url>",
  },
  "env-line": { text: "notes\nexport Stripe_Key: live-value-here\nmore", secret: "live-value-here", placeholder: "Stripe_Key: <value>" },
  "env-inline": { text: "then run with NODE_ENV=productionish and go", secret: "productionish", placeholder: "NODE_ENV=<value>" },
  jwt: { text: "token eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl here", secret: "eyJhbGciOi", placeholder: "<secret>" },
  sk: { text: "key sk-ant-Ab3dE here", secret: "sk-ant-Ab3dE", placeholder: "<secret>" },
  github: { text: "pat ghp_Ab3dEf9 and github_pat_X1y2Z3 here", secret: "ghp_Ab3dEf9", placeholder: "<secret>" },
  slack: { text: "slack xoxb-12-abcdef here", secret: "xoxb-12-abcdef", placeholder: "<secret>" },
  aws: { text: "aws AKIAABCDEFGHIJKL here", secret: "AKIAABCDEFGHIJKL", placeholder: "<secret>" },
  "long-token": { text: "opaque a1b2c3d4e5f6g7h8i9j0k here", secret: "a1b2c3d4e5f6g7h8i9j0k", placeholder: "<secret>" },
  email: { text: "Mail jane.doe+x@example.co.uk today", secret: "jane.doe", placeholder: "<email>" },
  "phone-international": { text: "Call +44 20 7946 0958 now", secret: "7946", placeholder: "<phone>" },
  phone: { text: "Call (415) 555-0199 or 415.555.0123 now", secret: "555", placeholder: "<phone>" },
};

describe("scrub", () => {
  it("has a fake for every rule", () => {
    expect(Object.keys(FAKES).sort()).toEqual(SCRUB_RULES.map((rule) => rule.name).sort());
  });

  it.each(SCRUB_RULES.map((rule) => [rule.name, rule] as const))("rule %s alone removes its fake", (name, rule) => {
    const fake = FAKES[name];
    const out = applyRule(rule, fake.text);
    expect(out).not.toContain(fake.secret);
    expect(out).toContain(fake.placeholder);
  });

  it.each(Object.entries(FAKES))("the whole scrub removes %s", (_name, fake) => {
    expect(scrub(fake.text)).not.toContain(fake.secret);
  });

  it("leaves none of the fakes in a brief that mixes them all", () => {
    const secrets = [
      "jane.doe@example.com",
      "sk-proj-Q1w2E3r4T5",
      "ghp_Q1w2E3r4T5y6",
      "gho_Q1w2E3r4T5y6",
      "github_pat_11ABCDEF0_xyz",
      "xoxp-1234-5678-abcd",
      "AKIAIOSFODNN7EXAMPLE",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dGVzdHNpZw",
      "Zx9Yw8Vu7Ts6Rq5Po4Nm3",
      "hunter2-pass",
      "redis-secret-pw",
      "mongopw99",
      "s3cr3tsig",
      "+1 (415) 555-0142",
      "020-7946-0958",
      "verylongpasswordvalue",
      "plainvalue42",
    ];
    const brief = [
      "Fix the login bug Sam reported (jane.doe@example.com).",
      "Keys: sk-proj-Q1w2E3r4T5, ghp_Q1w2E3r4T5y6, gho_Q1w2E3r4T5y6, github_pat_11ABCDEF0_xyz, xoxp-1234-5678-abcd.",
      "AWS AKIAIOSFODNN7EXAMPLE and a JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dGVzdHNpZw.",
      "Session Zx9Yw8Vu7Ts6Rq5Po4Nm3 expired.",
      "DATABASE_URL=postgres://app:hunter2-pass@db.example.com:5432/app",
      "Cache: rediss://default:redis-secret-pw@cache.example.com:6380",
      "Mongo at mongodb+srv://root:mongopw99@cluster0.example.net/db",
      "Signed https://files.example.com/a.pdf?X-Amz-Signature=s3cr3tsig&v=1",
      "Call +1 (415) 555-0142 or 020-7946-0958.",
      "ADMIN_PASSWORD: verylongpasswordvalue",
      "run it with API_TOKEN=plainvalue42 once",
    ].join("\n");
    const out = scrub(brief);
    for (const secret of secrets) expect(out).not.toContain(secret);
    expect(out).toContain("<email>");
    expect(out).toContain("<secret>");
    expect(out).toContain("DATABASE_URL=<value>");
    expect(out).toContain("<db-url>");
    expect(out).toContain("<phone>");
    expect(out).toContain("Fix the login bug");
  });

  it("leaves ordinary text alone", () => {
    const plain = [
      "Edit src/a.ts and app.tsx, then docs/how-it-works.md.",
      "Move to Sonnet 5.5 and Node 22.11.0 on 2026-10-02 at 14:30.",
      "See task_abc123, thread thr_zztzvrrswz and PR #123.",
      "Retry 3 times, wait 30 s, cap at 4 builds and 2000 ms.",
      "Branch task/integrate-token-dashboard from main.",
      "Options: yes / no. Note: keep it small.",
      "https://example.com/tool and https://docs.typesafe.ai/api?page=2",
      "x >= 0.7 and a = b",
    ].join("\n");
    expect(scrub(plain)).toBe(plain);
  });
});

// ------------------------------------------------------------------ state

describe("routeState", () => {
  it("frames each role and scrubs before it is sent", () => {
    expect(routeState({ role: "task", title: "Add tiers", brief: "Mail sam@example.com" })).toBe("Task: Add tiers\n\nMail <email>");
    expect(routeState({ role: "research", taskTitle: "T", question: "Why?" })).toContain('Research for the task "T"');
    expect(routeState({ role: "build", taskTitle: "T", instructions: "Do it" })).toContain('Build for the task "T"');
  });

  it("cuts to STATE_LIMIT", () => {
    expect(routeState({ role: "task", title: "t", brief: "word ".repeat(5000) })).toHaveLength(STATE_LIMIT);
  });

  it("asks one choice question, sonnet or opus", () => {
    const request = routeRequest("s", "jev-latest");
    expect(Object.keys(request.questions)).toEqual(["model"]);
    expect(Object.keys(MODEL_QUESTION.criteria)).toEqual(["sonnet", "opus"]);
    expect(request).toMatchObject({ model: "jev-latest", state: "s" });
  });
});

// ------------------------------------------------------------------ the decision

describe("routeDecision", () => {
  it("Sonnet only for a confident sonnet", () => {
    expect(routeDecision(ok("sonnet", { sonnet: 0.86, opus: 0.14 }))).toEqual({
      model: SONNET_MODEL,
      reason: "sonnet",
      probability: 0.86,
      jevModel: "jev-1.13.0",
      error: null,
    });
    expect(routeDecision(ok("sonnet", { sonnet: SONNET_THRESHOLD, opus: 0.3 })).model).toBe(SONNET_MODEL);
  });

  it("no model for an unsure sonnet, opus, or any failure", () => {
    expect(routeDecision(ok("sonnet", { sonnet: 0.69, opus: 0.31 }))).toMatchObject({ model: null, reason: "unsure" });
    expect(routeDecision(ok("opus", { sonnet: 0.1, opus: 0.9 }))).toMatchObject({ model: null, reason: "opus", probability: 0.9 });
    expect(routeDecision({ ok: true, latencyMs: 1, model: null, answer: { error: "no answer" } })).toMatchObject({ model: null, reason: "error" });
    expect(routeDecision({ ok: false, kind: "no-key", problem: "missing" })).toMatchObject({ model: null, reason: "no-key" });
    expect(routeDecision({ ok: false, kind: "no-key", problem: "open" })).toMatchObject({ model: null, reason: "key-open" });
    expect(routeDecision({ ok: false, kind: "timeout", error: "slow", latencyMs: 2000 })).toMatchObject({ model: null, reason: "timeout" });
    expect(routeDecision({ ok: false, kind: "error", error: "HTTP 500", latencyMs: 5 })).toMatchObject({ model: null, reason: "error" });
  });

  it("backs off for 5 minutes after a failure", () => {
    expect(routeBackoff(1000, null)).toBe(false);
    expect(routeBackoff(1000 + 5 * 60_000 - 1, 1000)).toBe(true);
    expect(routeBackoff(1000 + 5 * 60_000, 1000)).toBe(false);
  });

  it("only timeouts and errors start the back-off", () => {
    expect(routeFailed(routeDecision({ ok: false, kind: "timeout", error: "x", latencyMs: 1 }))).toBe(true);
    expect(routeFailed(routeDecision({ ok: false, kind: "error", error: "x", latencyMs: 1 }))).toBe(true);
    expect(routeFailed(routeDecision({ ok: false, kind: "no-key", problem: "missing" }))).toBe(false);
    expect(routeFailed(routeDecision(ok("opus", { opus: 0.9, sonnet: 0.1 })))).toBe(false);
  });
});

describe("who is routed", () => {
  it("never asks for Patches, whatever else holds", () => {
    expect(routeSkip({ role: "patches", ownerModel: false, providerId: "claude-code" })).toBe("patches");
  });

  it("asks for task, research and build on claude-code", () => {
    for (const role of ["task", "research", "build"] as const) {
      expect(routeSkip({ role, ownerModel: false, providerId: "claude-code" })).toBeNull();
    }
  });

  it("the owner's model wins, and another provider is left alone", () => {
    expect(routeSkip({ role: "task", ownerModel: true, providerId: "claude-code" })).toBe("owner");
    expect(routeSkip({ role: "build", ownerModel: false, providerId: "codex" })).toBe("provider");
    expect(routeSkip({ role: "build", ownerModel: false, providerId: undefined })).toBe("provider");
  });

  it("counts only a model the owner picked in the composer, not the one it always sends", () => {
    expect(ownerPickedModel({ model: "opus", executionInputSources: { model: "explicit" } })).toBe(true);
    // bb's New task composer sends a model every time; no source means the default, so Jev is asked.
    expect(ownerPickedModel({ model: "opus" })).toBe(false);
    expect(ownerPickedModel({ model: "opus", executionInputSources: {} })).toBe(false);
    expect(ownerPickedModel({ model: "opus", executionInputSources: { model: "client-preference" } })).toBe(false);
    expect(ownerPickedModel({})).toBe(false);
  });

  it("gives Patches no model even from a Sonnet decision", () => {
    const sonnet = routeDecision(ok("sonnet", { sonnet: 0.95, opus: 0.05 }));
    expect(spawnModel("patches", sonnet)).toEqual({});
    for (const role of ["task", "research", "build"] as RouteRole[]) expect(spawnModel(role, sonnet)).toEqual({ model: SONNET_MODEL });
  });

  it("passes no model on every non-Sonnet outcome: behaviour as before", () => {
    const outcomes = [
      routeDecision({ ok: false, kind: "no-key", problem: "missing" }),
      routeDecision({ ok: false, kind: "timeout", error: "x", latencyMs: 1 }),
      routeDecision({ ok: false, kind: "error", error: "x", latencyMs: 1 }),
      routeDecision(ok("opus", { opus: 0.6, sonnet: 0.4 })),
      routeDecision(ok("sonnet", { sonnet: 0.5, opus: 0.5 })),
      skippedRoute("backoff"),
      skippedRoute("owner"),
      skippedRoute("provider"),
      skippedRoute("error", "host down"),
    ];
    for (const record of outcomes) expect(spawnModel("build", record)).toEqual({});
  });
});

// ------------------------------------------------------------------ the host's side

describe("askRoute", () => {
  const KEY = { ok: true as const, config: { baseUrl: TYPESAFE_BASE_URL, key: "fake-key-123", model: "jev-latest" } };

  it("makes no call without a key", async () => {
    const fetch = vi.fn();
    expect(await askRoute({ key: { ok: false, problem: "missing" }, fetch, now: () => 0 }, "s")).toEqual({
      ok: false,
      kind: "no-key",
      problem: "missing",
    });
    expect(await askRoute({ key: { ok: false, problem: "open" }, fetch, now: () => 0 }, "s")).toMatchObject({ problem: "open" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts once to TypeSafe with the key in the header only, and reads the answer", async () => {
    const fetch = vi.fn(async () => ({
      status: 200,
      text: async () =>
        JSON.stringify({
          model: "jev-1.13.0",
          answers: { model: { type: "choice", choice: "sonnet", probabilities: { sonnet: 0.86, opus: 0.14 }, confidence: 0.9 } },
        }),
    }));
    const reply = await askRoute({ key: KEY, fetch, now: () => 0 }, "Task: x");
    expect(reply).toEqual({ ok: true, latencyMs: 0, model: "jev-1.13.0", answer: { choice: "sonnet", top: 0.86, margin: expect.closeTo(0.72) } });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string; redirect: string }];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.headers.Authorization).toBe("Bearer fake-key-123");
    expect(init.body).not.toContain("fake-key-123");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body)).toEqual({ model: "jev-latest", state: "Task: x", questions: { model: MODEL_QUESTION } });
  });

  it("every failure is a value with no body and no key", async () => {
    const status = (code: number) => askRoute({ key: KEY, fetch: async () => ({ status: code, text: async () => "fake-key-123 body" }), now: () => 0 }, "s");
    expect(await status(401)).toEqual({ ok: false, kind: "error", error: "HTTP 401", latencyMs: 0 });
    expect(await askRoute({ key: KEY, fetch: async () => ({ status: 200, text: async () => "nope" }), now: () => 0 }, "s")).toMatchObject({
      kind: "error",
      error: "not JSON",
    });
    const thrown = await askRoute({ key: KEY, fetch: async () => Promise.reject(new TypeError("fake-key-123")), now: () => 0 }, "s");
    expect(thrown).toEqual({ ok: false, kind: "error", error: "network (TypeError)", latencyMs: 0 });
    expect(JSON.stringify(thrown)).not.toContain("fake-key-123");
  });

  it("times out after JEV_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    try {
      const fetch = (_url: string, init: { signal: AbortSignal }) =>
        new Promise<{ status: number; text(): Promise<string> }>((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      const pending = askRoute({ key: KEY, fetch, now: () => 0 }, "s");
      await vi.advanceTimersByTimeAsync(JEV_TIMEOUT_MS);
      expect(await pending).toMatchObject({ ok: false, kind: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ------------------------------------------------------------------ the board

describe("board words", () => {
  it("labels a routed agent and says why one is not", () => {
    expect(routeLabel({ model: SONNET_MODEL, probability: 0.861 })).toBe("Sonnet · Jev 0.86");
    expect(routeLabel({ model: null, probability: 0.9 })).toBe("Default model");
    expect(routeTooltip({ reason: "opus", probability: 0.9, jevModel: null })).toContain("Jev chose Opus");
    expect(routeTooltip({ reason: "unsure", probability: 0.6, jevModel: null })).toContain("unsure");
    expect(routeTooltip({ reason: "no-key", probability: null, jevModel: null })).toContain("no key");
    expect(routeTooltip({ reason: "key-open", probability: null, jevModel: null })).toContain("jev.env is readable by others");
    expect(routeTooltip({ reason: "timeout", probability: null, jevModel: null })).toContain("in time");
  });

  it("counts the last 7 days, or says there is no key", () => {
    const now = ROUTE_WINDOW_MS * 2;
    const rows = [
      { routedAt: now - 1000, model: SONNET_MODEL, reason: "sonnet" },
      { routedAt: now - 2000, model: null, reason: "opus" },
      { routedAt: now - ROUTE_WINDOW_MS - 1, model: SONNET_MODEL, reason: "sonnet" },
    ];
    expect(routingLine(rows, now, { present: true })).toBe("Jev model routing: 1 of 2 agents Jev routed on Sonnet");
    expect(routingLine([], now, { present: true })).toBe("Jev model routing: 0 of 0 agents Jev routed on Sonnet");
    expect(routingLine(rows, now, { present: false, problem: "missing" })).toBe("Jev model routing: no key");
    expect(routingLine(rows, now, { present: false, problem: "open" })).toContain("readable by others");
  });

  it("counts only agents Jev was asked about", () => {
    const now = ROUTE_WINDOW_MS * 2;
    const at = now - 1000;
    const asked = ["sonnet", "opus", "unsure", "error", "timeout"].map((reason) => ({ routedAt: at, model: reason === "sonnet" ? SONNET_MODEL : null, reason }));
    const notAsked = ["owner", "patches", "provider", "no-key", "key-open", "backoff"].map((reason) => ({ routedAt: at, model: null, reason }));
    expect(routingLine([...asked, ...notAsked], now, { present: true })).toBe("Jev model routing: 1 of 5 agents Jev routed on Sonnet");
    expect(routingLine(notAsked, now, { present: true })).toBe("Jev model routing: 0 of 0 agents Jev routed on Sonnet");
    expect(routingLine([asked[0]!], now, { present: true })).toBe("Jev model routing: 1 of 1 agent Jev routed on Sonnet");
  });
});
