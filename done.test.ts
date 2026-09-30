import { describe, expect, it } from "vitest";
import {
  ARCHIVE_CLOSED_AFTER_MS,
  DONE_IDLE_MS,
  archiveDue,
  archiveEnabled,
  doneBlocker,
  doneClose,
  doneNote,
  followUpDue,
  followUpItem,
  followUpMessage,
  followUpOf,
  followUpOfBlocker,
  followUpToldKey,
  landedFollowUpMessage,
  reportSaysDone,
  statusLine,
  type DoneArgs,
} from "./done";
import { completionLabel, completionOf } from "./model";
import { setOwner } from "./owner";

const NOW = 1_790_500_000_000;

// The real status line of a task, "Check whether the web app is actually locked".
const REPORT = "Checked the Vercel project and the middleware.\n\nStatus: Done. Prod web locked (verified with a signed-out request).\n";

const args = (overrides: Partial<DoneArgs> = {}, task: Partial<DoneArgs["task"]> = {}): DoneArgs => ({
  task: { closedAt: null, stage: "research", buildState: "none", prNumber: null, branch: null, worktreePath: null, ...task },
  report: REPORT,
  openTickets: 0,
  running: false,
  claims: 0,
  idleSince: NOW - DONE_IDLE_MS,
  now: NOW,
  stepsLeft: 0,
  ...overrides,
});

describe("reportSaysDone", () => {
  it("reads a status line that leads with done", () => {
    expect(reportSaysDone(REPORT)).toBe(true);
    expect(reportSaysDone("Work.\nStatus: task complete; production auth config is in.")).toBe(true);
    expect(reportSaysDone("Done: deleted 6 stale branches.")).toBe(true);
    expect(reportSaysDone("**Status:** Done, nothing left.")).toBe(true);
    expect(reportSaysDone("**Status for Patches**: done")).toBe(true);
    expect(reportSaysDone("Status for Patches: Complete.")).toBe(true);
    expect(reportSaysDone("- DONE")).toBe(true);
  });

  it("reads only the last non-empty line", () => {
    expect(reportSaysDone("Done: step one.\nStatus: waiting on the owner.")).toBe(false);
    expect(reportSaysDone("Notes\n\nDone: all of it\n\n  \n")).toBe(true);
  });

  it("is not fooled by a done that is not first, negated, or still waiting", () => {
    expect(reportSaysDone("Status: Step 1 DONE, step 2 next.")).toBe(false);
    expect(reportSaysDone("Not done yet.")).toBe(false);
    expect(reportSaysDone("Status: deleted 6 branches")).toBe(false);
    expect(reportSaysDone("Status: waiting on the owner: done once they merge")).toBe(false);
    expect(reportSaysDone("Status: blocked, done otherwise")).toBe(false);
    expect(reportSaysDone("Done, but waiting on the owner to merge #62.")).toBe(false);
    expect(reportSaysDone("Status: Completed? No.")).toBe(false);
    expect(reportSaysDone("Doneness unknown")).toBe(false);
    expect(reportSaysDone(null)).toBe(false);
    expect(reportSaysDone("")).toBe(false);
    expect(reportSaysDone("\n  \n")).toBe(false);
  });
});

describe("doneClose", () => {
  it("closes a research task that said done and sat idle 30 min with nothing open", () => {
    const note = doneClose(args());
    expect(note).toBe(
      "Done: Status: Done. Prod web locked (verified with a signed-out request). (idle 30 min with nothing open; closed by The Orchestrator)",
    );
    expect(completionLabel(completionOf({ note }))).toBe("Done");
    expect(doneBlocker(args())).toBeNull();
  });

  it("keeps a task for every open thing, and says why", () => {
    const kept: [DoneArgs, string][] = [
      [args({}, { closedAt: NOW }), "already closed"],
      [args({}, { stage: "pr" }), "at stage pr"],
      [args({}, { stage: "build" }), "at stage build"],
      [args({}, { buildState: "running" }), "a build is in flight"],
      [args({}, { buildState: "preparing" }), "a build is in flight"],
      [args({}, { buildState: "failed" }), "a failed build is still the task's"],
      [args({ openTickets: 1 }), "a question or review is open"],
      [args({ running: true }), "an agent of the task is working"],
      [args({}, { prNumber: 62 }), "has a PR"],
      [args({}, { branch: "task/x" }), "has a branch"],
      [args({}, { worktreePath: "/r/.claude/worktrees/x" }), "has a worktree"],
      [args({ claims: 1 }), "has claims"],
      [args({ report: "Status: Step 1 DONE" }), "report does not say done"],
      [args({ report: null }), "report does not say done"],
      [args({ idleSince: null }), "idle time unknown"],
      [args({ idleSince: NOW - 12 * 60_000 }), "idle only 12 min"],
      [args({ idleSince: NOW - DONE_IDLE_MS + 1 }), "idle only 29 min"],
      [args({ idleSince: NOW + 5_000 }), "idle only 0 min"],
    ];
    for (const [input, reason] of kept) {
      expect(doneBlocker(input)).toBe(reason);
      expect(doneClose(input)).toBeNull();
    }
  });

  it("never closes a task with steps left on its Done: report, and sends Patches no follow-up for it", () => {
    // Everything else would close it: said done, idle 30 min, nothing open.
    expect(doneBlocker(args())).toBeNull();
    expect(doneBlocker(args({ stepsLeft: 3 }))).toBe("steps left: 3");
    expect(doneClose(args({ stepsLeft: 3 }))).toBeNull();
    expect(doneClose(args({ stepsLeft: 1 }))).toBeNull();
    expect(doneBlocker(args({ stepsLeft: 0 }))).toBeNull();
    expect(doneClose(args({ stepsLeft: 0 }))).not.toBeNull();
    // Not a follow-up: the task carries on itself, even when its report names work left.
    expect(followUpOfBlocker(doneBlocker(args({ stepsLeft: 3 })))).toBeNull();
    const left = args({ stepsLeft: 2, report: "Left: steps 2 and 3\nDone: step 1 landed" });
    expect(doneBlocker({ ...left, stepsLeft: 0 })).toBe("follow-up: Left: steps 2 and 3");
    expect(doneBlocker(left)).toBe("steps left: 2");
    expect(followUpOfBlocker(doneBlocker(left))).toBeNull();
    // Whatever else is or is not known, steps left never lets it through.
    expect(doneBlocker(args({ stepsLeft: 2, idleSince: null }))).toBe("steps left: 2");
    expect(doneBlocker(args({ stepsLeft: 2, claims: 1 }))).toBe("steps left: 2");
    expect(doneBlocker(args({ stepsLeft: 2, running: true }))).toBe("an agent of the task is working");
  });

  it("trims the note's status line and drops bold", () => {
    expect(doneNote(`**Done:** ${"x".repeat(300)}`)).toBe(`Done: Done: ${"x".repeat(194)} (idle 30 min with nothing open; closed by The Orchestrator)`);
    expect(statusLine("a\nb\n")).toBe("b");
  });
});

// The status line of a task that was auto-closed with its follow-up lost.
const OPEN_ITEM = "Status for Patches: task complete; only open item is unsetting `DEMO_LOGIN` after the demo";

describe("follow-ups", () => {
  it("keeps the task that said complete with an open item, and quotes it", () => {
    const report = `Set the demo login.\n\n${OPEN_ITEM}`;
    expect(reportSaysDone(report)).toBe(true);
    expect(followUpItem(report)).toBe(OPEN_ITEM);
    expect(followUpOf(report)).toBe(OPEN_ITEM);
    const reason = doneBlocker(args({ report }));
    expect(reason).toBe(`follow-up: ${OPEN_ITEM}`);
    expect(followUpOfBlocker(reason)).toBe(OPEN_ITEM);
    expect(doneClose(args({ report }))).toBeNull();
  });

  it("keeps a report with a Left: line above its Done: line", () => {
    const report = "Shipped it.\n\n**Left:** unset X after approval\nDone: shipped Y";
    expect(followUpItem(report)).toBe("Left: unset X after approval");
    expect(doneBlocker(args({ report }))).toBe("follow-up: Left: unset X after approval");
    expect(doneClose(args({ report }))).toBeNull();
    expect(followUpItem("- Left: rotate the key\nDone: y")).toBe("- Left: rotate the key");
  });

  it("detects every remaining-work phrase", () => {
    const lines = [
      "One open item: the DNS record.",
      "Open items: two.",
      "The copy is still to do.",
      "The icon still needs a dark variant.",
      "Pricing is still to be decided.",
      "Nothing much, but the tests are left to do.",
      "Flip the flag after approval.",
      "Flip the flag after App Store approval.",
      "Delete the branch after it merges.",
      "Tag it after the release.",
      "Re-run after review.",
      "Announce after the launch.",
      "Purge the cache after deploying.",
      "Update the notes after we ship.",
      "A follow-up for the logo.",
      "Follow up with Vercel.",
      "Followups: the docs.",
      "TODO: the docs.",
      "Two todos in the list.",
      "A to-do for the docs.",
      "Remaining: the docs.",
      "The docs remain; the rest remains too.",
      "Once the demo is over, unset DEMO_LOGIN.",
      "Once it is merged, then run the migration.",
      "Once the build is live, re-enable the cron.",
    ];
    for (const line of lines) expect(followUpItem(`Work.\n${line}\nDone: y`), line).toBe(line);
    expect(followUpItem("Status: done; after approval set X")).toBe("Status: done; after approval set X");
  });

  it("does not count negations, empty Left: lines, or code fences", () => {
    const clean = [
      "Status: Done, nothing left.",
      "Done; nothing else left.",
      "Nothing is left to do.",
      "No open items.",
      "There are no remaining items.",
      "None remaining.",
      "No follow-ups.",
      "No TODOs.",
      "Nothing remains.",
      "Left: none",
      "Left: nothing.",
      "**Left:** n/a",
      "Left: -",
      "Left:",
      "Checked the Vercel project.",
      "Status: Done. Prod web locked (verified with a signed-out request).",
    ];
    for (const line of clean) expect(followUpItem(`${line}\nDone: y`), line).toBeNull();
    expect(followUpItem("Done:\n```ts\n// TODO: later\n```\nDone: y")).toBeNull();
    expect(followUpItem("```\nTODO\n```\nTODO: after\nDone")).toBe("TODO: after");
    expect(followUpItem(null)).toBeNull();
    expect(doneClose(args({ report: "**Status:** Done, nothing left." }))).not.toBeNull();
  });

  it("clips a long item to 300 chars and drops bold", () => {
    expect(followUpItem(`**Left:** ${"x".repeat(400)}`)).toBe(`Left: ${"x".repeat(294)}`);
  });

  it("only reports a follow-up on the board for a report that says done", () => {
    expect(followUpOf("Left: rotate the key\nStatus: waiting on the owner")).toBeNull();
    expect(followUpOf("Left: rotate the key\nDone: y")).toBe("Left: rotate the key");
    expect(followUpOf(null)).toBeNull();
  });

  it("checks the follow-up only once everything else would close it", () => {
    const report = `Work\n${OPEN_ITEM}`;
    expect(doneBlocker(args({ report, idleSince: NOW - 60_000 }))).toBe("idle only 1 min");
    expect(doneBlocker(args({ report, claims: 1 }))).toBe("has claims");
    expect(followUpOfBlocker("idle only 1 min")).toBeNull();
    expect(followUpOfBlocker(null)).toBeNull();
  });

  it("tells Patches once per item", () => {
    expect(followUpToldKey("task_a")).toBe("followup_told:task_a");
    expect(followUpDue({ item: "Left: x", told: null })).toBe(true);
    expect(followUpDue({ item: "Left: x", told: "Left: x" })).toBe(false);
    expect(followUpDue({ item: "Left: y", told: "Left: x" })).toBe(true);
    expect(followUpDue({ item: null, told: null })).toBe(false);
  });

  it("says what Patches does with it", () => {
    const text = followUpMessage({ id: "task_a", title: "Review sign-in" }, "Left: unset X");
    expect(text).toContain('task_a ("Review sign-in") reported done but names work left: "Left: unset X"');
    expect(text).toContain("not auto-closed");
    expect(text).toContain("follow-up task");
    expect(text).toContain("release_task close: true");
    const landed = landedFollowUpMessage({ id: "task_a", title: "Review sign-in" }, "Left: unset X");
    expect(landed).toContain("landed on main and closed");
    expect(landed).toContain('"Left: unset X"');
    expect(landed).toContain("follow-up task");
  });

  it("names whoever runs it, and the owner when nobody is named", () => {
    const task = { id: "task_a", title: "Review sign-in" };
    expect(followUpMessage(task, "Left: x")).toContain("Start a follow-up task for it or ask the owner, then close task_a");
    expect(landedFollowUpMessage(task, "Left: x")).toContain("Start a follow-up task for it or ask the owner.");
    setOwner("Alex");
    try {
      expect(followUpMessage(task, "Left: x")).toContain("Start a follow-up task for it or ask Alex, then close task_a");
      expect(landedFollowUpMessage(task, "Left: x")).toContain("Start a follow-up task for it or ask Alex.");
    } finally {
      setOwner(null);
    }
  });
});

describe("archiveDue", () => {
  const due = (overrides: Partial<Parameters<typeof archiveDue>[0]> = {}) =>
    archiveDue({ closedAt: NOW - ARCHIVE_CLOSED_AFTER_MS, now: NOW, enabled: true, alreadyArchived: false, ...overrides });

  it("archives once, 10 min after the close, when on", () => {
    expect(due()).toBe(true);
    expect(due({ closedAt: NOW - ARCHIVE_CLOSED_AFTER_MS + 1 })).toBe(false);
    expect(due({ enabled: false })).toBe(false);
    expect(due({ alreadyArchived: true })).toBe(false);
    expect(due({ closedAt: null })).toBe(false);
  });

  it("is on unless turned off", () => {
    expect(archiveEnabled(null)).toBe(true);
    expect(archiveEnabled("on")).toBe(true);
    expect(archiveEnabled("off")).toBe(false);
  });
});
