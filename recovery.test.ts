import { describe, expect, it } from "vitest";
import {
  migrationPending,
  rollbackNote,
  shouldKeepLastGood,
  SNAPSHOT_EVERY_MS,
  SNAPSHOT_KEEP,
  snapshotDue,
  snapshotName,
  snapshotsToPrune,
  withRollback,
} from "./recovery";

const NOW = Date.UTC(2026, 8, 29, 10, 15, 0, 123);

describe("shouldKeepLastGood", () => {
  it("keeps dist/ only when no other reload is pending", () => {
    expect(shouldKeepLastGood({ otherPendingReloads: 0 })).toBe(true);
    expect(shouldKeepLastGood({ otherPendingReloads: 1 })).toBe(false);
    expect(shouldKeepLastGood({ otherPendingReloads: 3 })).toBe(false);
  });
});

describe("rollbackNote", () => {
  it("names the restored build and says main still needs the fix", () => {
    expect(rollbackNote({ restored: true, sha: "74c3110aaaabbbbcccc" })).toBe(
      "dist/ restored to last-good 74c3110: a restart of bb loads that build; main still has the bad commit, fix it.",
    );
  });

  it("says why nothing was rolled back, one full stop", () => {
    expect(rollbackNote({ restored: false, reason: "no last-good build kept yet" })).toBe(
      "No rollback: no last-good build kept yet.",
    );
    expect(rollbackNote({ restored: false, reason: "host unreachable. " })).toBe("No rollback: host unreachable.");
  });
});

describe("withRollback", () => {
  it("ends the failure with one full stop, then the note", () => {
    const none = { restored: false as const, reason: "none kept" };
    expect(withRollback("Build failed: exit 1", none)).toBe("Build failed: exit 1. No rollback: none kept.");
    expect(withRollback("Build failed: exit 1. ", none)).toBe("Build failed: exit 1. No rollback: none kept.");
  });
});

describe("snapshotName", () => {
  it("is a sortable UTC stamp with the reason", () => {
    expect(snapshotName(NOW, "migration")).toBe("dossier-20260929T101500Z-migration.db");
    expect(snapshotName(NOW, "daily")).toBe("dossier-20260929T101500Z-daily.db");
  });

  it("sorts by time as text", () => {
    const earlier = snapshotName(NOW - 86_400_000, "migration");
    const later = snapshotName(NOW, "daily");
    expect([later, earlier].sort()).toEqual([earlier, later]);
  });
});

describe("snapshotsToPrune", () => {
  const day = (n: number, reason: "daily" | "migration" = "daily") => snapshotName(NOW + n * SNAPSHOT_EVERY_MS, reason);

  it("names the oldest beyond keep, oldest first", () => {
    const names = [day(3), day(0), day(2), day(1, "migration"), day(4)];
    expect(snapshotsToPrune(names, 3)).toEqual([day(0), day(1, "migration")]);
  });

  it("names nothing at or under keep", () => {
    expect(snapshotsToPrune([day(0), day(1)], 2)).toEqual([]);
    expect(snapshotsToPrune([], SNAPSHOT_KEEP)).toEqual([]);
  });

  it("never names a file that is not a snapshot", () => {
    const names = ["data.db", "notes.txt", "dossier-latest.db", `${day(0)}.tmp`, day(1), day(2)];
    expect(snapshotsToPrune(names, 1)).toEqual([day(1)]);
    expect(snapshotsToPrune(names, 0)).toEqual([day(1), day(2)]);
  });

  it("keeps the newest SNAPSHOT_KEEP", () => {
    const names = Array.from({ length: 20 }, (_, n) => day(n));
    const pruned = snapshotsToPrune(names, SNAPSHOT_KEEP);
    expect(pruned).toEqual(names.slice(0, 20 - SNAPSHOT_KEEP));
  });
});

describe("snapshotDue", () => {
  it("is due with none yet, or a day after the last", () => {
    expect(snapshotDue(null, NOW)).toBe(true);
    expect(snapshotDue(Number.NaN, NOW)).toBe(true);
    expect(snapshotDue(NOW - SNAPSHOT_EVERY_MS, NOW)).toBe(true);
    expect(snapshotDue(NOW - SNAPSHOT_EVERY_MS + 1, NOW)).toBe(false);
    expect(snapshotDue(NOW, NOW)).toBe(false);
  });
});

describe("migrationPending", () => {
  it("is pending while fewer are applied than exist", () => {
    expect(migrationPending(0, 5)).toBe(true);
    expect(migrationPending(4, 5)).toBe(true);
    expect(migrationPending(5, 5)).toBe(false);
  });
});
