import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { aiServicesHostContract as local, hostContract } from "./contract";

const METHODS = ["ai.inference.complete", "ai.voice.transcribe"] as const;
const CODES = [
  "timeout",
  "rate_limited",
  "service_unavailable",
  "auth_required",
  "request_failed",
  "invalid_response",
] as const;

const transcribeInput = {
  serviceId: "local",
  model: "apple",
  audioBase64: "AAAA",
  mimeType: "audio/webm",
  filename: "clip.webm",
  prompt: null,
  timeoutMs: 30_000,
};
const completeInput = {
  serviceId: "local",
  model: "apple",
  reasoningEffort: "none",
  prompt: "title this",
  outputSchema: { type: "object", properties: { title: { type: "string", enum: ["a", null, 1, true] } } },
  timeoutMs: 5_000,
};

const SAMPLES: Record<(typeof METHODS)[number], { input: unknown[]; output: unknown[] }> = {
  "ai.voice.transcribe": {
    input: [
      transcribeInput,
      { ...transcribeInput, prompt: "Patches" },
      { ...transcribeInput, prompt: undefined },
      { ...transcribeInput, audioBase64: "" },
      { ...transcribeInput, timeoutMs: 0 },
      { ...transcribeInput, timeoutMs: 1.5 },
      { ...transcribeInput, extra: 1 },
      { ...transcribeInput, filename: 3 },
    ],
    output: [
      { ok: true, model: "apple", text: "Hello from Patches" },
      { ok: true, model: "apple", text: "" },
      { ok: true, model: "", text: "x" },
      { ok: true, model: "apple", text: "x", extra: 1 },
      ...CODES.map((code) => ({ ok: false, code, message: "no" })),
      { ok: false, code: "timeout", message: "" },
      { ok: false, code: "nope", message: "no" },
    ],
  },
  "ai.inference.complete": {
    input: [
      completeInput,
      { ...completeInput, reasoningEffort: "low" },
      { ...completeInput, outputSchema: [] },
      { ...completeInput, outputSchema: { a: { b: [{ c: undefined }] } } },
      { ...completeInput, outputSchema: { a: () => 1 } },
      { ...completeInput, prompt: "" },
    ],
    output: [
      { ok: true, model: "m", value: { nested: { deep: [1, "two", null, { three: false }] } } },
      { ok: true, model: "m", value: "flat" },
      { ok: true, model: "m", value: {}, extra: 1 },
      ...CODES.map((code) => ({ ok: false, code, message: "no" })),
      { ok: false, code: "rate_limited" },
    ],
  },
};

describe("aiServicesHostContract", () => {
  it("has the two methods", () => {
    expect(Object.keys(local).sort()).toEqual([...METHODS]);
  });

  for (const method of METHODS) {
    for (const side of ["input", "output"] as const) {
      it(`${method} ${side}: accepts the first sample and refuses some`, () => {
        const verdicts = SAMPLES[method][side].map((sample) => local[method][side].safeParse(sample).success);
        expect(verdicts[0]).toBe(true);
        expect(verdicts.some((ok) => !ok)).toBe(true);
      });
    }
  }

  it("accepts a failure with every error code", () => {
    for (const method of METHODS) {
      for (const code of CODES) {
        expect(local[method].output.safeParse({ ok: false, code, message: "m" }).success).toBe(true);
      }
    }
  });
});

// bb's server runtime maps "@get-bb/plugin-sdk" to its own module and ships
// no subpaths: a runtime import of "@get-bb/plugin-sdk/<subpath>" in any file
// server.ts loads stops The Orchestrator loading at all (3793a2a). host.ts and
// memory-probe.ts run in the host worker, which resolves node_modules.
const HOST_ONLY = new Set(["host.ts", "memory-probe.ts", "vitest.config.ts"]);
const here = dirname(fileURLToPath(import.meta.url));

function serverFiles(): string[] {
  return readdirSync(here)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts") && !HOST_ONLY.has(f))
    .sort();
}

/** Every `import`/`export … from "@get-bb/plugin-sdk/<subpath>"` not wholly type-only. */
function runtimeSubpathImports(source: string): string[] {
  const statements = source.match(/^(?:import|export)\b[^;]*?from\s*["']@get-bb\/plugin-sdk\/[^"']+["']/gms) ?? [];
  return statements.filter((s) => !/^(?:import|export)\s+type\b/.test(s));
}

describe("no runtime SDK subpath import in the server bundle", () => {
  it("finds one when there is one", () => {
    expect(runtimeSubpathImports('import { x } from "@get-bb/plugin-sdk/ai-services";')).toHaveLength(1);
    expect(runtimeSubpathImports('import {\n  x,\n  type Y,\n} from "@get-bb/plugin-sdk/app";')).toHaveLength(1);
    expect(runtimeSubpathImports('export { x } from "@get-bb/plugin-sdk/host";')).toHaveLength(1);
    expect(runtimeSubpathImports('import type { X } from "@get-bb/plugin-sdk/app";')).toEqual([]);
    expect(runtimeSubpathImports('import { defineRpcContract } from "@get-bb/plugin-sdk";')).toEqual([]);
  });

  it("covers server.ts, contract.ts and voice.ts", () => {
    expect(serverFiles()).toEqual(expect.arrayContaining(["server.ts", "contract.ts", "voice.ts"]));
  });

  it("none of the files server.ts can load imports an SDK subpath at runtime", () => {
    const offenders = serverFiles().flatMap((f) =>
      runtimeSubpathImports(readFileSync(join(here, f), "utf8")).map((s) => `${f}: ${s}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe("prepareWorktree output", () => {
  const output = hostContract.prepareWorktree.output;
  it("requires the builder guard to be in place", () => {
    expect(output.safeParse({ copied: 1, unmatched: [], guarded: true }).success).toBe(true);
    expect(output.safeParse({ copied: 1, unmatched: [] }).success).toBe(false);
    expect(output.safeParse({ copied: 1, unmatched: [], guarded: false }).success).toBe(false);
  });
});

describe("prepareWorktree input", () => {
  const input = hostContract.prepareWorktree.input;
  const request = {
    repoPath: "/repo",
    worktreePath: "/repo/.claude/worktrees/x",
    pluginRoot: "/Users/me/Github/the-orchestrator",
    branch: "task/x",
    baseRef: "origin/main",
    include: [],
    productionEnv: false,
    reuse: false,
  };
  it("requires the plugin's source folder", () => {
    expect(input.safeParse(request).success).toBe(true);
    const { pluginRoot: _dropped, ...without } = request;
    expect(input.safeParse(without).success).toBe(false);
    expect(input.safeParse({ ...request, pluginRoot: "" }).success).toBe(false);
  });
  it("requires productionEnv: a caller that forgets it is refused, never defaulted", () => {
    expect(input.safeParse({ ...request, productionEnv: true }).success).toBe(true);
    const { productionEnv: _dropped, ...without } = request;
    expect(input.safeParse(without).success).toBe(false);
    expect(input.safeParse({ ...request, productionEnv: "false" }).success).toBe(false);
  });
});

describe("claudeSignIn", () => {
  const { input, output } = hostContract.claudeSignIn;
  it("takes nothing: no account, email or path can be passed in", () => {
    expect(input.safeParse({}).success).toBe(true);
    expect(input.safeParse({ email: "someone@example.com" }).success).toBe(false);
    expect(input.safeParse({ path: "/usr/bin/claude" }).success).toBe(false);
  });
  it("returns only ok and a short error, nothing the process printed", () => {
    expect(output.safeParse({ ok: true, error: null }).success).toBe(true);
    expect(output.safeParse({ ok: false, error: "Could not find the `claude` command." }).success).toBe(true);
    expect(output.safeParse({ ok: true }).success).toBe(false);
    expect(output.safeParse({ ok: true, error: null, output: "token" }).success).toBe(false);
    expect(output.safeParse({ ok: false, error: "x".repeat(201) }).success).toBe(false);
  });
});

describe("localConfig", () => {
  const { input, output } = hostContract.localConfig;
  it("takes nothing: no path can be passed in", () => {
    expect(input.safeParse({}).success).toBe(true);
    expect(input.safeParse({ path: "/etc/passwd" }).success).toBe(false);
  });
  it("returns the file's text or null, capped just past 200 KB", () => {
    expect(output.safeParse({ text: null }).success).toBe(true);
    expect(output.safeParse({ text: "{}" }).success).toBe(true);
    expect(output.safeParse({ text: "x".repeat(200_001) }).success).toBe(true);
    expect(output.safeParse({ text: "x".repeat(200_002) }).success).toBe(false);
    expect(output.safeParse({}).success).toBe(false);
    expect(output.safeParse({ text: null, path: "/Users/me" }).success).toBe(false);
  });
});

describe("the setup wizard's host calls", () => {
  it("setupFacts takes nothing and says home and both sign-ins", () => {
    const { input, output } = hostContract.setupFacts;
    expect(input.safeParse({}).success).toBe(true);
    expect(input.safeParse({ home: "/Users/other" }).success).toBe(false);
    const facts = { home: "/Users/me", gh: { state: "in", account: "octocat" }, claude: { state: "unknown", account: null } };
    expect(output.safeParse(facts).success).toBe(true);
    expect(output.safeParse({ ...facts, gh: { state: "maybe", account: null } }).success).toBe(false);
    expect(output.safeParse({ ...facts, token: "x" }).success).toBe(false);
    expect(output.safeParse({ ...facts, claude: { state: "in", account: null, token: "x" } }).success).toBe(false);
  });
  it("listRepos takes one folder and returns at most 200 entries", () => {
    const { input, output } = hostContract.listRepos;
    expect(input.safeParse({ dir: "/Users/me/Code" }).success).toBe(true);
    expect(input.safeParse({}).success).toBe(false);
    expect(input.safeParse({ dir: "" }).success).toBe(false);
    expect(input.safeParse({ dir: `/${"x".repeat(500)}` }).success).toBe(false);
    expect(input.safeParse({ dir: "/Users/me/Code", recursive: true }).success).toBe(false);
    const entry = { name: "shop", git: true, remote: "git@github.com:acme/shop.git" };
    const listing = { dir: "/Users/me/Code", exists: true, entries: [entry], truncated: false };
    expect(output.safeParse(listing).success).toBe(true);
    expect(output.safeParse({ ...listing, entries: [{ ...entry, remote: null }] }).success).toBe(true);
    expect(output.safeParse({ ...listing, entries: Array.from({ length: 201 }, () => entry) }).success).toBe(false);
    expect(output.safeParse({ ...listing, entries: [{ ...entry, files: ["x"] }] }).success).toBe(false);
  });
  it("saveSetup takes the folder and the name, and no path to write to", () => {
    const { input, output } = hostContract.saveSetup;
    expect(input.safeParse({ projectsDir: "/Users/me/Code" }).success).toBe(true);
    expect(input.safeParse({ projectsDir: "/Users/me/Code", ownerName: "Alex" }).success).toBe(true);
    expect(input.safeParse({ projectsDir: "/Users/me/Code", ownerName: null }).success).toBe(true);
    expect(input.safeParse({ projectsDir: "/Users/me/Code", ownerName: "" }).success).toBe(false);
    expect(input.safeParse({ projectsDir: "/Users/me/Code", ownerName: "x".repeat(41) }).success).toBe(false);
    expect(input.safeParse({ ownerName: "Alex" }).success).toBe(false);
    expect(input.safeParse({ projectsDir: "/Users/me/Code", configPath: "/etc/x" }).success).toBe(false);
    expect(input.safeParse({ projectsDir: "/Users/me/Code", profiles: [] }).success).toBe(false);
    expect(output.safeParse({ ok: true, projectsDir: "/Users/me/Code", created: false }).success).toBe(true);
    expect(output.safeParse({ ok: false, reason: "the file has a problem" }).success).toBe(true);
    expect(output.safeParse({ ok: false }).success).toBe(false);
  });
});
