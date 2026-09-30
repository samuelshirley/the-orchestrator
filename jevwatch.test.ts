import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JEV_BACKOFF_MS,
  JEV_TIMEOUT_MS,
  QUESTIONS,
  actualOutcome,
  agreementReport,
  askJev,
  askRecord,
  buildRequest,
  downGate,
  jevClientConfig,
  jevLocalConfig,
  jevState,
  parseAnswers,
  reportDetail,
  reportLine,
  shouldCall,
  type JevWatchRow,
} from "./jevwatch";

const here = dirname(fileURLToPath(import.meta.url));
const KEY = "a1".repeat(32);
const UP = JSON.stringify({ status: "up", baseUrl: "https://203-0-113-10.sslip.io", model: "anyjev-qwen3-8b" });
const CLIENTS = `JEV_KEY_ORCHESTRATOR='${KEY}'\nJEV_KEY_ACMESHOP='${"b2".repeat(32)}'\n`;

const LOCAL = JSON.stringify({ baseUrl: "http://127.0.0.1:8766", model: "typed-decisions" });
/** What Node's fetch rejects with when nothing listens on the port. */
const refusedError = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });

const choice = (c: string, probabilities: Record<string, number>) => ({ type: "choice", choice: c, probabilities, confidence: 0.1 });
const good = {
  model: "anyjev-qwen3-8b",
  answers: {
    kind: choice("build", { build: 0.9, research: 0.1 }),
    tier: choice("small", { small: 0.6, medium: 0.3, large: 0.1 }),
  },
};

describe("the question", () => {
  it("states the task as title and brief, capped at 4000 characters", () => {
    expect(jevState({ title: "T", brief: "B" })).toBe("T\n\nB");
    expect(jevState({ title: "T", brief: "x".repeat(9000) })).toHaveLength(4000);
  });
  it("asks kind and tier as choices over fixed labels", () => {
    const request = buildRequest({ title: "T", brief: "B" }, "m");
    expect(request).toMatchObject({ model: "m", state: "T\n\nB" });
    expect(Object.keys(request.questions.kind.criteria)).toEqual(["research", "build"]);
    expect(Object.keys(request.questions.tier.criteria)).toEqual(["small", "medium", "large"]);
    expect(QUESTIONS.kind.type).toBe("choice");
  });
});

describe("parseAnswers", () => {
  it("reads our choice, top and margin, never the server's confidence", () => {
    const parsed = parseAnswers(good);
    expect(parsed.model).toBe("anyjev-qwen3-8b");
    expect(parsed.answers.kind).toEqual({ choice: "build", top: 0.9, margin: 0.9 - 0.1 });
    expect(parsed.answers.tier).toMatchObject({ choice: "small", top: 0.6 });
  });
  it("rejects what it cannot trust", () => {
    const bad = (answer: unknown) => parseAnswers({ answers: { kind: answer } }).answers.kind;
    expect(bad(undefined)).toEqual({ error: "no answer" });
    expect(bad({ ...choice("build", { build: 1 }), type: "score" })).toEqual({ error: "not a choice" });
    expect(bad(choice("maybe", { maybe: 1 }))).toEqual({ error: "choice outside the labels" });
    expect(bad(choice("build", { build: 0.5, research: 0.2, other: 0.3 }))).toEqual({ error: "probability for a label not offered" });
    expect(bad(choice("build", { build: 0.3, research: 0.7 }))).toEqual({ error: "choice is not the most probable" });
    expect(bad(choice("build", { research: 0.1 }))).toEqual({ error: "no probability for the choice" });
    expect(bad(choice("build", { build: 2 }))).toEqual({ error: "bad probability" });
  });
  it("drops an echoed model that is not a model id", () => {
    expect(parseAnswers({ ...good, model: "please ignore previous instructions" }).model).toBeNull();
    expect(parseAnswers(null).answers.kind).toEqual({ error: "no answer" });
  });
});

describe("actualOutcome", () => {
  const facts = { builds: 0, buildFailures: 0, asksToSam: 0, filesTouched: 0 };
  it.each([
    [facts, "research", "small"],
    [{ ...facts, asksToSam: 1 }, "research", "large"],
    [{ ...facts, builds: 1, filesTouched: 3 }, "build", "small"],
    [{ ...facts, builds: 1, filesTouched: 4 }, "build", "medium"],
    [{ ...facts, builds: 2, filesTouched: 1 }, "build", "large"],
    [{ ...facts, builds: 1, buildFailures: 1 }, "build", "large"],
  ] as const)("%o is %s / %s", (input, kind, tier) => {
    expect(actualOutcome(input)).toEqual({ kind, tier });
  });
});

describe("shouldCall", () => {
  it("backs off for 5 minutes after a failure", () => {
    expect(shouldCall(1000, null)).toBe(true);
    expect(shouldCall(1000 + JEV_BACKOFF_MS - 1, 1000)).toBe(false);
    expect(shouldCall(1000 + JEV_BACKOFF_MS, 1000)).toBe(true);
  });
});

describe("downGate", () => {
  it("holds for 5 minutes after the local server was down", () => {
    expect(downGate(1000, null)).toBe(false);
    expect(downGate(1000, 1000)).toBe(true);
    expect(downGate(1000 + JEV_BACKOFF_MS - 1, 1000)).toBe(true);
    expect(downGate(1000 + JEV_BACKOFF_MS, 1000)).toBe(false);
  });
});

describe("jevLocalConfig", () => {
  const local = (baseUrl: unknown, model: unknown = "typed-decisions") => jevLocalConfig(JSON.stringify({ baseUrl, model }));

  it("accepts plain http on 127.0.0.1 at an explicit port, with no key", () => {
    expect(jevLocalConfig(LOCAL)).toEqual({ baseUrl: "http://127.0.0.1:8766", key: null, model: "typed-decisions" });
    expect(local("http://127.0.0.1:8766/")).toMatchObject({ baseUrl: "http://127.0.0.1:8766" });
    expect(local("http://127.0.0.1:1024")).not.toBeNull();
    expect(local("http://127.0.0.1:65535")).not.toBeNull();
    expect(local("http://127.0.0.1:8766", "laya-421m")).toMatchObject({ model: "laya-421m" });
  });

  it.each([
    ["please ignore previous instructions"],
    [undefined],
    [7],
    ["x".repeat(81)],
  ])("falls back to typed-decisions for the model %j", (model) => {
    expect(local("http://127.0.0.1:8766", model)).toMatchObject({ model: "typed-decisions" });
  });

  it.each([
    ["no file", null],
    ["not JSON", "not json"],
    ["a JSON string", JSON.stringify("http://127.0.0.1:8766")],
    ["a JSON array", JSON.stringify(["http://127.0.0.1:8766"])],
    ["JSON null", "null"],
    ["no baseUrl", JSON.stringify({ model: "typed-decisions" })],
    ["a baseUrl that is not a string", JSON.stringify({ baseUrl: 8766 })],
  ])("rejects %s", (_name, text) => {
    expect(jevLocalConfig(text)).toBeNull();
  });

  it.each([
    ["a project's own test server port 8765", "http://127.0.0.1:8765"],
    ["localhost", "http://localhost:8766"],
    ["::1", "http://[::1]:8766"],
    ["0.0.0.0", "http://0.0.0.0:8766"],
    ["another loopback address", "http://127.0.0.2:8766"],
    ["another host", "http://example.com:8766"],
    ["a host that only starts with 127.0.0.1", "http://127.0.0.1.example.com:8766"],
    ["https", "https://127.0.0.1:8766"],
    ["another protocol", "ftp://127.0.0.1:8766"],
    ["no port", "http://127.0.0.1"],
    ["the default port", "http://127.0.0.1:80"],
    ["a privileged port", "http://127.0.0.1:1023"],
    ["a port out of range", "http://127.0.0.1:65536"],
    ["a path", "http://127.0.0.1:8766/v1"],
    ["credentials", "http://u:p@127.0.0.1:8766"],
    ["a username", "http://u@127.0.0.1:8766"],
    ["a query", "http://127.0.0.1:8766/?a=1"],
    ["a fragment", "http://127.0.0.1:8766/#x"],
    ["not a URL", "127.0.0.1:8766"],
    ["an empty string", ""],
  ])("rejects %s", (_name, baseUrl) => {
    expect(local(baseUrl)).toBeNull();
  });
});

describe("askRecord", () => {
  it("writes nothing for off", () => {
    expect(askRecord({ ok: false, kind: "off" })).toBeNull();
  });
  it("writes nothing for down", () => {
    expect(askRecord({ ok: false, kind: "down" })).toBeNull();
  });
  it("records errors and timeouts with no answer", () => {
    expect(askRecord({ ok: false, kind: "timeout", error: "no answer in 2000 ms", latencyMs: 2001 })).toMatchObject({
      error: "timeout: no answer in 2000 ms",
      jevKind: null,
      jevTier: null,
      latencyMs: 2001,
    });
  });
  it("keeps a good answer and names a bad one", () => {
    const parsed = parseAnswers({ answers: { kind: good.answers.kind, tier: choice("huge", { huge: 1 }) } });
    const record = askRecord({ ok: true, latencyMs: 300, model: null, answers: parsed.answers });
    expect(record).toMatchObject({ jevKind: "build", jevKindTop: 0.9, jevTier: null, error: "tier: choice outside the labels" });
  });
});

describe("agreementReport and the board line", () => {
  const row = (patch: Partial<JevWatchRow>): JevWatchRow => ({
    taskId: "t",
    projectId: "p",
    askedAt: 0,
    model: null,
    latencyMs: 100,
    error: null,
    jevKind: "build",
    jevKindTop: 0.9,
    jevKindMargin: 0.8,
    jevTier: "small",
    jevTierTop: 0.6,
    jevTierMargin: 0.3,
    actualKind: "build",
    actualTier: "small",
    actualAt: 1,
    ...patch,
  });

  it("is hidden with no rows", () => {
    expect(reportLine(agreementReport([]))).toBeNull();
  });
  it("counts agreement, confusion, risky misses, errors and latency", () => {
    const report = agreementReport([
      row({ latencyMs: 100 }),
      row({ actualTier: "large", latencyMs: 300 }),
      row({ jevKind: "research", jevTier: "medium", latencyMs: 200 }),
      row({ actualKind: null, actualTier: null, actualAt: null, latencyMs: 400 }),
      row({ jevKind: null, jevTier: null, error: "timeout: no answer in 2000 ms", latencyMs: 2000 }),
    ]);
    expect(report).toMatchObject({ rows: 5, open: 1, riskyMiss: 1, errors: 1, timeouts: 1, p50LatencyMs: 300 });
    expect(report.kind).toMatchObject({ compared: 3, agree: 2, errors: 1, timeouts: 1 });
    expect(report.kind.confusion).toEqual({ build: { build: 2 }, research: { build: 1 } });
    expect(report.tier).toMatchObject({ compared: 3, agree: 1 });
    expect(report.tier.confusion).toEqual({ small: { small: 1, large: 1 }, medium: { small: 1 } });
    expect(reportLine(report)).toBe("Jev (watch only): kind 2/3 agree · tier 1/3 · 1 risky miss · 1 error");
    expect(reportDetail(report)).toContain("nothing Jev answers changes");
  });
});

describe("askJev (host.ts jevAsk)", () => {
  afterEach(() => vi.useRealTimers());

  const io = (
    fetch: Parameters<typeof askJev>[0]["fetch"],
    state: string | null = UP,
    clients: string | null = CLIENTS,
    local: string | null = null,
  ) => ({
    readLocal: async () => local,
    readState: async () => state,
    readClients: async () => clients,
    fetch,
    now: () => Date.now(),
  });
  const task = { title: "T", brief: "B" };

  it("is off, with no network call, unless the box is up at https with our key", async () => {
    const fetch = vi.fn();
    for (const [state, clients] of [
      [null, CLIENTS],
      [UP, null],
      [JSON.stringify({ status: "down", baseUrl: "https://x.sslip.io" }), CLIENTS],
      [JSON.stringify({ status: "up", baseUrl: "http://x.sslip.io" }), CLIENTS],
      [JSON.stringify({ status: "up", baseUrl: "https://u:p@x.sslip.io" }), CLIENTS],
      [UP, "JEV_KEY_ACMESHOP=" + KEY],
      ["not json", CLIENTS],
    ] as const) {
      expect(await askJev(io(fetch, state, clients), task)).toEqual({ ok: false, kind: "off" });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(jevClientConfig(UP, CLIENTS)).toEqual({ baseUrl: "https://203-0-113-10.sslip.io", key: KEY, model: "anyjev-qwen3-8b" });
  });

  it("posts the questions with our key and reads the answer", async () => {
    const fetch = vi.fn(async () => ({ status: 200, text: async () => JSON.stringify(good) }));
    const reply = await askJev(io(fetch), task);
    expect(reply).toMatchObject({ ok: true, model: "anyjev-qwen3-8b", answers: { kind: { choice: "build" } } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe("https://203-0-113-10.sslip.io/v1/systemone");
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init.body).questions.tier.type).toBe("choice");
  });

  it("asks the local server before the box, the box when local.json is missing or invalid, else nothing", async () => {
    const answer = async () => ({ status: 200, text: async () => JSON.stringify(good) });
    const BAD_LOCAL = JSON.stringify({ baseUrl: "http://127.0.0.1:8765" });
    for (const [local, state, clients, url, authorization] of [
      [LOCAL, UP, CLIENTS, "http://127.0.0.1:8766/v1/systemone", undefined],
      [LOCAL, null, null, "http://127.0.0.1:8766/v1/systemone", undefined],
      [null, UP, CLIENTS, "https://203-0-113-10.sslip.io/v1/systemone", `Bearer ${KEY}`],
      [BAD_LOCAL, UP, CLIENTS, "https://203-0-113-10.sslip.io/v1/systemone", `Bearer ${KEY}`],
      [BAD_LOCAL, null, null, null, undefined],
      [null, null, null, null, undefined],
    ] as const) {
      const fetch = vi.fn(answer);
      const reply = await askJev(io(fetch, state, clients, local), task);
      if (url === null) {
        expect(reply).toEqual({ ok: false, kind: "off" });
        expect(fetch).not.toHaveBeenCalled();
        continue;
      }
      expect(reply).toMatchObject({ ok: true });
      expect(fetch).toHaveBeenCalledTimes(1);
      const [called, init] = fetch.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string; redirect: string }];
      expect(called).toBe(url);
      expect(init.headers.Authorization).toBe(authorization);
      expect("Authorization" in init.headers).toBe(authorization !== undefined);
      expect(init.redirect).toBe("error");
      expect(JSON.parse(init.body).model).toBe(url.startsWith("http://127.0.0.1") ? "typed-decisions" : "anyjev-qwen3-8b");
    }
  });

  it("falls through to the box when local.json cannot be read", async () => {
    const fetch = vi.fn(async () => ({ status: 200, text: async () => JSON.stringify(good) }));
    const broken = { ...io(fetch), readLocal: async () => Promise.reject(new Error("EACCES")) };
    expect(await askJev(broken, task)).toMatchObject({ ok: true });
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe("https://203-0-113-10.sslip.io/v1/systemone");
  });

  it("says down, with no row, when the local server refuses the connection", async () => {
    const refuse = async () => Promise.reject(refusedError());
    const reply = await askJev(io(refuse, null, null, LOCAL), task);
    expect(reply).toEqual({ ok: false, kind: "down" });
    expect(askRecord(reply)).toBeNull();
    const dual = async () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { errors: [{ code: "ECONNREFUSED" }] } }));
    expect(await askJev(io(dual, null, null, LOCAL), task)).toEqual({ ok: false, kind: "down" });
  });

  it("still records a refused connection to the box as an error", async () => {
    const reply = await askJev(io(async () => Promise.reject(refusedError())), task);
    expect(reply).toMatchObject({ ok: false, kind: "error", error: "network (TypeError)" });
    expect(askRecord(reply)).toMatchObject({ error: "error: network (TypeError)" });
  });

  it("still records every other local failure", async () => {
    const reset = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
    for (const [fetch, error] of [
      [async () => Promise.reject(reset), "error: network (TypeError)"],
      [async () => Promise.reject(new Error("boom")), "error: network (Error)"],
      [async () => ({ status: 503, text: async () => "loading" }), "error: HTTP 503"],
      [async () => ({ status: 200, text: async () => "<html>" }), "error: not JSON"],
    ] as const) {
      expect(askRecord(await askJev(io(fetch, null, null, LOCAL), task))).toMatchObject({ error });
    }
  });

  it("still records a local timeout, even when the abort surfaces as a refused connection", async () => {
    vi.useFakeTimers();
    const hang = (_url: string, init: { signal: AbortSignal }) =>
      new Promise<never>((_, reject) => init.signal.addEventListener("abort", () => reject(refusedError())));
    const pending = askJev(io(hang, null, null, LOCAL), task);
    await vi.advanceTimersByTimeAsync(JEV_TIMEOUT_MS);
    const reply = await pending;
    expect(reply).toMatchObject({ ok: false, kind: "timeout" });
    expect(askRecord(reply)).toMatchObject({ error: `timeout: no answer in ${JEV_TIMEOUT_MS} ms` });
  });

  it("gives up at JEV_TIMEOUT_MS, body included, and says timeout", async () => {
    vi.useFakeTimers();
    const hang = (_url: string, init: { signal: AbortSignal }) =>
      new Promise<never>((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const slowBody = async (_url: string, init: { signal: AbortSignal }) => ({ status: 200, text: () => hang(_url, init) });
    for (const fetch of [hang, slowBody]) {
      const pending = askJev(io(fetch), task);
      await vi.advanceTimersByTimeAsync(JEV_TIMEOUT_MS);
      expect(await pending).toMatchObject({ ok: false, kind: "timeout" });
    }
  });

  it("never throws and never puts the response body in an error", async () => {
    const body = "SECRET-BODY-TEXT";
    const cases = [
      async () => ({ status: 500, text: async () => body }),
      async () => ({ status: 200, text: async () => body }),
      async () => ({ status: 200, text: async () => JSON.stringify({ answers: { kind: { type: body }, tier: body } }) }),
      async () => {
        throw new Error(body);
      },
    ];
    for (const fetch of cases) {
      const reply = await askJev(io(fetch), task);
      const record = askRecord(reply);
      expect(JSON.stringify(reply)).not.toContain(body);
      expect(record?.error ?? "").not.toContain(body);
      expect(record?.error).not.toBeNull();
    }
  });
});

describe("server.ts only watches", () => {
  const server = readFileSync(join(here, "server.ts"), "utf8");
  const code = server
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/**"));

  it("uses Jev only to ask in the background, store the answer and report it", () => {
    const allowed = [
      /^import \{ JEV_TIMEOUT_MS, agreementReport, askRecord, failedAsk, shouldCall, type JevAskReply \} from "\.\/jevwatch\.js";$/,
      /^const jevQuestionReportSchema = z\.object\(\{$/,
      /^const jevReportSchema = z\.object\(\{$/,
      /^(kind|tier): jevQuestionReportSchema,$/,
      /^jevWatch: z\.array\(z\.object\(\{ projectId: z\.string\(\), report: jevReportSchema \}\)\),$/,
      /^void jevWatchTask\(task, [^;]+\);$/,
      /^let jevFailedAt: number \| null = null;$/,
      /^async function jevWatchTask\(task: Task, hostId: string \| null\) \{$/,
      /^if \(hostId === null \|\| !shouldCall\(askedAt, jevFailedAt\)\) return;$/,
      /^let reply: JevAskReply;$/,
      /^"jevAsk",$/,
      /^\{ hostId, timeoutMs: JEV_TIMEOUT_MS \+ 500 \},$/,
      /^const record = askRecord\(reply\);$/,
      /^if \(failedAsk\(record\)\) jevFailedAt = askedAt;$/,
      /^store\.recordJevAsk\(\{ taskId: task\.id, projectId: task\.projectId, askedAt, \.\.\.record \}\);$/,
      /^bb\.log\.info\(`\$\{task\.id\}: Jev watch skipped \(\$\{describeError\(error\)\}\)\.`\);$/,
      /^jevWatch: own$/,
      /^\.map\(\(project\) => \(\{ projectId: project\.id, report: agreementReport\(store\.listJevWatch\(project\.id\)\) \}\)\)$/,
    ];
    const jevLines = code.filter((line) => /jev|askRecord|failedAsk|agreementReport|shouldCall/i.test(line));
    expect(jevLines.filter((line) => !allowed.some((pattern) => pattern.test(line)))).toEqual([]);
    expect(jevLines.filter((line) => line.startsWith("void jevWatchTask("))).toHaveLength(2);
    expect(server).not.toMatch(/await\s+jevWatchTask/);
  });

  it("reads the answer nowhere but askRecord, and the record only to store it", () => {
    const start = server.indexOf("async function jevWatchTask(");
    const body = server.slice(start, server.indexOf("\n  }\n", start));
    const uses = (name: string) => body.split("\n").filter((line) => new RegExp(`\\b${name}\\b`).test(line)).map((line) => line.trim());
    expect(uses("reply")).toEqual([
      "let reply: JevAskReply;",
      "reply = await host.call(",
      expect.stringMatching(/^reply = \{ ok: false, kind: "error"/),
      "const record = askRecord(reply);",
    ]);
    expect(uses("record")).toEqual([
      "const record = askRecord(reply);",
      "if (record === null) return;",
      "if (failedAsk(record)) jevFailedAt = askedAt;",
      "store.recordJevAsk({ taskId: task.id, projectId: task.projectId, askedAt, ...record });",
    ]);
  });
});
