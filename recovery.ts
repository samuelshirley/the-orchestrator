// Recovery from a bad self-land. bb loads this plugin from <repo>/dist, a path
// install with no pinned build, and keeps the previous instance running when a
// reload fails. So after a confirmed good reload the host keeps a copy of
// dist/ as last-good, and after a failed one (or a failed build after land)
// the still-running old instance puts it back: a bb restart then loads a
// working Orchestrator while the task fixes main. The dossier is snapshotted
// with VACUUM INTO before any pending migration and once a day; the newest
// SNAPSHOT_KEEP stay, beside the dossier, never pushed anywhere.
// Pure; recovery.test.ts pins it.

/**
 * Keep this reload's dist/ as last-good only when no other reload is pending:
 * another land may have rebuilt dist/ since this one was confirmed.
 */
export function shouldKeepLastGood({ otherPendingReloads }: { otherPendingReloads: number }): boolean {
  return otherPendingReloads === 0;
}

export type RollbackResult = { restored: true; sha: string } | { restored: false; reason: string };

/** Appended to what the task is told after a failed reload or build. */
export function rollbackNote(result: RollbackResult): string {
  if (result.restored) {
    return `dist/ restored to last-good ${result.sha.slice(0, 7)}: a restart of bb loads that build; main still has the bad commit, fix it.`;
  }
  return `No rollback: ${result.reason.trim().replace(/\.$/, "")}.`;
}

/** A failure told to the task, one sentence, then its rollbackNote. */
export function withRollback(reason: string, result: RollbackResult): string {
  const sentence = reason.trim().replace(/\.?$/, ".");
  return `${sentence} ${rollbackNote(result)}`;
}

/** How many dossier snapshots stay. */
export const SNAPSHOT_KEEP = 14;

/** A daily snapshot is due this long after the last one. */
export const SNAPSHOT_EVERY_MS = 24 * 60 * 60_000;

export type SnapshotReason = "daily" | "migration";

const SNAPSHOT_PATTERN = /^dossier-\d{8}T\d{6}Z-(daily|migration)\.db$/;

/** dossier-<UTC yyyymmddThhmmssZ>-<reason>.db: names sort by time. */
export function snapshotName(now: number, reason: SnapshotReason): string {
  const stamp = new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
  return `dossier-${stamp}-${reason}.db`;
}

/** Snapshots beyond the newest `keep`, oldest first; other files are never named. */
export function snapshotsToPrune(names: readonly string[], keep: number): string[] {
  const snapshots = names.filter((name) => SNAPSHOT_PATTERN.test(name)).sort();
  return snapshots.slice(0, Math.max(0, snapshots.length - Math.max(0, keep)));
}

/** A daily snapshot is due when there is none yet, or the last is a day old. */
export function snapshotDue(lastAt: number | null, now: number): boolean {
  return lastAt === null || !Number.isFinite(lastAt) || now - lastAt >= SNAPSHOT_EVERY_MS;
}

/** Some migration has not been applied yet. */
export function migrationPending(applied: number, total: number): boolean {
  return applied < total;
}
