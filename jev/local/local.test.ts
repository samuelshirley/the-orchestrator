import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jevLocalConfig } from "../../jevwatch";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => readFileSync(join(here, name), "utf8");
const serve = read("serve_local.py");
const plist = read("com.theorchestrator.jev-local.plist.tmpl");
const install = read("install.sh");

const plistValue = (key: string) => new RegExp(`<key>${key}</key>\\s*<(?:string|integer)>([^<]*)</`).exec(plist)?.[1];

describe("jev/local", () => {
  it.each([
    ["serve_local.py", serve],
    ["the plist template", plist],
    ["install.sh", install],
  ])("%s is CPU only: no mlx, mps, cuda or gpu anywhere", (_name, text) => {
    expect(text).not.toMatch(/mlx|mps|cuda|gpu/i);
  });

  it("serve_local.py serves on 127.0.0.1:8766 with the literal cpu device", () => {
    expect(serve).toContain('HOST = "127.0.0.1"');
    expect(serve).toContain("DEFAULT_PORT = 8766");
    expect(serve).toContain('Router(device="cpu", max_loaded=1, default="typed-decisions", standalone_repos=True)');
    expect(serve).toContain("uvicorn.run(serve.create_app(router), host=HOST, port=port, log_level=\"info\")");
    expect(serve.match(/device\s*=/g)).toHaveLength(1);
    expect(serve).not.toMatch(/0\.0\.0\.0|localhost/);
    // The port is the only thing read from the environment.
    expect(serve.match(/os\.environ[^\n]*/g)).toEqual(['os.environ.get("JEV_LOCAL_PORT", str(DEFAULT_PORT))']);
  });

  it("serve_local.py refuses 8765 with exit 2, before anything is loaded", () => {
    expect(serve).toContain("RESERVED_PORT = 8765");
    const refusal = serve.indexOf("if port == RESERVED_PORT:");
    expect(refusal).toBeGreaterThan(-1);
    expect(serve.slice(refusal, serve.indexOf("return port", refusal))).toContain("sys.exit(2)");
    expect(serve.indexOf("port = local_port()")).toBeLessThan(serve.indexOf("import uvicorn"));
    expect(serve.indexOf("port = local_port()")).toBeGreaterThan(refusal);
  });

  it("the plist runs the venv's python on serve_local.py at 8766, cpu, in the background", () => {
    expect(plistValue("Label")).toBe("com.theorchestrator.jev-local");
    expect(plist).toMatch(/<key>ProgramArguments<\/key>\s*<array>\s*<string>__RUNTIME__\/venv\/bin\/python<\/string>\s*<string>__REPO__\/jev\/local\/serve_local\.py<\/string>\s*<\/array>/);
    expect(plistValue("WorkingDirectory")).toBe("__RUNTIME__");
    expect(plistValue("JEV_LOCAL_PORT")).toBe("8766");
    expect(plistValue("LAYA_DEVICE")).toBe("cpu");
    expect(plistValue("LAYA_THREADS")).toBe("4");
    expect(plistValue("HF_HUB_OFFLINE")).toBe("1");
    expect(plistValue("HF_HOME")).toBe("__HF_HOME__");
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<__RUN_AT_LOAD__\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/);
    expect(plistValue("ThrottleInterval")).toBe("60");
    expect(plistValue("ProcessType")).toBe("Background");
    expect(plist).toMatch(/<key>LowPriorityIO<\/key>\s*<true\/>/);
    expect(plistValue("Nice")).toBe("5");
    expect(plistValue("StandardOutPath")).toBe("__HOME__/.config/jev/local.log");
    expect(plistValue("StandardErrorPath")).toBe("__HOME__/.config/jev/local.log");
    expect(plist).not.toContain("8765");
  });

  it("install.sh writes a local.json that jevwatch accepts, and fills every placeholder", () => {
    expect(install).toContain("PORT=8766");
    expect(install).toContain('BASE_URL="http://127.0.0.1:${PORT}"');
    expect(install).toContain('MODEL="typed-decisions"');
    expect(install).toContain(`printf '{"baseUrl":"%s","model":"%s"}\\n' "$BASE_URL" "$MODEL" >"$LOCAL_JSON"`);
    expect(jevLocalConfig('{"baseUrl":"http://127.0.0.1:8766","model":"typed-decisions"}\n')).toEqual({
      baseUrl: "http://127.0.0.1:8766",
      key: null,
      model: "typed-decisions",
    });
    const placeholders = [...new Set(plist.match(/__[A-Z_]+__/g))].sort();
    expect(placeholders).toEqual(["__HF_HOME__", "__HOME__", "__REPO__", "__RUNTIME__", "__RUN_AT_LOAD__"]);
    for (const placeholder of placeholders) expect(install).toContain(`s|${placeholder}|`);
    expect(install).not.toContain("8765");
  });

  it("install.sh never runs the server: only launchd does", () => {
    expect(install).toContain("set -euo pipefail");
    const code = install.split("\n").filter((line) => !line.trim().startsWith("#"));
    expect(code.filter((line) => /serve_local|uvicorn|nohup|\bexec\b/.test(line))).toEqual([]);
    expect(code.filter((line) => /venv\/bin\/python/.test(line))).toEqual([
      expect.stringMatching(/^\s*\[ -x "\$RUNTIME\/venv\/bin\/python" \] \|\| die /),
    ]);
  });
});
