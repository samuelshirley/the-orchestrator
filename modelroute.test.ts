import { describe, expect, it, vi } from "vitest";
import { JEV_BACKOFF_MS, JEV_TIMEOUT_MS, STATE_LIMIT, type Answer } from "./jevwatch";
import {
  EFFORT_QUESTION,
  EFFORT_ROUTING,
  EFFORT_THRESHOLD,
  HAIKU_MODEL,
  HAIKU_THRESHOLD,
  MODEL_QUESTION,
  RESEARCH_MODEL_QUESTION,
  ROUTE_WINDOW_MS,
  SCRUB_RULES,
  SONNET_MODEL,
  SONNET_THRESHOLD,
  allowedEfforts,
  applyRule,
  askRoute,
  effortDecision,
  modelLabels,
  ownerPickedModel,
  pausedText,
  routeDecision,
  routeBackoff,
  routeFailed,
  routeLabel,
  routePause,
  routeRequest,
  routeSkip,
  routeState,
  routeTooltip,
  routingLine,
  scrub,
  skippedRoute,
  spawnModel,
  type AskedRole,
  type RouteReply,
  type RouteRole,
} from "./modelroute";
import { TYPESAFE_BASE_URL } from "./typesafe";

/** An effort answer: the choice at probability `top`. */
const effortAt = (choice: string, top: number): Answer => ({ choice, top, margin: 0 });

/** A reply with Jev's model choice; its effort defaults to a confident "high" (no effort passed). */
const ok = (
  choice: string,
  probabilities: Record<string, number>,
  model: string | null = "jev-1.13.0",
  effort: Answer = effortAt("high", 0.9),
): RouteReply => ({
  ok: true,
  latencyMs: 300,
  model,
  answer: { choice, top: probabilities[choice]!, margin: 0 },
  effort,
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

  it("asks model and effort in one request; Haiku is offered to research only", () => {
    for (const role of ["task", "build"] as const) {
      const request = routeRequest("s", "jev-latest", role);
      expect(request).toMatchObject({ model: "jev-latest", state: "s" });
      expect(Object.keys(request.questions)).toEqual(["model", "effort"]);
      expect(Object.keys(request.questions.model.criteria)).toEqual(["sonnet", "opus"]);
    }
    const research = routeRequest("s", "jev-latest", "research");
    expect(Object.keys(research.questions.model.criteria)).toEqual(["haiku", "sonnet", "opus"]);
    expect(research.questions).toEqual({ model: RESEARCH_MODEL_QUESTION, effort: EFFORT_QUESTION });
    expect(Object.keys(EFFORT_QUESTION.criteria)).toEqual(["low", "medium", "high"]);
    expect(modelLabels("research")).toEqual(["haiku", "sonnet", "opus"]);
    expect(modelLabels("task")).toEqual(["sonnet", "opus"]);
    expect(modelLabels("build")).toEqual(["sonnet", "opus"]);
  });

  it("with effort routing off, asks the model alone and offers no one Haiku", () => {
    for (const role of ["task", "research", "build"] as const) {
      expect(routeRequest("s", "jev-latest", role, false).questions).toEqual({ model: MODEL_QUESTION });
      expect(modelLabels(role, false)).toEqual(["sonnet", "opus"]);
    }
  });
});

// ------------------------------------------------------------------ the decision

describe("routeDecision: the model", () => {
  it("Sonnet only for a confident sonnet: at the threshold, not just below", () => {
    expect(routeDecision(ok("sonnet", { sonnet: 0.86, opus: 0.14 }), "task")).toEqual({
      model: SONNET_MODEL,
      reason: "sonnet",
      probability: 0.86,
      jevModel: "jev-1.13.0",
      error: null,
      effort: null,
      effortReason: "high",
      effortProbability: 0.9,
    });
    expect(SONNET_THRESHOLD).toBe(0.7);
    expect(routeDecision(ok("sonnet", { sonnet: SONNET_THRESHOLD, opus: 0.3 }), "build").model).toBe(SONNET_MODEL);
    expect(routeDecision(ok("sonnet", { sonnet: 0.69, opus: 0.31 }), "build")).toMatchObject({ model: null, reason: "unsure" });
  });

  it("Haiku only for research at 0.8 or more, with no effort", () => {
    expect(HAIKU_THRESHOLD).toBe(0.8);
    expect(routeDecision(ok("haiku", { haiku: HAIKU_THRESHOLD, sonnet: 0.15, opus: 0.05 }, "jev-1", effortAt("low", 0.95)), "research")).toEqual({
      model: HAIKU_MODEL,
      reason: "haiku",
      probability: HAIKU_THRESHOLD,
      jevModel: "jev-1",
      error: null,
      effort: null,
      effortReason: "haiku",
      effortProbability: null,
    });
    // Just below: no model, the effort still counts.
    expect(routeDecision(ok("haiku", { haiku: 0.79, sonnet: 0.2, opus: 0.01 }, "jev-1", effortAt("low", 0.95)), "research")).toMatchObject({
      model: null,
      reason: "unsure",
      effort: "low",
    });
  });

  it("never Haiku for a task or build, even a confident haiku answer", () => {
    for (const role of ["task", "build"] as const) {
      const record = routeDecision(ok("haiku", { haiku: 0.99, opus: 0.01 }), role);
      expect(record.model).toBeNull();
      expect(record.reason).not.toBe("haiku");
      expect(spawnModel(role, { ...record, model: HAIKU_MODEL, reason: "haiku" })).toEqual({});
    }
  });

  it("no model for an unsure sonnet, opus, or any failure, and then no effort", () => {
    expect(routeDecision(ok("opus", { sonnet: 0.1, opus: 0.9 }), "task")).toMatchObject({ model: null, reason: "opus", probability: 0.9 });
    const failures = [
      routeDecision({ ok: true, latencyMs: 1, model: null, answer: { error: "no answer" }, effort: { choice: "low", top: 0.99, margin: 0.98 } }, "research"),
      routeDecision({ ok: false, kind: "no-key", problem: "missing" }, "research"),
      routeDecision({ ok: false, kind: "no-key", problem: "open" }, "research"),
      routeDecision({ ok: false, kind: "timeout", error: "slow", latencyMs: 2000 }, "research"),
      routeDecision({ ok: false, kind: "error", error: "HTTP 500", latencyMs: 5 }, "research"),
    ];
    expect(failures.map((record) => record.reason)).toEqual(["error", "no-key", "key-open", "timeout", "error"]);
    for (const record of failures) {
      expect(record).toMatchObject({ model: null, effort: null, effortReason: "none" });
      expect(spawnModel("research", record)).toEqual({});
    }
  });

  it("backs off for 5 minutes after a failure", () => {
    expect(routeBackoff(1000, null)).toBe(false);
    expect(routeBackoff(1000 + 5 * 60_000 - 1, 1000)).toBe(true);
    expect(routeBackoff(1000 + 5 * 60_000, 1000)).toBe(false);
  });

  it("only timeouts and errors start the back-off", () => {
    expect(routeFailed(routeDecision({ ok: false, kind: "timeout", error: "x", latencyMs: 1 }, "task"))).toBe(true);
    expect(routeFailed(routeDecision({ ok: false, kind: "error", error: "x", latencyMs: 1 }, "task"))).toBe(true);
    expect(routeFailed(routeDecision({ ok: false, kind: "no-key", problem: "missing" }, "task"))).toBe(false);
    expect(routeFailed(routeDecision(ok("opus", { opus: 0.9, sonnet: 0.1 }), "task"))).toBe(false);
  });
});

describe("routeDecision: the effort", () => {
  const withEffort = (role: AskedRole, choice: string, top: number) =>
    routeDecision(ok("opus", { opus: 0.9, sonnet: 0.1 }, "jev-1", effortAt(choice, top)), role);

  it("passes an effort only at 0.7 or more, not just below", () => {
    expect(EFFORT_THRESHOLD).toBe(0.7);
    expect(withEffort("research", "medium", EFFORT_THRESHOLD)).toMatchObject({ effort: "medium", effortReason: "medium", effortProbability: 0.7 });
    expect(withEffort("research", "medium", 0.69)).toMatchObject({ effort: null, effortReason: "unsure", effortProbability: 0.69 });
    expect(withEffort("task", "medium", 0.69)).toMatchObject({ effort: null, effortReason: "unsure" });
  });

  it("research may go to low; task and build never below medium", () => {
    expect(withEffort("research", "low", 0.9)).toMatchObject({ effort: "low", effortReason: "low" });
    expect(spawnModel("research", withEffort("research", "low", 0.9))).toEqual({ reasoningLevel: "low" });
    for (const role of ["task", "build"] as const) {
      expect(withEffort(role, "low", 0.9)).toMatchObject({ effort: "medium", effortReason: "floor" });
      expect(spawnModel(role, withEffort(role, "low", 0.9))).toEqual({ reasoningLevel: "medium" });
      expect(withEffort(role, "medium", 0.9)).toMatchObject({ effort: "medium", effortReason: "medium" });
      // A low that got past the decision some other way is still refused at spawn.
      expect(spawnModel(role, { ...withEffort(role, "low", 0.9), effort: "low" })).toEqual({});
    }
    expect(allowedEfforts("task")).toEqual(["medium"]);
    expect(allowedEfforts("build")).toEqual(["medium"]);
    expect(allowedEfforts("research")).toEqual(["low", "medium"]);
    expect(allowedEfforts("patches")).toEqual([]);
  });

  it("high, unsure or an unusable answer passes no effort", () => {
    for (const role of ["task", "research", "build"] as const) {
      expect(withEffort(role, "high", 0.99)).toMatchObject({ effort: null, effortReason: "high" });
      expect(spawnModel(role, withEffort(role, "high", 0.99))).toEqual({});
      expect(withEffort(role, "low", 0.5)).toMatchObject({ effort: null, effortReason: "unsure" });
      const broken = routeDecision({ ok: true, latencyMs: 1, model: null, answer: { choice: "sonnet", top: 0.9, margin: 0.8 }, effort: { error: "bad probability" } }, role);
      expect(broken).toMatchObject({ model: SONNET_MODEL, effort: null, effortReason: "error" });
      expect(spawnModel(role, broken)).toEqual({ model: SONNET_MODEL });
    }
  });

  it("Sonnet and an effort together", () => {
    const record = routeDecision(ok("sonnet", { sonnet: 0.86, opus: 0.14 }, "jev-1", effortAt("medium", 0.8)), "build");
    expect(spawnModel("build", record)).toEqual({ model: SONNET_MODEL, reasoningLevel: "medium" });
  });

  it("the off switch: no effort and no Haiku, Sonnet as before", () => {
    expect(EFFORT_ROUTING).toBe(true);
    const haiku = ok("haiku", { haiku: 0.95, sonnet: 0.05 }, "jev-1", effortAt("low", 0.95));
    expect(routeDecision(haiku, "research", false)).toMatchObject({ model: null, reason: "unsure", effort: null, effortReason: "off" });
    const low = routeDecision(ok("opus", { opus: 0.9 }, "jev-1", effortAt("low", 0.95)), "research", false);
    expect(low).toMatchObject({ effort: null, effortReason: "off" });
    expect(effortDecision({ choice: "medium", top: 0.99, margin: 0.9 }, "task", false)).toMatchObject({ effort: null, effortReason: "off" });
    const sonnet = routeDecision(ok("sonnet", { sonnet: 0.9, opus: 0.1 }, "jev-1", effortAt("medium", 0.95)), "task", false);
    expect(spawnModel("task", sonnet, false)).toEqual({ model: SONNET_MODEL });
    // Records made with it on are not honoured once it is off.
    const on = routeDecision(haiku, "research");
    expect(spawnModel("research", on, false)).toEqual({});
    expect(spawnModel("research", withEffort("research", "low", 0.9), false)).toEqual({});
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

  it("the owner's pick wins, and another provider is left alone", () => {
    expect(routeSkip({ role: "task", ownerModel: true, providerId: "claude-code" })).toBe("owner");
    expect(routeSkip({ role: "build", ownerModel: false, providerId: "codex" })).toBe("provider");
    expect(routeSkip({ role: "build", ownerModel: false, providerId: undefined })).toBe("provider");
  });

  it("counts only a model or effort the owner picked in the composer, not the ones it always sends", () => {
    expect(ownerPickedModel({ model: "opus", executionInputSources: { model: "explicit" } })).toBe(true);
    expect(ownerPickedModel({ model: "opus", executionInputSources: { reasoningLevel: "explicit" } })).toBe(true);
    expect(ownerPickedModel({ model: "opus", executionInputSources: { model: "client-preference", reasoningLevel: "explicit" } })).toBe(true);
    // bb's New task composer sends a model every time; no source means the default, so Jev is asked.
    expect(ownerPickedModel({ model: "opus" })).toBe(false);
    expect(ownerPickedModel({ model: "opus", executionInputSources: {} })).toBe(false);
    expect(ownerPickedModel({ model: "opus", executionInputSources: { model: "client-preference", reasoningLevel: "client-preference" } })).toBe(false);
    expect(ownerPickedModel({})).toBe(false);
  });

  it("gives Patches no model and no effort, from any decision", () => {
    const sonnet = routeDecision(ok("sonnet", { sonnet: 0.95, opus: 0.05 }, "jev-1", effortAt("medium", 0.95)), "task");
    const haiku = routeDecision(ok("haiku", { haiku: 0.95, sonnet: 0.05 }, "jev-1"), "research");
    const low = routeDecision(ok("opus", { opus: 0.9 }, "jev-1", effortAt("low", 0.95)), "research");
    for (const record of [sonnet, haiku, low]) expect(spawnModel("patches", record)).toEqual({});
    for (const role of ["task", "research", "build"] as RouteRole[]) expect(spawnModel(role, sonnet)).toEqual({ model: SONNET_MODEL, reasoningLevel: "medium" });
    expect(spawnModel("research", haiku)).toEqual({ model: HAIKU_MODEL });
    expect(spawnModel("research", low)).toEqual({ reasoningLevel: "low" });
  });

  it("passes nothing on every outcome Jev did not lower: behaviour as before", () => {
    const outcomes = [
      routeDecision({ ok: false, kind: "no-key", problem: "missing" }, "build"),
      routeDecision({ ok: false, kind: "timeout", error: "x", latencyMs: 1 }, "build"),
      routeDecision({ ok: false, kind: "error", error: "x", latencyMs: 1 }, "build"),
      routeDecision(ok("opus", { opus: 0.6, sonnet: 0.4 }), "build"),
      routeDecision(ok("sonnet", { sonnet: 0.5, opus: 0.5 }), "build"),
      skippedRoute("backoff"),
      skippedRoute("owner"),
      skippedRoute("provider"),
      skippedRoute("patches"),
      skippedRoute("error", "host down"),
    ];
    for (const record of outcomes) expect(spawnModel("build", record)).toEqual({});
  });
});

describe("the back-off on the board", () => {
  const clock = (ms: number) => `@${ms}`;

  it("says when it ends and why while it holds, nothing after", () => {
    expect(routePause(1000, null)).toBeNull();
    expect(routePause(1000 + JEV_BACKOFF_MS - 1, { at: 1000, error: "HTTP 500" })).toEqual({ until: 1000 + JEV_BACKOFF_MS, reason: "HTTP 500" });
    expect(routePause(1000 + JEV_BACKOFF_MS, { at: 1000, error: "HTTP 500" })).toBeNull();
    expect(routePause(1000, { at: 1000, error: null })).toEqual({ until: 1000 + JEV_BACKOFF_MS, reason: "failed" });
  });

  it("scrubs and shortens the reason", () => {
    const pause = routePause(1000, { at: 1000, error: `host: failed for jane@example.com ${"x".repeat(300)}` });
    expect(pause?.reason).not.toContain("jane@example.com");
    expect(pause?.reason).toContain("<email>");
    expect(pause?.reason.length).toBeLessThanOrEqual(120);
  });

  it("appends the pause to the routing line only while it holds", () => {
    expect(pausedText({ until: 5000 }, 4999, clock)).toBe(" · paused after a failure until @5000");
    expect(pausedText({ until: 5000 }, 5000, clock)).toBe("");
    expect(pausedText(null, 0, clock)).toBe("");
  });
});

// ------------------------------------------------------------------ the host's side

describe("askRoute", () => {
  const KEY = { ok: true as const, config: { baseUrl: TYPESAFE_BASE_URL, key: "fake-key-123", model: "jev-latest" } };

  it("makes no call without a key", async () => {
    const fetch = vi.fn();
    expect(await askRoute({ key: { ok: false, problem: "missing" }, fetch, now: () => 0 }, "s", "task")).toEqual({
      ok: false,
      kind: "no-key",
      problem: "missing",
    });
    expect(await askRoute({ key: { ok: false, problem: "open" }, fetch, now: () => 0 }, "s", "task")).toMatchObject({ problem: "open" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts once to TypeSafe with the key in the header only, and reads both answers", async () => {
    const fetch = vi.fn(async () => ({
      status: 200,
      text: async () =>
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {
            model: { type: "choice", choice: "sonnet", probabilities: { sonnet: 0.86, opus: 0.14 }, confidence: 0.9 },
            effort: { type: "choice", choice: "medium", probabilities: { low: 0.1, medium: 0.8, high: 0.1 } },
          },
        }),
    }));
    const reply = await askRoute({ key: KEY, fetch, now: () => 0 }, "Task: x", "build");
    expect(reply).toEqual({
      ok: true,
      latencyMs: 0,
      model: "jev-1.13.0",
      answer: { choice: "sonnet", top: 0.86, margin: expect.closeTo(0.72) },
      effort: { choice: "medium", top: 0.8, margin: expect.closeTo(0.7) },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string; redirect: string }];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.headers.Authorization).toBe("Bearer fake-key-123");
    expect(init.body).not.toContain("fake-key-123");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body)).toEqual({ model: "jev-latest", state: "Task: x", questions: { model: MODEL_QUESTION, effort: EFFORT_QUESTION } });
  });

  it("a haiku answer is read for research and refused for a build", async () => {
    const body = JSON.stringify({ answers: { model: { type: "choice", choice: "haiku", probabilities: { haiku: 0.9, sonnet: 0.05, opus: 0.05 } } } });
    const fetch = async () => ({ status: 200, text: async () => body });
    const research = await askRoute({ key: KEY, fetch, now: () => 0 }, "s", "research");
    expect(research).toMatchObject({ ok: true, answer: { choice: "haiku", top: 0.9 }, effort: { error: "no answer" } });
    const build = await askRoute({ key: KEY, fetch, now: () => 0 }, "s", "build");
    expect(build).toMatchObject({ ok: true, answer: { error: "choice outside the labels" } });
    expect(routeDecision(build as RouteReply, "build")).toMatchObject({ model: null, reason: "error" });
  });

  it("every failure is a value with no body and no key", async () => {
    const status = (code: number) => askRoute({ key: KEY, fetch: async () => ({ status: code, text: async () => "fake-key-123 body" }), now: () => 0 }, "s", "task");
    expect(await status(401)).toEqual({ ok: false, kind: "error", error: "HTTP 401", latencyMs: 0 });
    expect(await askRoute({ key: KEY, fetch: async () => ({ status: 200, text: async () => "nope" }), now: () => 0 }, "s", "task")).toMatchObject({
      kind: "error",
      error: "not JSON",
    });
    const thrown = await askRoute({ key: KEY, fetch: async () => Promise.reject(new TypeError("fake-key-123")), now: () => 0 }, "s", "task");
    expect(thrown).toEqual({ ok: false, kind: "error", error: "network (TypeError)", latencyMs: 0 });
    expect(JSON.stringify(thrown)).not.toContain("fake-key-123");
  });

  it("times out after JEV_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    try {
      const fetch = (_url: string, init: { signal: AbortSignal }) =>
        new Promise<{ status: number; text(): Promise<string> }>((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      const pending = askRoute({ key: KEY, fetch, now: () => 0 }, "s", "task");
      await vi.advanceTimersByTimeAsync(JEV_TIMEOUT_MS);
      expect(await pending).toMatchObject({ ok: false, kind: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ------------------------------------------------------------------ the board

describe("board words", () => {
  it("labels a routed agent's model and effort", () => {
    expect(routeLabel({ model: SONNET_MODEL, probability: 0.861 })).toBe("Sonnet · Jev 0.86");
    expect(routeLabel({ model: SONNET_MODEL, probability: 0.861, effort: "medium" })).toBe("Sonnet · medium · Jev 0.86");
    expect(routeLabel({ model: HAIKU_MODEL, probability: 0.912, effort: null })).toBe("Haiku · Jev 0.91");
    expect(routeLabel({ model: null, probability: 0.9, effort: "medium" })).toBe("Default model · medium");
    expect(routeLabel({ model: null, probability: 0.9 })).toBe("Default model");
  });

  it("says why, for the model and the effort", () => {
    const tip = (reason: string, effortReason: string | null = null) => routeTooltip({ reason, probability: 0.9, jevModel: null, effortReason, effortProbability: 0.8 });
    expect(tip("opus")).toContain("Jev chose Opus");
    expect(tip("haiku")).toContain("Haiku");
    expect(tip("unsure")).toContain("unsure");
    expect(tip("no-key")).toContain("no key");
    expect(tip("key-open")).toContain("jev.env is readable by others");
    expect(tip("timeout")).toContain("in time");
    expect(tip("owner")).toContain("composer");
    expect(tip("sonnet", "floor")).toContain("never goes below medium");
    expect(tip("sonnet", "medium")).toContain("Effort: Jev chose medium (0.80)");
    expect(tip("opus", "unsure")).toContain(`under ${EFFORT_THRESHOLD}`);
    expect(tip("haiku", "haiku")).toContain("only level");
    expect(tip("opus", "off")).toContain("off");
  });

  it("counts the last 14 days, or says there is no key", () => {
    const now = ROUTE_WINDOW_MS * 2;
    const rows = [
      { routedAt: now - 1000, model: SONNET_MODEL, reason: "sonnet" },
      { routedAt: now - 2000, model: null, reason: "opus" },
      { routedAt: now - ROUTE_WINDOW_MS - 1, model: SONNET_MODEL, reason: "sonnet" },
    ];
    expect(ROUTE_WINDOW_MS).toBe(14 * 24 * 60 * 60_000);
    expect(routingLine(rows, now, { present: true })).toBe("Jev model routing: 1 of 2 agents lowered (1 Sonnet, 0 lower effort)");
    expect(routingLine([], now, { present: true })).toBe("Jev model routing: 0 of 0 agents lowered (0 Sonnet, 0 lower effort)");
    expect(routingLine(rows, now, { present: false, problem: "missing" })).toBe("Jev model routing: no key");
    expect(routingLine(rows, now, { present: false, problem: "open" })).toContain("readable by others");
  });

  it("counts Haiku and lower effort, an agent once", () => {
    const now = ROUTE_WINDOW_MS * 2;
    const at = now - 1000;
    const rows = [
      { routedAt: at, model: SONNET_MODEL, reason: "sonnet", effort: "medium" },
      { routedAt: at, model: HAIKU_MODEL, reason: "haiku", effort: null },
      { routedAt: at, model: null, reason: "opus", effort: "medium" },
      { routedAt: at, model: null, reason: "opus", effort: null },
    ];
    expect(routingLine(rows, now, { present: true })).toBe("Jev model routing: 3 of 4 agents lowered (1 Sonnet, 1 Haiku, 2 lower effort)");
  });

  it("counts only agents Jev was asked about", () => {
    const now = ROUTE_WINDOW_MS * 2;
    const at = now - 1000;
    const asked = ["sonnet", "opus", "unsure", "error", "timeout"].map((reason) => ({ routedAt: at, model: reason === "sonnet" ? SONNET_MODEL : null, reason }));
    const notAsked = ["owner", "patches", "provider", "no-key", "key-open", "backoff"].map((reason) => ({ routedAt: at, model: null, reason }));
    expect(routingLine([...asked, ...notAsked], now, { present: true })).toBe("Jev model routing: 1 of 5 agents lowered (1 Sonnet, 0 lower effort)");
    expect(routingLine(notAsked, now, { present: true })).toBe("Jev model routing: 0 of 0 agents lowered (0 Sonnet, 0 lower effort)");
    expect(routingLine([asked[0]!], now, { present: true })).toBe("Jev model routing: 1 of 1 agent lowered (1 Sonnet, 0 lower effort)");
  });
});
