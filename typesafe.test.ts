import { describe, expect, it } from "vitest";
import { JEV_KEY_DISPLAY, KEY_REREAD_MS, TYPESAFE_BASE_URL, keyFromFile, keyProblemText, keyStale, typesafeConfig } from "./typesafe";

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

describe("keyStale", () => {
  it("re-reads at most once a minute", () => {
    expect(keyStale(1000, null)).toBe(true);
    expect(keyStale(1000 + KEY_REREAD_MS - 1, 1000)).toBe(false);
    expect(keyStale(1000 + KEY_REREAD_MS, 1000)).toBe(true);
  });
});
