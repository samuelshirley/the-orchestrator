import { describe, expect, it } from "vitest";
import {
  ACTIVITY_IDLE_POLL_MS,
  ACTIVITY_POLL_MS,
  COMMAND_CHARS,
  MAX_LINES,
  MAX_PANES,
  MESSAGE_CHARS,
  OUTPUT_TAIL_CHARS,
  OUTPUT_TAIL_LINES,
  activityLines,
  activityPollMs,
  outputTail,
  redact,
  relativePath,
  unreadableLine,
  whichThreads,
  type ActivityEvent,
} from "./activity";

const ROOT = "/Users/me/Github/app/.claude/worktrees/fix";
const LABEL = { pending: "Running command", completed: "Ran command" };

let seq = 0;
const event = (type: string, item: Record<string, unknown>, at = 1000): ActivityEvent => ({
  seq: ++seq,
  type,
  createdAt: at + seq,
  data: { item },
});
const started = (item: Record<string, unknown>) => event("item/started", { status: "pending", ...item });
const completed = (item: Record<string, unknown>) => event("item/completed", { status: "completed", ...item });
const command = (id: string, text: string) => ({ type: "commandExecution", id, command: text, cwd: "", presentation: { label: LABEL, title: text } });

describe("activityLines", () => {
  it("shows a pending command as running, with no output yet", () => {
    const lines = activityLines([started(command("i1", "npm test"))], { root: ROOT });
    expect(lines).toEqual([expect.objectContaining({ id: "i1", kind: "command", text: "$ npm test", output: null, running: true })]);
  });

  it("merges started and completed into one line, whatever order they arrive in", () => {
    const begin = started(command("i1", "npm test"));
    const end = completed({ ...command("i1", "npm test"), aggregatedOutput: "12 passed\n", exitCode: 0 });
    for (const events of [[begin, end], [end, begin]]) {
      const lines = activityLines(events, { root: ROOT });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ id: "i1", text: "$ npm test", output: "12 passed", running: false, at: end.createdAt });
    }
  });

  it("says a failed command's exit code", () => {
    const [line] = activityLines([completed({ ...command("i1", "false"), aggregatedOutput: "", exitCode: 2 })], { root: ROOT });
    expect(line.output).toBe("exit 2");
  });

  it("orders lines by when each item started, newest last", () => {
    const a = started(command("a", "first"));
    const b = started({ type: "fileRead", id: "b", path: `${ROOT}/src/x.ts` });
    const aDone = completed({ ...command("a", "first"), aggregatedOutput: "ok" });
    const lines = activityLines([aDone, b, a], { root: ROOT });
    expect(lines.map((line) => line.id)).toEqual(["a", "b"]);
  });

  it("shows reads, edits and writes with paths relative to the root", () => {
    const lines = activityLines(
      [
        completed({ type: "fileRead", id: "r", path: `${ROOT}/src/auth.ts` }),
        completed({
          type: "fileChange",
          id: "c",
          changes: [
            { path: `${ROOT}/src/auth.ts`, kind: "update", diff: "+secret" },
            { path: `${ROOT}/src/new.ts`, kind: "add", diff: "" },
          ],
        }),
        completed({ type: "fileRead", id: "o", path: "/etc/hosts" }),
      ],
      { root: ROOT },
    );
    expect(lines.map((line) => [line.kind, line.text])).toEqual([
      ["read", "read src/auth.ts"],
      ["edit", "edit src/auth.ts\nwrite src/new.ts"],
      ["read", "read /etc/hosts"],
    ]);
  });

  it("shows a tool call by its own name and title, without the server prefix", () => {
    const [line] = activityLines(
      [completed({ type: "toolCall", id: "t", tool: "mcp__bb-bridge__task_status", presentation: { label: "x", title: "task_1" } })],
      { root: null },
    );
    expect(line).toMatchObject({ kind: "tool", text: "task_status task_1" });
  });

  it("leaves out suppressed items, reasoning and a message with no text yet", () => {
    const lines = activityLines(
      [
        completed({ type: "toolCall", id: "s", tool: "ToolSearch", presentation: { label: LABEL, title: "q", suppress: true } }),
        completed({ type: "reasoning", id: "r", content: ["thinking"] }),
        started({ type: "agentMessage", id: "m", text: "" }),
      ],
      { root: ROOT },
    );
    expect(lines).toEqual([]);
  });

  it("shows the start of an assistant message", () => {
    const [line] = activityLines([completed({ type: "agentMessage", id: "m", text: "x".repeat(MESSAGE_CHARS + 50) })], { root: ROOT });
    expect(line.kind).toBe("message");
    expect(line.text).toBe(`${"x".repeat(MESSAGE_CHARS)}…`);
  });

  it("falls back to the label and title for an unknown item type, and never throws on odd shapes", () => {
    const lines = activityLines(
      [
        started({ type: "backgroundTask", id: "b", presentation: { label: { pending: "Running background command", completed: "Done" }, title: "Run tests" } }),
        completed({ type: "somethingNew", id: "n" }),
        completed({ type: "commandExecution", id: "odd", command: 7 }),
        { seq: ++seq, type: "item/completed", createdAt: 1, data: null },
        { seq: ++seq, type: "item/completed", createdAt: 1, data: { item: { type: "fileRead" } } },
        { seq: ++seq, type: "turn/completed", createdAt: 1, data: { item: { id: "z", type: "fileRead", path: "/a" } } },
      ],
      { root: ROOT },
    );
    expect(lines.map((line) => [line.kind, line.text, line.running])).toEqual([
      ["other", "Running background command Run tests", true],
      ["other", "somethingNew", false],
      ["command", "commandExecution", false],
    ]);
  });

  it("counts a background task's own completed event", () => {
    const item = { type: "backgroundTask", id: "b", presentation: { label: { pending: "Running", completed: "Finished" }, title: "tests" } };
    const lines = activityLines([started(item), event("item/backgroundTask/completed", { ...item, status: "completed" })], { root: ROOT });
    expect(lines).toEqual([expect.objectContaining({ text: "Finished tests", running: false })]);
  });

  it("marks nothing running in a thread that is not working", () => {
    const [line] = activityLines([started(command("i1", "sleep 100"))], { root: ROOT, working: false });
    expect(line.running).toBe(false);
  });

  it("keeps the newest MAX_LINES", () => {
    const events = Array.from({ length: MAX_LINES + 5 }, (_, index) => completed({ type: "fileRead", id: `f${index}`, path: `/f${index}` }));
    const lines = activityLines(events, { root: ROOT });
    expect(lines).toHaveLength(MAX_LINES);
    expect(lines[0].id).toBe("f5");
    expect(lines[MAX_LINES - 1].id).toBe(`f${MAX_LINES + 4}`);
  });

  it("caps a long command", () => {
    const [line] = activityLines([started(command("i1", "a".repeat(COMMAND_CHARS + 10)))], { root: ROOT });
    expect(line.text).toBe(`$ ${"a".repeat(COMMAND_CHARS)}…`);
  });

  it("masks secrets in commands, output and messages", () => {
    const lines = activityLines(
      [
        completed({ ...command("c", "API_KEY=abc123 npm run deploy"), aggregatedOutput: "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload\nok" }),
        completed({ type: "agentMessage", id: "m", text: "The key is ghp_abcdefghijklmnop1234 so I set it." }),
      ],
      { root: ROOT },
    );
    expect(lines[0].text).toBe("$ API_KEY=••• npm run deploy");
    expect(lines[0].output).toBe("Authorization: Bearer •••\nok");
    expect(lines[1].text).toBe("The key is ••• so I set it.");
  });
});

describe("outputTail", () => {
  it("leaves short output as it is, without trailing blank lines or colour codes", () => {
    expect(outputTail("one\n\u001b[32mtwo\u001b[0m\n\n")).toBe("one\ntwo");
    expect(outputTail("")).toBe("");
  });

  it("keeps the last OUTPUT_TAIL_LINES lines and says how many were cut", () => {
    const output = Array.from({ length: OUTPUT_TAIL_LINES + 3 }, (_, index) => `line ${index}`).join("\n");
    const tail = outputTail(output).split("\n");
    expect(tail[0]).toBe("… 3 earlier lines");
    expect(tail[1]).toBe("line 3");
    expect(tail).toHaveLength(OUTPUT_TAIL_LINES + 1);
    expect(outputTail(`a\n${output}`).split("\n")[0]).toBe("… 4 earlier lines");
  });

  it("says one earlier line in the singular", () => {
    const output = Array.from({ length: OUTPUT_TAIL_LINES + 1 }, (_, index) => `line ${index}`).join("\n");
    expect(outputTail(output).split("\n")[0]).toBe("… 1 earlier line");
  });

  it("keeps at most OUTPUT_TAIL_CHARS characters of lines", () => {
    const output = Array.from({ length: 10 }, (_, index) => `${index}${"x".repeat(999)}`).join("\n");
    const [first, ...rest] = outputTail(output).split("\n");
    expect(first).toBe("… 7 earlier lines");
    expect(rest.join("\n").length).toBeLessThanOrEqual(OUTPUT_TAIL_CHARS);
    expect(rest[rest.length - 1].startsWith("9")).toBe(true);
  });

  it("cuts one huge line to its end", () => {
    const tail = outputTail("y".repeat(OUTPUT_TAIL_CHARS * 2));
    expect(tail).toBe(`…${"y".repeat(OUTPUT_TAIL_CHARS)}`);
  });
});

describe("relativePath", () => {
  it("is relative inside the root and unchanged outside it", () => {
    expect(relativePath(`${ROOT}/a/b.ts`, ROOT)).toBe("a/b.ts");
    expect(relativePath(`${ROOT}/a/b.ts`, `${ROOT}/`)).toBe("a/b.ts");
    expect(relativePath(ROOT, ROOT)).toBe(".");
    expect(relativePath(`${ROOT}-other/a.ts`, ROOT)).toBe(`${ROOT}-other/a.ts`);
    expect(relativePath("/tmp/x", null)).toBe("/tmp/x");
  });
});

describe("redact", () => {
  it("masks the value of a secret-looking KEY=value", () => {
    expect(redact("BILLING_SECRET_KEY=sk_live_abc npm start")).toBe("BILLING_SECRET_KEY=••• npm start");
    expect(redact("export GITHUB_TOKEN='abc def'")).toBe("export GITHUB_TOKEN=•••");
    expect(redact('DB_PASSWORD="hunter2" PGPASSWD=x')).toBe("DB_PASSWORD=••• PGPASSWD=•••");
    expect(redact("apikey=123 API_KEY=456 private_key=789")).toBe("apikey=••• API_KEY=••• private_key=•••");
    expect(redact("DATABASE_URL=postgres://u:p@host/db")).toBe("DATABASE_URL=•••");
    expect(redact("NEXTAUTH_SECRET=abc\nAUTH_HEADER=xyz")).toBe("NEXTAUTH_SECRET=•••\nAUTH_HEADER=•••");
  });

  it("masks Bearer tokens", () => {
    expect(redact('curl -H "Authorization: Bearer abc.def-123_XYZ" https://x.dev')).toBe('curl -H "Authorization: Bearer •••" https://x.dev');
  });

  it("masks the password of a URL", () => {
    expect(redact("postgres://admin:s3cr3t@db.example.com:5432/app")).toBe("postgres://admin:•••@db.example.com:5432/app");
    expect(redact("git clone https://me:pw@github.com/a/b.git")).toBe("git clone https://me:•••@github.com/a/b.git");
  });

  it("masks known token prefixes", () => {
    expect(redact("key sk-ant-REDACTED done")).toBe("key ••• done");
    expect(redact("ghp_0123456789abcdef gho_0123456789abcdef")).toBe("••• •••");
    expect(redact("github_pat_11ABCDEFG0123456789")).toBe("•••");
    expect(redact("xoxb-1234567890-abcdef xoxp-1234567890-abc")).toBe("••• •••");
    expect(redact("id AKIAIOSFODNN7EXAMPLE")).toBe("id •••");
  });

  it("masks a private key block", () => {
    expect(redact("-----BEGIN RSA PRIVATE KEY-----\nMIIE\nabc\n-----END RSA PRIVATE KEY-----\nnext")).toBe("•••\nnext");
  });

  it("leaves ordinary output untouched", () => {
    const ordinary = [
      " ✓ activity.test.ts (24 tests) 8ms",
      "Author: Alex Example <alex@example.com>",
      "src/auth/token.ts:12:  const token = await issue(user);",
      "if (a == b && keys.length === 3) return;",
      "https://github.com/owner/repo/pull/12",
      "task-force risk-assessment sk-learn",
      "M  server.ts\n?? activity.ts",
      "PORT=3000 NODE_ENV=test npm run dev",
      "the bearer of the note",
    ].join("\n");
    expect(redact(ordinary)).toBe(ordinary);
  });
});

describe("whichThreads", () => {
  const thread = (threadId: string, working: boolean, lastActiveAt: number | null = null) => ({ threadId, working, lastActiveAt });

  it("picks the working threads, in order", () => {
    const picked = whichThreads([thread("task", false, 900), thread("research", true), thread("build", true)]);
    expect(picked.map((entry) => entry.threadId)).toEqual(["research", "build"]);
  });

  it("caps the panes at MAX_PANES", () => {
    const threads = Array.from({ length: MAX_PANES + 2 }, (_, index) => thread(`t${index}`, true));
    expect(whichThreads(threads)).toHaveLength(MAX_PANES);
  });

  it("with none working, picks the one most recently active", () => {
    const picked = whichThreads([thread("task", false, 100), thread("build", false, 300), thread("research", false, null)]);
    expect(picked.map((entry) => entry.threadId)).toEqual(["build"]);
  });

  it("with no activity time known, picks the first; with no threads, none", () => {
    expect(whichThreads([thread("task", false), thread("build", false)]).map((entry) => entry.threadId)).toEqual(["task"]);
    expect(whichThreads([])).toEqual([]);
  });
});

describe("polling and the unreadable pane", () => {
  it("asks often while something works, rarely when nothing does", () => {
    expect(activityPollMs(2)).toBe(ACTIVITY_POLL_MS);
    expect(activityPollMs(0)).toBe(ACTIVITY_IDLE_POLL_MS);
  });

  it("gives an unreadable thread one line saying so", () => {
    expect(unreadableLine(5)).toMatchObject({ kind: "other", running: false, at: 5, output: null });
    expect(unreadableLine(5).text).toMatch(/could not be read/);
  });
});
