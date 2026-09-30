import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { IDLE_MINUTES, MAX_LIFETIME_HOURS, watchdogDecision } from "./policy.ts";

const script = join(dirname(fileURLToPath(import.meta.url)), "box", "watchdog.sh");
const boot = 1_700_000_000;
const min = 60;

// [now - boot, last request - boot or null, ready - boot or null]
const CASES: [number, number | null, number | null][] = [
  [0, null, null],
  [14 * min, null, null],
  [15 * min, null, null],
  [16 * min, null, null],
  [30 * min, 20 * min, null],
  [35 * min, 20 * min, null],
  [34 * min + 59, 20 * min, null],
  [30 * min, null, 20 * min],
  [40 * min, null, 20 * min],
  [30 * min, 25 * min, 10 * min],
  [4 * 3600 - 1, 4 * 3600 - 60, null],
  [4 * 3600, 4 * 3600, null],
  [9 * 3600, null, null],
  [10 * min, -5 * min, null],
];

function bash(nowS: number, lastS: number | null, readyS: number | null): string {
  return execFileSync("bash", [script], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      DRY: "1",
      NOW_S: String(nowS),
      BOOT_S: String(boot),
      LAST_S: lastS === null ? "" : String(lastS),
      READY_S: readyS === null ? "" : String(readyS),
      IDLE_MINUTES: String(IDLE_MINUTES),
      MAX_LIFETIME_HOURS: String(MAX_LIFETIME_HOURS),
    },
  }).trim();
}

describe("jev/box/watchdog.sh", () => {
  it.each(CASES)("agrees with watchdogDecision at +%is (last %s, ready %s)", (now, last, ready) => {
    const nowS = boot + now;
    const lastS = last === null ? null : boot + last;
    const readyS = ready === null ? null : boot + ready;
    expect(bash(nowS, lastS, readyS)).toBe(watchdogDecision({ nowS, bootS: boot, lastRequestS: lastS, readyS }));
  });

  it("covers all three decisions", () => {
    const seen = new Set(
      CASES.map(([now, last, ready]) =>
        watchdogDecision({ nowS: boot + now, bootS: boot, lastRequestS: last === null ? null : boot + last, readyS: ready === null ? null : boot + ready }),
      ),
    );
    expect([...seen].sort()).toEqual(["delete-idle", "delete-lifetime", "keep"]);
  });

  it("is valid bash, and so is setup.sh", () => {
    execFileSync("bash", ["-n", script]);
    execFileSync("bash", ["-n", join(dirname(script), "setup.sh")]);
  });
});
