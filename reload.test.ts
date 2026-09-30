import { describe, expect, it } from "vitest";
import { completionLabel, completionOf } from "./model";
import { withRollback } from "./recovery";
import {
  decideReload,
  parsePendingReload,
  pluginStatusOf,
  RELOAD_PREFIX,
  RELOAD_TIMEOUT_MS,
  reloadedMessage,
  reloadedNote,
  reloadFailureReason,
  reloadKey,
  type PendingReload,
} from "./reload";

const STARTED = 1_790_500_000_000;

const pending: PendingReload = {
  taskId: "task_wsiqy8lp6d",
  threadId: "thr_abc",
  projectId: "prj_1",
  sha: "74c3110aaaabbbbccccddddeeeeffff0000111122",
  target: "main",
  summary: "land() waits for the reload outcome.",
  startedAt: STARTED,
};

const NEW = STARTED + 5_000;
const OLD = STARTED - 60_000;

describe("reloadKey", () => {
  it("prefixes the task id", () => {
    expect(reloadKey("task_a")).toBe("reload_pending:task_a");
    expect(reloadKey("task_a").startsWith(RELOAD_PREFIX)).toBe(true);
  });
});

describe("parsePendingReload", () => {
  it("round-trips a row", () => {
    expect(parsePendingReload(JSON.stringify(pending))).toEqual(pending);
    expect(parsePendingReload(JSON.stringify({ ...pending, threadId: null }))).toEqual({ ...pending, threadId: null });
  });

  it("keeps the steps left of a multi-step land, and reads a row without them", () => {
    const more = ["wire server.ts", "docs"];
    expect(parsePendingReload(JSON.stringify({ ...pending, more }))).toEqual({ ...pending, more });
    // Rows written before `more` existed have none: the land closes its task.
    expect(parsePendingReload(JSON.stringify(pending))).not.toHaveProperty("more");
  });

  it("drops a malformed or empty more to absent, keeping the row", () => {
    for (const bad of ["docs", 3, null, {}, [], ["docs", 3], [""], [["docs"]]]) {
      const parsed = parsePendingReload(JSON.stringify({ ...pending, more: bad }));
      expect(parsed, JSON.stringify(bad)).toEqual(pending);
      expect(parsed, JSON.stringify(bad)).not.toHaveProperty("more");
    }
  });

  it("drops anything that is not one", () => {
    expect(parsePendingReload("not json")).toBeNull();
    expect(parsePendingReload("null")).toBeNull();
    expect(parsePendingReload("42")).toBeNull();
    expect(parsePendingReload(JSON.stringify({ ...pending, taskId: "" }))).toBeNull();
    expect(parsePendingReload(JSON.stringify({ ...pending, projectId: 3 }))).toBeNull();
    expect(parsePendingReload(JSON.stringify({ ...pending, sha: undefined }))).toBeNull();
    expect(parsePendingReload(JSON.stringify({ ...pending, target: "" }))).toBeNull();
    expect(parsePendingReload(JSON.stringify({ ...pending, summary: null }))).toBeNull();
    expect(parsePendingReload(JSON.stringify({ ...pending, threadId: 7 }))).toBeNull();
    expect(parsePendingReload(JSON.stringify({ ...pending, startedAt: "1" }))).toBeNull();
    expect(parsePendingReload('{"startedAt": 1e999}')).toBeNull();
  });
});

describe("decideReload", () => {
  const at = (now: number, exitCode: number | null, instanceStartedAt = NEW, output = "") =>
    decideReload({ pending, outcome: { exitCode, output }, instanceStartedAt, now });

  it("exit 0 seen by an instance started after the land is live", () => {
    expect(at(STARTED + 3_000, 0)).toEqual({ kind: "live" });
    // Even past the timeout: the new instance is proof enough.
    expect(at(STARTED + RELOAD_TIMEOUT_MS + 1, 0)).toEqual({ kind: "live" });
  });

  it("exit 0 seen by the old instance waits for the new one", () => {
    expect(at(STARTED + 3_000, 0, OLD)).toEqual({ kind: "wait" });
    // Started in the same ms as the land counts as old.
    expect(at(STARTED + 3_000, 0, STARTED)).toEqual({ kind: "wait" });
    expect(at(STARTED + RELOAD_TIMEOUT_MS - 1, 0, OLD)).toEqual({ kind: "wait" });
  });

  it("exit 0 with no new instance by the timeout fails", () => {
    const decision = at(STARTED + RELOAD_TIMEOUT_MS, 0, OLD);
    expect(decision).toEqual({ kind: "failed", reason: "reload reported success but no new instance started within 3 minutes" });
  });

  it("a non-zero exit fails at once, with the code and the output's tail", () => {
    expect(at(STARTED + 2_000, 1, OLD, "Error: plugin failed to load\n")).toEqual({
      kind: "failed",
      reason: "reload exited 1: Error: plugin failed to load",
    });
    expect(at(STARTED + 2_000, 127, NEW)).toEqual({ kind: "failed", reason: "reload exited 127" });
    const long = at(STARTED + 2_000, 2, OLD, `${"x".repeat(5_000)}END`);
    expect(long.kind === "failed" && long.reason.endsWith("END") && long.reason.length < 1_600).toBe(true);
  });

  it("no outcome waits until the timeout, then fails", () => {
    expect(at(STARTED, null)).toEqual({ kind: "wait" });
    expect(at(STARTED + RELOAD_TIMEOUT_MS - 1, null)).toEqual({ kind: "wait" });
    expect(at(STARTED + RELOAD_TIMEOUT_MS, null)).toEqual({ kind: "failed", reason: "no reload outcome after 3 minutes" });
  });

  it("a host that could not be asked is no outcome", () => {
    const now = STARTED + 1_000;
    expect(decideReload({ pending, outcome: null, instanceStartedAt: NEW, now })).toEqual({ kind: "wait" });
    expect(decideReload({ pending, outcome: null, instanceStartedAt: NEW, now: STARTED + RELOAD_TIMEOUT_MS })).toEqual({
      kind: "failed",
      reason: "no reload outcome after 3 minutes",
    });
  });
});

describe("pluginStatusOf", () => {
  const list = (plugins: unknown) => JSON.stringify({ plugins });

  it("reads the plugin's status and detail, as bb plugin list --json has them", () => {
    const json = list([
      { id: "account-pool", name: "Account Pooler", status: "disabled", statusDetail: null },
      { id: "the-orchestrator", name: "The Orchestrator", status: "reload failed", statusDetail: "SyntaxError: x" },
    ]);
    expect(pluginStatusOf(json, "the-orchestrator")).toEqual({ status: "reload failed", detail: "SyntaxError: x" });
    expect(pluginStatusOf(json, "account-pool")).toEqual({ status: "disabled", detail: null });
    expect(pluginStatusOf(JSON.stringify([{ id: "p", status: "running", statusDetail: "ok" }]), "p")).toEqual({ status: "running", detail: "ok" });
  });

  it("is nothing when the plugin or the list is not there", () => {
    const none = { status: null, detail: null };
    expect(pluginStatusOf(list([{ id: "other", status: "running" }]), "the-orchestrator")).toEqual(none);
    // A display name is not an id.
    expect(pluginStatusOf(list([{ id: "x", name: "the-orchestrator", status: "running" }]), "the-orchestrator")).toEqual(none);
    expect(pluginStatusOf("not json", "p")).toEqual(none);
    expect(pluginStatusOf("{}", "p")).toEqual(none);
    expect(pluginStatusOf(list([null, 3, { id: "p", status: 5 }]), "p")).toEqual(none);
  });
});

describe("reloadFailureReason", () => {
  it("adds bb's own reason when it has one", () => {
    expect(reloadFailureReason("reload exited 1", { status: "reload failed", detail: "SyntaxError in server.js" })).toBe(
      "Reload failed: reload exited 1. bb says: reload failed: SyntaxError in server.js",
    );
    expect(reloadFailureReason("x", { status: "error", detail: null })).toBe("Reload failed: x. bb says: error");
    expect(reloadFailureReason("x", { status: null, detail: "boom" })).toBe("Reload failed: x. bb says: boom");
  });

  it("says ours alone when bb has nothing", () => {
    expect(reloadFailureReason("no reload outcome after 3 minutes", null)).toBe("Reload failed: no reload outcome after 3 minutes.");
    expect(reloadFailureReason("x", { status: null, detail: null })).toBe("Reload failed: x.");
    expect(reloadFailureReason("x", { status: " ", detail: "" })).toBe("Reload failed: x.");
  });
});

describe("messages", () => {
  it("closes with the note land always wrote, which the board reads back", () => {
    const note = reloadedNote(pending);
    expect(note).toBe("Landed on main at 74c3110: land() waits for the reload outcome.");
    expect(completionLabel(completionOf({ note }))).toBe("Landed on main · 74c3110");
  });

  it("tells the thread the sha is live and the task closed", () => {
    expect(reloadedMessage(pending)).toBe("Reloaded: 74c3110 is live. task_wsiqy8lp6d is closed.");
  });
});

describe("a failed reload with its rollback", () => {
  it("tells the task bb's reason, then what was restored and that main still needs fixing", () => {
    const reason = reloadFailureReason("reload exited 1", { status: "running", detail: "reload failed: Cannot find module" });
    expect(withRollback(reason, { restored: true, sha: pending.sha })).toBe(
      "Reload failed: reload exited 1. bb says: running: reload failed: Cannot find module. " +
        "dist/ restored to last-good 74c3110: a restart of bb loads that build; main still has the bad commit, fix it.",
    );
  });

  it("says plainly when there was nothing to roll back to", () => {
    const reason = reloadFailureReason("no reload outcome after 3 minutes", null);
    expect(withRollback(reason, { restored: false, reason: "no last-good build has been kept yet" })).toBe(
      "Reload failed: no reload outcome after 3 minutes. No rollback: no last-good build has been kept yet.",
    );
  });
});
