import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dryRunDeps, run } from "./cli.ts";

const here = dirname(fileURLToPath(import.meta.url));
const creds = "VERDA_CLIENT_ID=id\nVERDA_CLIENT_SECRET=dry-run-secret-never-printed\n";

function fake(seed: Record<string, string> | null = null) {
  const lines: string[] = [];
  const f = dryRunDeps((line) => lines.push(line), seed);
  return { ...f, lines, text: () => lines.join("\n") };
}

describe("jev cli", () => {
  it("dry-run walks up then down and exits 0, in process and as `node jev/cli.ts dry-run`", async () => {
    const f = fake();
    expect(await run(["dry-run"], f.deps)).toBe(0);
    const output = execFileSync(process.execPath, [join(here, "cli.ts"), "dry-run"], { encoding: "utf8", timeout: 30_000 });
    expect(output).toContain("up exit 0, down exit 0");
  });

  it("up refuses until config.json names a model, before any call", async () => {
    for (const config of [null, '{"model":"something-else"}']) {
      const f = fake({ ...(config === null ? {} : { "config.json": config }), "verda.env": creds });
      expect(await run(["up"], f.deps)).toBe(6);
      expect(f.text()).toContain("The owner hasn't picked the Jev model yet (open question)");
      expect(f.calls).toEqual([]);
    }
  });

  it("up without credentials exits 3 naming what is missing, before any call", async () => {
    const f = fake({ "config.json": '{"model":"laya-421m"}', "verda.env": "VERDA_CLIENT_ID=x\n" });
    expect(await run(["up"], f.deps)).toBe(3);
    expect(f.text()).toMatch(/Missing VERDA_CLIENT_SECRET in .*verda\.env/);
    expect(f.calls).toEqual([]);
  });

  it("up refuses over the $20 cap and creates nothing", async () => {
    const ledger = `${JSON.stringify({ at: "t", instanceId: "old", type: "1A6000.10V", minutes: 1, usd: 18, note: "" })}\n`;
    const f = fake({ "config.json": '{"model":"anyjev-qwen3-8b"}', "verda.env": creds, "ledger.jsonl": ledger });
    expect(await run(["up"], f.deps)).toBe(6);
    expect(f.text()).toContain("$20 cap");
    expect(f.calls.some((call) => call.method === "POST" && call.url.endsWith("/instances"))).toBe(false);
  });

  it("up refuses while the last box is not recorded down", async () => {
    const state = JSON.stringify({ status: "up", instanceId: "i", hostname: "jev-0101-0000" });
    const f = fake({ "config.json": '{"model":"laya-421m"}', "verda.env": creds, "state.json": state });
    expect(await run(["up"], f.deps)).toBe(6);
    expect(f.text()).toContain("down` first");
  });

  it("a failure after create deletes the box and records it", async () => {
    const f = fake();
    const exec = f.deps.exec;
    f.deps.exec = async (cmd, args, opts) =>
      args.includes("bash /root/jev/setup.sh") ? { code: 1, stdout: "", stderr: "" } : exec(cmd, args, opts);
    expect(await run(["up"], f.deps)).toBe(7);
    expect(f.calls.some((call) => call.method === "PUT" && call.url.endsWith("/instances"))).toBe(true);
    const state = JSON.parse(f.files.get(`${f.deps.configDir}/state.json`) as string);
    expect(state.status).toBe("down");
    expect(f.files.get(`${f.deps.configDir}/ledger.jsonl`)).toContain("failed during up");
    expect(f.files.has(`${f.deps.configDir}/box.env`)).toBe(false);
  });

  it("no capacity at create exits 5 with nothing left", async () => {
    const f = fake();
    const http = f.deps.http;
    f.deps.http = async (method, url, opts) =>
      method === "POST" && url.endsWith("/instances") ? { status: 503, text: '{"code":"no_capacity"}' } : http(method, url, opts);
    expect(await run(["up"], f.deps)).toBe(5);
    expect(f.calls.some((call) => call.method === "DELETE" && call.url.includes("/ssh-keys/"))).toBe(true);
  });

  it("down that cannot confirm the delete exits 4 and says so loudly", async () => {
    const f = fake();
    expect(await run(["up"], f.deps)).toBe(0);
    const http = f.deps.http;
    f.deps.http = async (method, url, opts) =>
      method === "GET" && url.includes("/instances/") ? { status: 200, text: '{"status":"running"}' } : http(method, url, opts);
    expect(await run(["down"], f.deps)).toBe(4);
    expect(f.text()).toContain("console.verda.com");
    expect(f.files.get(`${f.deps.configDir}/ledger.jsonl`)).toContain("DELETE UNCONFIRMED");
  });

  it("keeps secrets out of argv and output, and reuses the client keys", async () => {
    const f = fake();
    expect(await run(["up"], f.deps)).toBe(0);
    const keys = f.files.get(`${f.deps.configDir}/clients.env`);
    expect(await run(["down"], f.deps)).toBe(0);
    expect(await run(["up"], f.deps)).toBe(0);
    expect(f.files.get(`${f.deps.configDir}/clients.env`)).toBe(keys);
    for (const secret of f.secrets) {
      expect(f.argv.flat().join(" ")).not.toContain(secret);
      expect(f.text()).not.toContain(secret);
    }
    // The secret does travel, in the token request body only.
    expect(f.calls.filter((call) => call.body?.includes("dry-run-secret-never-printed")).every((call) => call.url.endsWith("/oauth2/token"))).toBe(true);
  });

  it("status works without credentials", async () => {
    const f = fake({ "config.json": '{"model":"laya-421m"}' });
    expect(await run(["status"], f.deps)).toBe(0);
    expect(f.text()).toContain("no credentials");
    expect(f.text()).toContain("of the $20 cap");
  });
});
