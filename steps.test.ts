import { describe, expect, it } from "vitest";
import {
  STEP_MAX,
  STEPS_MAX,
  buildWaitsForReload,
  keepOpenAfterLand,
  parseMore,
  parseSteps,
  serializeSteps,
  stepLanded,
  stepKeptReply,
  stepLandedMessage,
  stepReleaseReason,
  stepsKey,
  stepsLabel,
  stepsLeftCount,
} from "./steps";

describe("stepsKey", () => {
  it("is one row per task", () => {
    expect(stepsKey("task_a")).toBe("steps_left:task_a");
  });
});

describe("parseMore", () => {
  it("splits on newlines and semicolons", () => {
    expect(parseMore("wire server.ts\nboard label in app.tsx")).toEqual(["wire server.ts", "board label in app.tsx"]);
    expect(parseMore("wire server.ts; docs;  ")).toEqual(["wire server.ts", "docs"]);
    expect(parseMore("one step")).toEqual(["one step"]);
  });

  it("strips bullets, numbering and whitespace, and drops empties", () => {
    expect(parseMore("- a\n* b\n• c\n1. d\n2) e\n(3) f\nStep 4: g\n\n   \n  h  ")).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
    // A step that only starts with a number keeps it.
    expect(parseMore("3 more migrations")).toEqual(["3 more migrations"]);
    expect(parseMore("step 2 of the UI")).toEqual(["step 2 of the UI"]);
    expect(parseMore("1.5x faster reload\n--force is refused")).toEqual(["1.5x faster reload", "--force is refused"]);
  });

  it("reads none, nothing, n/a, - and empty as no steps", () => {
    for (const none of ["", "  ", "none", "None", "NONE.", "nothing", "n/a", "N/A", "-", "- none", "none\n", ";", "\n\n", null, undefined]) {
      expect(parseMore(none), JSON.stringify(none)).toEqual([]);
    }
    // Only as the whole item.
    expect(parseMore("none of the UI is wired yet")).toEqual(["none of the UI is wired yet"]);
    expect(parseMore("docs; none")).toEqual(["docs"]);
  });

  it("caps each step and the list", () => {
    expect(parseMore("x".repeat(STEP_MAX + 50))).toEqual(["x".repeat(STEP_MAX)]);
    const many = parseMore(Array.from({ length: STEPS_MAX + 5 }, (_, i) => `s${i}`).join("\n"));
    expect(many).toHaveLength(STEPS_MAX);
    expect(many[0]).toBe("s0");
  });
});

describe("the stored record", () => {
  it("round-trips", () => {
    const record = { left: ["wire server.ts", "docs"], landed: ["a94a2f1c0ffee"] };
    expect(parseSteps(serializeSteps(record))).toEqual(record);
    expect(parseSteps(serializeSteps({ left: [], landed: [] }))).toEqual({ left: [], landed: [] });
  });

  it("reads anything else as null", () => {
    for (const bad of ["not json", "null", "42", "[]", "{}", '{"left":["a"]}', '{"left":"a","landed":[]}', '{"left":[1],"landed":[]}', '{"left":[],"landed":[null]}']) {
      expect(parseSteps(bad), bad).toBeNull();
    }
    expect(parseSteps(null)).toBeNull();
  });

  it("adds the landed sha and replaces the steps left", () => {
    const first = stepLanded(null, "aaa1111", ["b", "c"]);
    expect(first).toEqual({ left: ["b", "c"], landed: ["aaa1111"] });
    const second = stepLanded(first, "bbb2222", ["c"]);
    expect(second).toEqual({ left: ["c"], landed: ["aaa1111", "bbb2222"] });
    // The same sha twice (a re-checked reload) is recorded once; the input is not changed.
    expect(stepLanded(second, "bbb2222", [])).toEqual({ left: [], landed: ["aaa1111", "bbb2222"] });
    expect(first.landed).toEqual(["aaa1111"]);
  });

  it("counts the steps left; none when absent or unreadable", () => {
    expect(stepsLeftCount(serializeSteps({ left: ["b", "c"], landed: ["aaa1111"] }))).toBe(2);
    expect(stepsLeftCount(serializeSteps({ left: [], landed: ["aaa1111"] }))).toBe(0);
    expect(stepsLeftCount(null)).toBe(0);
    expect(stepsLeftCount("not json")).toBe(0);
  });
});

describe("keepOpenAfterLand", () => {
  it("keeps the task open only with at least one step left", () => {
    expect(keepOpenAfterLand(["docs"])).toBe(true);
    expect(keepOpenAfterLand(parseMore("wire server.ts; docs"))).toBe(true);
    expect(keepOpenAfterLand([])).toBe(false);
    expect(keepOpenAfterLand(undefined)).toBe(false);
    expect(keepOpenAfterLand(null)).toBe(false);
    expect(keepOpenAfterLand(parseMore("none"))).toBe(false);
    expect(keepOpenAfterLand(parseMore(undefined))).toBe(false);
  });
});

describe("buildWaitsForReload", () => {
  it("lets a build through only when no land is running and no reload is pending", () => {
    expect(buildWaitsForReload({ landing: false, reloadPending: false })).toBeNull();
  });

  it("refuses while the last land's reload is not confirmed", () => {
    expect(buildWaitsForReload({ landing: false, reloadPending: true })).toBe(
      'The last land\'s reload is not confirmed yet, so nothing was claimed or started. You will be told when it is live ("Reloaded: … is live"), or that it failed; call build again then.',
    );
  });

  it("refuses while the land itself is still running, with or without a pending reload", () => {
    const running =
      'The last land is still running, so nothing was claimed or started. You will be told when it is live ("Reloaded: … is live"), or that it failed; call build again then.';
    expect(buildWaitsForReload({ landing: true, reloadPending: false })).toBe(running);
    expect(buildWaitsForReload({ landing: true, reloadPending: true })).toBe(running);
  });

  it("names the message the thread will get", () => {
    const told = stepLandedMessage("task_a", "74c3110aaaabbbb", ["docs"]);
    expect(told).toContain("Reloaded: 74c3110 is live");
    expect(buildWaitsForReload({ landing: false, reloadPending: true })).toContain("Reloaded: … is live");
  });
});

describe("what the thread and the board are told", () => {
  it("tells the thread it stays open and what to carry on with", () => {
    const message = stepLandedMessage("task_toabawm6ms", "74c3110aaaabbbbccccdddd", ["wire server.ts", "docs"]);
    expect(message).toBe(
      "[The Orchestrator] Reloaded: 74c3110 is live. task_toabawm6ms stays open, claims and build slot released. Carry on with:\n1. wire server.ts\n2. docs\nCall build again with the next step's touches. Pass `more` to land while steps are left; the final land (no `more`) closes task_toabawm6ms.",
    );
    expect(message).not.toContain("is closed");
  });

  it("says in land's reply and the release that it stays open", () => {
    expect(stepKeptReply("task_a", 3)).toBe("task_a stays open with 3 steps left: build again for the next one.");
    expect(stepKeptReply("task_a", 1)).toBe("task_a stays open with 1 step left: build again for the next one.");
    expect(stepReleaseReason("74c3110aaaabbbb", 2)).toBe("Step landed at 74c3110; kept open with 2 steps left.");
    expect(stepReleaseReason("74c3110aaaabbbb", 1)).toBe("Step landed at 74c3110; kept open with 1 step left.");
  });

  it("labels the board", () => {
    expect(stepsLabel(3)).toBe("Step landed, 3 left");
    expect(stepsLabel(1)).toBe("Step landed, 1 left");
  });
});
