// The real Headroom (the pinned version, installed where headroom.ts puts it)
// between a Claude Code-shaped request and a stub that answers like Anthropic.
// The rule it checks: what Claude Code sends reaches Anthropic byte-identical
// (every message, tool results and user text included, and the tools list),
// with no tool added and no CCR marker. Headroom 0.39.1 still rewrites the
// tools list with the strictest flags it has, so headroom.ts keeps it off for
// good (OFF_FOR_GOOD); this test says so, and fails the day a pinned version
// stops doing it, so that call gets made again.
//
// The stub stands in for api.anthropic.com itself: Headroom is told the
// upstream is http://api.anthropic.com:<stub port> with the stub as its HTTP
// proxy, so it behaves as it does in front of the real API (server-side tool
// search, for one, only happens there) and nothing leaves the machine.
//
// Skipped where Headroom is not installed. Where it is, it must run: the
// sandbox has no network, so Headroom gets the tokenizer file its own venv
// ships and the Hugging Face cache read-only, offline. Without the tokenizer
// it fails open and passes everything through, which would pass for the
// wrong reason; the control test catches that.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { HEADROOM_HOST, OFF_FOR_GOOD, SAFETY_ENV, SAFETY_FLAGS, headroomArgs, headroomPaths, runEnv } from "./headroom";
import { startRelay } from "./headroomrelay";

const paths = headroomPaths(homedir());
const TIKTOKEN_DIR = join(paths.venv, "lib", "python3.12", "site-packages", "litellm", "litellm_core_utils", "tokenizers");
const installed = existsSync(paths.bin) && existsSync(TIKTOKEN_DIR);
const MARKERS = ["headroom_retrieve", "Retrieve more", "elided", "<<ccr"];

// ------------------------------------------------------------------ the request

function failingTestLog(): string {
  const lines: string[] = [" RUN  v3.2.4 /Users/dev/app", ""];
  for (let i = 0; i < 40; i += 1) lines.push(` ✓ src/module${i}.test.ts (${(i % 7) + 3} tests) ${10 + i}ms`);
  for (let f = 0; f < 6; f += 1) {
    lines.push(` ❯ src/feature${f}.test.ts (12 tests | 2 failed) 341ms`, `   × feature${f} > computes the total when the cart has ${f} items 12ms`, "     → expected 4200 to be 4300 // Object.is equality");
  }
  lines.push("", "⎯⎯⎯⎯⎯⎯⎯ Failed Tests 12 ⎯⎯⎯⎯⎯⎯⎯", "");
  for (let f = 0; f < 6; f += 1) {
    lines.push(` FAIL  src/feature${f}.test.ts > feature${f} > computes the total when the cart has ${f} items`);
    lines.push("AssertionError: expected 4200 to be 4300 // Object.is equality", "", "- Expected", "+ Received", "", "- 4300", "+ 4200", "");
    for (let s = 0; s < 8; s += 1) lines.push(` ❯ src/feature${f}.test.ts:${40 + s}:${12 + s}`);
    for (let s = 0; s < 6; s += 1) lines.push(`    at processTicksAndRejections (node:internal/process/task_queues:${95 + s}:5)`);
    lines.push(`     ${38 + f}|   it("computes the total", () => {`, `     ${39 + f}|     const cart = makeCart(${f});`, `     ${40 + f}|     expect(total(cart)).toBe(4300);`, "       |                         ^", "");
  }
  let base64 = "";
  let x = 12_345;
  while (base64.length < 3000) {
    x = (x * 1_103_515_245 + 12_345) % 2_147_483_648;
    base64 += "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"[x % 64];
  }
  lines.push("stderr | src/snapshot.test.ts > renders the image", `data:image/png;base64,${base64}`, "");
  lines.push(`var e=function(t){return t&&t.__esModule?t:{default:t}};${Array.from({ length: 60 }, (_, i) => `function a${i}(n){return n*${i}+e(${i}).default}`).join(";")}`);
  for (let i = 0; i < 30; i += 1) lines.push("(node:12345) Warning: An update to Cart inside a test was not wrapped in act(...).");
  lines.push("", "diff --git a/src/total.ts b/src/total.ts", "index 1a2b3c4..5d6e7f8 100644", "--- a/src/total.ts", "+++ b/src/total.ts", "@@ -10,12 +10,14 @@ export function total(cart: Cart): number {");
  for (let i = 0; i < 40; i += 1) {
    lines.push(i % 5 === 0 ? `-  const line${i} = cart.items[${i}].price * 100;` : i % 5 === 1 ? `+  const line${i} = Math.round(cart.items[${i}].price * 100);` : `   // unchanged context line ${i}: the rounding rule for cents`);
  }
  lines.push("", " Test Files  6 failed | 40 passed (46)", "      Tests  12 failed | 212 passed (224)", "   Duration  8.93s (transform 1.2s, setup 0ms, collect 4.1s, tests 3.3s)", "");
  return lines.join("\n");
}

const grepOutput = () =>
  Array.from({ length: 300 }, (_, i) => `src/area${i % 12}/file${i}.ts:${((i * 7) % 400) + 1}:  const value${i} = computeThing(input${i}, { retries: ${i % 4}, mode: "fast" });`).join("\n");

const jsonOutput = () =>
  JSON.stringify(Array.from({ length: 150 }, (_, i) => ({ id: i, name: `item-${i}`, status: i % 9 === 0 ? "failed" : "ok", durationMs: 100 + (i % 13), tags: ["ci", "unit"] })), null, 2);

function agentReport(): string {
  const lines = ["## Report from the verifier", "", "I checked every claim against the repo. In order:"];
  for (let i = 0; i < 60; i += 1) {
    lines.push(`${i + 1}. The check in src/guard${i}.ts at line ${i * 3 + 7} refuses when the threshold is 0.7→0.6; I ran \`npm test -- guard${i}\` and it passed 52/52 with $TMPDIR set, so the earlier claim holds only for the stopped case.`);
  }
  lines.push("", "Not verified: the browser flow; builders have no browser.");
  return lines.join("\n");
}

type Block = Record<string, unknown>;
type Message = { role: "user" | "assistant"; content: Block[] };
type Request = { model: string; max_tokens: number; stream: boolean; system: Block[]; tools: Block[]; messages: Message[]; metadata: Block };

const TOOLS: Block[] = [
  {
    name: "Bash",
    description: `Executes a given bash command and returns its output.\n\nUsage notes:\n${"  - Prefer the dedicated tools.\n".repeat(30)}`,
    input_schema: { type: "object", properties: { command: { type: "string", description: "The command to execute" }, timeout: { type: "number" } }, required: ["command"], additionalProperties: false, $schema: "http://json-schema.org/draft-07/schema#" },
  },
  { name: "Read", description: `Reads a file from the local filesystem.\n\n${"It returns lines with numbers.\n".repeat(20)}`, input_schema: { type: "object", properties: { file_path: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } }, required: ["file_path"] } },
  { name: "Grep", description: "Searches file contents with ripgrep.", input_schema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] } },
  { name: "ToolSearch", description: "Fetches full schema definitions for deferred tools.", input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "mcp__orchestrator__task_status", description: "The task's dossier state: claims, builds, asks.", input_schema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] } },
  // Claude Code sends dozens: Headroom leaves a short list alone.
  ...Array.from({ length: 30 }, (_, i) => ({
    name: `mcp__server${i % 4}__action_${i}`,
    description: `Does action ${i} on the server. `.repeat(12),
    input_schema: { type: "object", properties: { id: { type: "string", description: "The id" }, options: { type: "object", properties: { force: { type: "boolean" } } } }, required: ["id"] },
  })),
];

const toolCall = (id: string, name: string, input: Block): Message => ({ role: "assistant", content: [{ type: "text", text: "Running it." }, { type: "tool_use", id, name, input }] });
const toolResult = (id: string, text: string): Block => ({ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], is_error: false });

/** Claude Code's shape: a tool search that loaded an MCP tool (a tool_reference), then tool calls and their results. */
function history(): Message[] {
  return [
    { role: "user", content: [{ type: "text", text: "Run the tests and tell me what fails." }] },
    toolCall("toolu_01search", "ToolSearch", { query: "select:mcp__orchestrator__task_status" }),
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01search", content: [{ type: "tool_reference", tool_name: "mcp__orchestrator__task_status" }] }] },
    toolCall("toolu_02grep", "Grep", { pattern: "computeThing" }),
    { role: "user", content: [toolResult("toolu_02grep", grepOutput())] },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_03json", name: "Bash", input: { command: "npx vitest --reporter=json" } }, { type: "tool_use", id: "toolu_04test", name: "Bash", input: { command: "npm test" } }] },
  ];
}

/** The newest block carries Claude Code's cache breakpoint. */
function request(messages: Message[], stream = false): Request {
  const copy = structuredClone(messages);
  const last = copy[copy.length - 1]!.content;
  last[last.length - 1] = { ...last[last.length - 1], cache_control: { type: "ephemeral" } };
  return {
    model: "claude-opus-5-5",
    max_tokens: 32_000,
    stream,
    system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } }, { type: "text", text: "Instructions. ".repeat(200) }],
    tools: TOOLS,
    messages: copy,
    metadata: { user_id: "user_abc_account_def_session_ghi" },
  };
}

const testRun = (): Message => ({ role: "user", content: [toolResult("toolu_03json", jsonOutput()), toolResult("toolu_04test", failingTestLog())] });
const report = (): Message => ({ role: "user", content: [{ type: "text", text: agentReport() }] });

/** The parts of `got` that differ from `sent`: "tools", "system", "messages[i]". */
function changed(sent: Request, got: Request): string[] {
  const out: string[] = [];
  if (JSON.stringify(got.tools) !== JSON.stringify(sent.tools)) out.push("tools");
  if (JSON.stringify(got.system) !== JSON.stringify(sent.system)) out.push("system");
  for (let i = 0; i < Math.max(sent.messages.length, got.messages.length); i += 1) {
    if (JSON.stringify(got.messages[i]) !== JSON.stringify(sent.messages[i])) out.push(`messages[${i}]`);
  }
  return out;
}

// ------------------------------------------------------------------ the stub Anthropic

type Seen = { headers: IncomingHttpHeaders; body: string };

/** Anthropic's own check: every tool_use and tool_reference names a tool in the request's tools. */
function unknownToolReference(body: Request): string | null {
  const names = new Set(body.tools.map((tool) => tool.name));
  for (const message of body.messages) {
    for (const block of message.content) {
      if (block.type === "tool_use" && !names.has(block.name)) return `Tool reference '${String(block.name)}' not found in available tools`;
      if (block.type === "tool_result" && Array.isArray(block.content)) {
        for (const inner of block.content as Block[]) {
          if (inner.type === "tool_reference" && !names.has(inner.tool_name)) return `Tool reference '${String(inner.tool_name)}' not found in available tools`;
        }
      }
    }
  }
  return null;
}

const REPLY = { id: "msg_stub", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "toolu_05fix", name: "Bash", input: { command: "npm test -- feature0" } }], stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } };

function sse(): string {
  const event = (type: string, data: Block) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  return [
    event("message_start", { message: { ...REPLY, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }),
    event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Twelve tests fail." } }),
    event("content_block_stop", { index: 0 }),
    event("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } }),
    event("message_stop", {}),
  ].join("");
}

async function startStub(): Promise<{ server: Server; port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      // As Headroom's HTTP proxy it is asked for the absolute URL.
      const path = new URL(req.url ?? "/", "http://stub").pathname;
      if (req.method !== "POST" || path !== "/v1/messages") {
        res.writeHead(404).end();
        return;
      }
      seen.push({ headers: req.headers, body });
      const parsed = JSON.parse(body) as Request;
      const problem = unknownToolReference(parsed);
      if (problem !== null) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: problem } }));
        return;
      }
      if (parsed.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.end(sse());
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(REPLY));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { server, port: typeof address === "object" && address !== null ? address.port : 0, seen };
}

// ------------------------------------------------------------------ the real Headroom

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

type Running = { port: number; child: ChildProcess; home: string; log: () => string; stop: () => Promise<void> };
const started: Running[] = [];

/**
 * Headroom on a spare port with `args` (headroomArgs, or a variant) and
 * runEnv's environment (`safe: false` drops SAFETY_ENV), the stub as Anthropic.
 */
async function startHeadroom(args: string[], stubPort: number, safe = true): Promise<Running> {
  const port = Number(args[args.indexOf("--port") + 1]);
  const home = mkdtempSync(join(tmpdir(), "headroom-test-"));
  const env = runEnv({
    PATH: process.env.PATH,
    HOME: home,
    HF_HOME: join(homedir(), ".cache", "huggingface"),
    HF_HUB_OFFLINE: "1",
    TIKTOKEN_CACHE_DIR: TIKTOKEN_DIR,
  });
  if (!safe) for (const key of Object.keys(SAFETY_ENV)) delete env[key];
  const upstream = ["--anthropic-api-url", `http://api.anthropic.com:${stubPort}`, "--http-proxy", `http://127.0.0.1:${stubPort}`];
  const child = spawn(paths.bin, [...args, ...upstream], { cwd: home, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout?.on("data", (chunk: Buffer) => (log = (log + chunk.toString()).slice(-200_000)));
  child.stderr?.on("data", (chunk: Buffer) => (log = (log + chunk.toString()).slice(-200_000)));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const running: Running = {
    port,
    child,
    home,
    log: () => log,
    // Only the process group of the pid this test spawned.
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
        await exited;
      }
      rmSync(home, { recursive: true, force: true });
    },
  };
  started.push(running);
  for (let waited = 0; waited < 90_000; waited += 250) {
    if (child.exitCode !== null) throw new Error(`Headroom exited ${child.exitCode}:\n${log.slice(-3000)}`);
    const health = await fetch(`http://${HEADROOM_HOST}:${port}/health`).then((r) => (r.ok ? r.json() : null), () => null);
    if ((health as { checks?: { startup?: { ready?: boolean } } } | null)?.checks?.startup?.ready === true) return running;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Headroom did not come up:\n${log.slice(-3000)}`);
}

async function post(port: number, body: Request): Promise<{ status: number; headers: Headers; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-ant-test", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

/** Headroom answers as uvicorn; the stub names no server. */
const throughHeadroom = (headers: Headers) => headers.get("server") === "uvicorn";

describe.skipIf(!installed)("the real Headroom between Claude Code and Anthropic", () => {
  let stub: Awaited<ReturnType<typeof startStub>>;
  let headroom: Running;

  beforeAll(async () => {
    stub = await startStub();
    headroom = await startHeadroom(headroomArgs(await freePort()), stub.port);
  }, 120_000);

  afterAll(async () => {
    for (const running of started) await running.stop();
    await new Promise<void>((resolve) => stub?.server.close(() => resolve()));
  });

  /** Send through Headroom; what the stub received, and what changed. */
  async function roundTrip(sent: Request): Promise<{ got: Request; raw: string; changes: string[] }> {
    const before = stub.seen.length;
    const reply = await post(headroom.port, sent);
    expect(reply.status, reply.text.slice(0, 500)).toBe(200);
    expect(stub.seen.length).toBe(before + 1);
    const raw = stub.seen[stub.seen.length - 1]!.body;
    const got = JSON.parse(raw) as Request;
    return { got, raw, changes: changed(sent, got) };
  }

  function expectUntouched(sent: Request, got: Request, raw: string, changes: string[]) {
    for (const marker of MARKERS) expect(raw, marker).not.toContain(marker);
    expect(got.tools.map((tool) => tool.name).sort()).toEqual(sent.tools.map((tool) => tool.name).sort());
    // Every message, tool results and user text included, byte for byte.
    expect(changes.filter((part) => part !== "tools")).toEqual([]);
    if (OFF_FOR_GOOD === null) expect(changes).toEqual([]);
    // Off for good because of this: it still rewrites the tools list. When it stops, revisit OFF_FOR_GOOD.
    else expect(changes).toEqual(["tools"]);
  }

  it("control: with Headroom's own defaults the same request has its log changed and a tool added (so a pass below is not Headroom failing open)", async () => {
    const control = await startHeadroom(["proxy", "--host", HEADROOM_HOST, "--port", String(await freePort()), "--mode", "cache"], stub.port, false);
    const sent = request([...history(), testRun()]);
    const reply = await post(control.port, sent);
    expect(reply.status).toBe(200);
    const got = JSON.parse(stub.seen[stub.seen.length - 1]!.body) as Request;
    expect(changed(sent, got)).toContain(`messages[${sent.messages.length - 1}]`);
    // Server-side tool search: one tool more, the rest deferred. A tool_reference the API hands back can name any of them.
    expect(got.tools.length).toBe(sent.tools.length + 1);
    expect(got.tools.some((tool) => tool.defer_loading === true)).toBe(true);
    await control.stop();
  }, 120_000);

  it("a failing-test log comes back byte-identical", async () => {
    const first = request([...history(), testRun()]);
    const one = await roundTrip(first);
    expectUntouched(first, one.got, one.raw, one.changes);

    // The history grows: the reply, then an agent's report.
    const second = request([...history(), testRun(), { role: "assistant", content: [REPLY.content[0]!] }, { role: "user", content: [toolResult("toolu_05fix", failingTestLog())] }, { role: "assistant", content: [{ type: "text", text: "Fixed; here is the report." }] }, report()]);
    const two = await roundTrip(second);
    expectUntouched(second, two.got, two.raw, two.changes);

    // Streaming.
    const streamed = request([...history(), testRun()], true);
    const three = await roundTrip(streamed);
    expectUntouched(streamed, three.got, three.raw, three.changes);
  }, 120_000);

  it("a turn through Headroom still works after Headroom stops", async () => {
    // Anthropic's check bites: the incident's 400.
    const jammed = request([...history(), testRun()]);
    jammed.messages[2]!.content = [{ type: "tool_result", tool_use_id: "toolu_01search", content: [{ type: "tool_reference", tool_name: "headroom_retrieve" }] }];
    expect(await post(stub.port, jammed)).toMatchObject({ status: 400, text: expect.stringContaining("Tool reference 'headroom_retrieve' not found in available tools") });

    const relay = await startRelay({ host: "127.0.0.1", port: 0, headroomPort: headroom.port, direct: { protocol: "http:", host: "127.0.0.1", port: stub.port } });
    try {
      for (let waited = 0; relay.upstream() !== "headroom" && waited < 10_000; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
      expect(relay.upstream()).toBe("headroom");

      const turn1 = request([...history(), testRun()]);
      const one = await post(relay.port, turn1);
      expect(one.status, one.text.slice(0, 500)).toBe(200);
      expect(throughHeadroom(one.headers)).toBe(true);
      const sentOn = JSON.parse(stub.seen[stub.seen.length - 1]!.body) as Request;
      expect(sentOn.tools.map((tool) => tool.name).sort()).toEqual(TOOLS.map((tool) => tool.name).sort());
      expect(sentOn.tools.some((tool) => "defer_loading" in tool)).toBe(false);

      await headroom.stop();

      const reply = JSON.parse(one.text) as typeof REPLY;
      const turn2 = request([...history(), testRun(), { role: "assistant", content: reply.content }, { role: "user", content: [toolResult("toolu_05fix", failingTestLog())] }]);
      const two = await post(relay.port, turn2);
      expect(two.status, two.text.slice(0, 500)).toBe(200);
      expect(throughHeadroom(two.headers)).toBe(false);
      expect(changed(turn2, JSON.parse(stub.seen[stub.seen.length - 1]!.body) as Request)).toEqual([]);
    } finally {
      await relay.close();
    }
  }, 120_000);

  it("pins the flags it ran with", () => {
    expect(headroomArgs(1).slice(-SAFETY_FLAGS.length)).toEqual([...SAFETY_FLAGS]);
  });
});
