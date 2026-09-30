import { describe, expect, it } from "vitest";
import {
  CAP_USD,
  MAX_SESSION_HOURS,
  baseUrlFor,
  capCheck,
  hostnameFor,
  idFromBody,
  isGone,
  ledgerLine,
  ledgerTotal,
  modelFromConfig,
  parseEnv,
  parseLedger,
  pickImage,
  pickLocation,
  priceOf,
  renderEnv,
  sessionCostUsd,
  settleMinutes,
  watchdogDecision,
} from "./policy.ts";

describe("modelFromConfig", () => {
  it("refuses without a pick: there is no default model", () => {
    for (const raw of [null, "", "{}", '{"model":""}', '{"model":"gpt-9"}', "not json", '{"model":"toString"}']) {
      const result = modelFromConfig(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("The owner hasn't picked the Jev model yet (open question)");
    }
  });
  it("maps each known model to its machine", () => {
    const laya = modelFromConfig('{"model":"laya-421m"}');
    expect(laya.ok && laya.profile.instanceType).toBe("CPU.4V.16G");
    const anyjev = modelFromConfig('{"model":"anyjev-qwen3-8b"}');
    expect(anyjev.ok && anyjev.profile).toMatchObject({ instanceType: "1A6000.10V", gpu: true, server: "anyjev" });
  });
});

describe("capCheck", () => {
  const base = { ledgerUsd: 0, priceUsdH: 0.64, expectedUsdH: 0.64, maxSessionHours: MAX_SESSION_HOURS, balanceUsd: 20 };

  it("allows a session the cap and balance cover", () => {
    expect(capCheck(base)).toEqual({ ok: true });
  });
  it("refuses when spent plus a whole session would pass $20", () => {
    // 4 h x $0.64 = $2.56: $17.44 spent fits exactly, a cent more does not.
    expect(capCheck({ ...base, ledgerUsd: CAP_USD - 2.56 }).ok).toBe(true);
    const over = capCheck({ ...base, ledgerUsd: CAP_USD - 2.55 });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reason).toContain("$20 cap");
  });
  it("refuses a price more than 10% over the one we checked", () => {
    expect(capCheck({ ...base, priceUsdH: 0.704 }).ok).toBe(true);
    expect(capCheck({ ...base, priceUsdH: 0.71 }).ok).toBe(false);
  });
  it("refuses a known balance under one session, and ignores an unknown one", () => {
    expect(capCheck({ ...base, balanceUsd: 2.5 }).ok).toBe(false);
    expect(capCheck({ ...base, balanceUsd: null }).ok).toBe(true);
  });
  it("refuses a missing or zero price", () => {
    expect(capCheck({ ...base, priceUsdH: Number.NaN }).ok).toBe(false);
    expect(capCheck({ ...base, priceUsdH: 0 }).ok).toBe(false);
  });
});

describe("sessionCostUsd and settleMinutes", () => {
  it("bills whole 10-minute blocks", () => {
    expect(sessionCostUsd(0, 0.64)).toBe(0);
    expect(sessionCostUsd(1, 0.6)).toBe(0.1);
    expect(sessionCostUsd(10, 0.6)).toBe(0.1);
    expect(sessionCostUsd(11, 0.6)).toBe(0.2);
    expect(sessionCostUsd(240, 0.64)).toBe(2.56);
  });
  it("never bills an unseen box past its lifetime", () => {
    expect(settleMinutes(0, 61_000)).toBe(2);
    expect(settleMinutes(0, 24 * 3600_000)).toBe(240);
  });
});

describe("watchdogDecision", () => {
  const boot = 1_000_000;
  it("keeps a box used within 15 minutes", () => {
    expect(watchdogDecision({ nowS: boot + 3600, bootS: boot, lastRequestS: boot + 3600 - 14 * 60 })).toBe("keep");
  });
  it("deletes after 15 idle minutes", () => {
    expect(watchdogDecision({ nowS: boot + 3600, bootS: boot, lastRequestS: boot + 3600 - 15 * 60 })).toBe("delete-idle");
  });
  it("counts idle from boot when nothing called it yet", () => {
    expect(watchdogDecision({ nowS: boot + 14 * 60, bootS: boot, lastRequestS: null })).toBe("keep");
    expect(watchdogDecision({ nowS: boot + 15 * 60, bootS: boot, lastRequestS: null })).toBe("delete-idle");
  });
  it("counts idle from when setup finished, if later", () => {
    expect(watchdogDecision({ nowS: boot + 30 * 60, bootS: boot, lastRequestS: null, readyS: boot + 20 * 60 })).toBe("keep");
  });
  it("deletes at 4 hours whatever the traffic, and lifetime wins over idle", () => {
    expect(watchdogDecision({ nowS: boot + 4 * 3600 - 1, bootS: boot, lastRequestS: boot + 4 * 3600 - 2 })).toBe("keep");
    expect(watchdogDecision({ nowS: boot + 4 * 3600, bootS: boot, lastRequestS: boot + 4 * 3600 })).toBe("delete-lifetime");
    expect(watchdogDecision({ nowS: boot + 5 * 3600, bootS: boot, lastRequestS: null })).toBe("delete-lifetime");
  });
});

describe("Verda bodies", () => {
  it("reads an id as a string or {id}", () => {
    expect(idFromBody("abc")).toBe("abc");
    expect(idFromBody({ id: "abc" })).toBe("abc");
    expect(idFromBody({})).toBeNull();
    expect(idFromBody("")).toBeNull();
  });
  it("counts 404 and the gone statuses as gone", () => {
    expect(isGone(null, 404)).toBe(true);
    for (const status of ["discontinued", "notfound", "deleted"]) expect(isGone(status, 200)).toBe(true);
    for (const status of ["running", "deleting", "provisioning"]) expect(isGone(status, 200)).toBe(false);
  });
  it("picks the first Helsinki location offering the type", () => {
    const availability = [
      { location_code: "ICE-01", availabilities: ["1A6000.10V"] },
      { location_code: "FIN-03", availabilities: ["1A6000.10V"] },
      { location_code: "FIN-01", availabilities: ["CPU.4V.16G"] },
    ];
    expect(pickLocation(availability, "1A6000.10V")).toBe("FIN-03");
    expect(pickLocation(availability, "CPU.4V.16G")).toBe("FIN-01");
    expect(pickLocation(availability, "8H100")).toBeNull();
    expect(pickLocation({}, "x")).toBeNull();
  });
  it("picks images by preference", () => {
    const images = [{ image_type: "24.04.cuda13.0" }, { image_type: "24.04.cuda12.9" }, { image_type: "ubuntu-24.04" }];
    expect(pickImage(images, true)).toBe("24.04.cuda12.9");
    expect(pickImage(images, false)).toBe("ubuntu-24.04");
    expect(pickImage([{ image_type: "ubuntu-22.04" }], false)).toBe("ubuntu-22.04");
    expect(pickImage([{ image_type: "ubuntu-22.04" }], true)).toBeNull();
  });
  it("reads a price", () => {
    expect(priceOf([{ instance_type: "CPU.4V.16G", price_per_hour: "0.04800" }], "CPU.4V.16G")).toBe(0.048);
    expect(priceOf([{ instance_type: "CPU.4V.16G", price_per_hour: "x" }], "CPU.4V.16G")).toBeNull();
    expect(priceOf([], "CPU.4V.16G")).toBeNull();
  });
  it("names the box and its TLS host", () => {
    expect(hostnameFor(new Date(Date.UTC(2026, 8, 29, 7, 5)))).toBe("jev-0929-0705");
    expect(baseUrlFor("203.0.113.10")).toBe("https://203-0-113-10.sslip.io");
  });
});

describe("ledger and env files", () => {
  it("sums whole rows and skips torn ones", () => {
    const row = { at: "t", instanceId: "i", type: "CPU.4V.16G", minutes: 20, usd: 0.016, note: "" };
    const text = ledgerLine(row) + ledgerLine({ ...row, usd: 1.5 }) + '{"usd": 9';
    expect(ledgerTotal(parseLedger(text))).toBe(1.516);
    expect(parseLedger(null)).toEqual([]);
  });
  it("round-trips an env file and refuses what it cannot quote", () => {
    const env = { JEV_KEY_ORCHESTRATOR: "ab".repeat(32), NOTE: "a b" };
    expect(parseEnv(renderEnv(env))).toEqual(env);
    expect(parseEnv('# c\nexport A="x"\nB=y\n\nbad line')).toEqual({ A: "x", B: "y" });
    expect(() => renderEnv({ A: "it's" })).toThrow();
    expect(() => renderEnv({ A: "x\ny" })).toThrow();
  });
});
