import { describe, expect, it } from "vitest";
import { JEV_KEY_DISPLAY, KEY_REREAD_MS, TYPESAFE_BASE_URL, jevKey, keyFromFile, keyProblemText, keyStale, repoEnvPath, typesafeConfig } from "./typesafe";

describe("typesafeConfig", () => {
  it("reads JEV_API_KEY, with export and quotes, last line wins", () => {
    expect(typesafeConfig("JEV_API_KEY=abc123")).toEqual({ baseUrl: "https://api.typesafe.ai", key: "abc123", model: "jev-latest" });
    expect(typesafeConfig("export JEV_API_KEY='k1'\n")?.key).toBe("k1");
    expect(typesafeConfig('JEV_API_KEY="k2"')?.key).toBe("k2");
    expect(typesafeConfig("JEV_API_KEY=one\nOTHER=x\nJEV_API_KEY=two\n")?.key).toBe("two");
    expect(typesafeConfig("  JEV_API_KEY = spaced  \r\n")?.key).toBe("spaced");
  });

  it("is null without a usable key", () => {
    expect(typesafeConfig(null)).toBeNull();
    expect(typesafeConfig("")).toBeNull();
    expect(typesafeConfig("OTHER_KEY=x")).toBeNull();
    expect(typesafeConfig("JEV_API_KEY=")).toBeNull();
    expect(typesafeConfig('JEV_API_KEY=""')).toBeNull();
    expect(typesafeConfig("JEV_API_KEY=has space")).toBeNull();
    expect(typesafeConfig("JEV_API_KEY=ké")).toBeNull();
    expect(typesafeConfig("# JEV_API_KEY=commented")).toBeNull();
    expect(typesafeConfig(`JEV_API_KEY=${"a".repeat(513)}`)).toBeNull();
  });

  it("always points at the constant TypeSafe URL", () => {
    expect(TYPESAFE_BASE_URL).toBe("https://api.typesafe.ai");
    expect(typesafeConfig("JEV_API_KEY=x\nJEV_BASE_URL=https://evil.example")?.baseUrl).toBe(TYPESAFE_BASE_URL);
  });
});

describe("keyFromFile", () => {
  it("takes a key from a file only its owner can read", () => {
    expect(keyFromFile({ text: "JEV_API_KEY=k", mode: 0o100600 })).toEqual({
      ok: true,
      config: { baseUrl: TYPESAFE_BASE_URL, key: "k", model: "jev-latest" },
    });
    expect(keyFromFile({ text: "JEV_API_KEY=k", mode: 0o400 }).ok).toBe(true);
  });

  it("refuses a file group or others can read, key or not", () => {
    for (const mode of [0o644, 0o640, 0o604, 0o601, 0o610, 0o100660]) {
      expect(keyFromFile({ text: "JEV_API_KEY=k", mode })).toEqual({ ok: false, problem: "open" });
    }
  });

  it("is missing with no file or no line", () => {
    expect(keyFromFile(null)).toEqual({ ok: false, problem: "missing" });
    expect(keyFromFile({ text: "NOPE=1", mode: 0o600 })).toEqual({ ok: false, problem: "missing" });
  });

  it("says what is wrong without the key", () => {
    expect(keyProblemText("open")).toContain("readable by others");
    expect(keyProblemText("missing")).toContain(JEV_KEY_DISPLAY);
    expect(JEV_KEY_DISPLAY).toBe("~/.config/the-orchestrator/jev.env");
  });
});

describe("jevKey: jev.env, else The Orchestrator repo's .env", () => {
  const REPO = "/Users/me/Documents/Github/the-orchestrator";
  const repoPath = `${REPO}/.env`;
  const good = { text: "OTHER=1\nJEV_API_KEY=from-repo\n", mode: 0o100600, tracked: false };
  const config = (key: string) => ({ baseUrl: TYPESAFE_BASE_URL, key, model: "jev-latest" });

  it("finds the repo .env only in a main checkout, never a worktree", () => {
    expect(repoEnvPath(REPO)).toBe(repoPath);
    expect(repoEnvPath(`${REPO}/`)).toBe(repoPath);
    expect(repoEnvPath(`${REPO}/.claude/worktrees/x`)).toBeNull();
    expect(repoEnvPath(`${REPO}/.claude/worktrees`)).toBeNull();
    expect(repoEnvPath("relative/the-orchestrator")).toBeNull();
    expect(repoEnvPath(`${REPO}/../elsewhere`)).toBeNull();
    expect(repoEnvPath(null)).toBeNull();
  });

  it("takes jev.env first when it is there", () => {
    expect(jevKey({ home: { text: "JEV_API_KEY=from-home", mode: 0o600 }, repo: good, repoPath })).toEqual({
      ok: true,
      config: config("from-home"),
      file: JEV_KEY_DISPLAY,
    });
    // jev.env alone decides once it is there: open or keyless, the repo .env is not a fallback.
    expect(jevKey({ home: { text: "JEV_API_KEY=from-home", mode: 0o644 }, repo: good, repoPath })).toEqual({ ok: false, problem: "open", file: JEV_KEY_DISPLAY });
    expect(jevKey({ home: { text: "NOPE=1", mode: 0o600 }, repo: good, repoPath })).toEqual({ ok: false, problem: "missing", file: JEV_KEY_DISPLAY });
  });

  it("takes the repo .env when jev.env is not there", () => {
    expect(jevKey({ home: null, repo: good, repoPath })).toEqual({ ok: true, config: config("from-repo"), file: repoPath });
  });

  it("refuses a repo .env git tracks, or one it could not check, key or not", () => {
    expect(jevKey({ home: null, repo: { ...good, tracked: true }, repoPath })).toEqual({ ok: false, problem: "tracked", file: repoPath });
    expect(jevKey({ home: null, repo: { ...good, tracked: null }, repoPath })).toEqual({ ok: false, problem: "tracked", file: repoPath });
  });

  it("refuses a repo .env group or others can read", () => {
    for (const mode of [0o644, 0o640, 0o604, 0o100660]) {
      expect(jevKey({ home: null, repo: { ...good, mode }, repoPath })).toEqual({ ok: false, problem: "open", file: repoPath });
    }
  });

  it("has no key when neither file is there, or the repo .env has no line", () => {
    expect(jevKey({ home: null, repo: null, repoPath })).toEqual({ ok: false, problem: "missing", file: null });
    expect(jevKey({ home: null, repo: null, repoPath: null })).toEqual({ ok: false, problem: "missing", file: null });
    expect(jevKey({ home: null, repo: { ...good, text: "OTHER=1" }, repoPath })).toEqual({ ok: false, problem: "missing", file: repoPath });
  });

  it("names the file and what to do on the board, never the key", () => {
    expect(keyProblemText("open", repoPath)).toBe(`${repoPath} is readable by others, so its key is not used: chmod 600 ${repoPath}`);
    expect(keyProblemText("open", JEV_KEY_DISPLAY)).toContain(`chmod 600 ${JEV_KEY_DISPLAY}`);
    expect(keyProblemText("open", "/Users/me/My Repo/.env")).toContain("chmod 600 '/Users/me/My Repo/.env'");
    expect(keyProblemText("tracked", repoPath)).toContain(`git tracks ${repoPath}`);
    expect(keyProblemText("missing", null)).toContain("The Orchestrator's .env");
    expect(keyProblemText("missing", repoPath)).toBe(`No JEV_API_KEY in ${repoPath}.`);
    const reading = jevKey({ home: null, repo: { ...good, mode: 0o644 }, repoPath });
    expect(JSON.stringify(reading)).not.toContain("from-repo");
  });
});

describe("keyStale", () => {
  it("re-reads at most once a minute", () => {
    expect(keyStale(1000, null)).toBe(true);
    expect(keyStale(1000 + KEY_REREAD_MS - 1, 1000)).toBe(false);
    expect(keyStale(1000 + KEY_REREAD_MS, 1000)).toBe(true);
  });
});
