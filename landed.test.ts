import { describe, expect, it } from "vitest";
import {
  STEPS_LEFT_PREFIX,
  landCandidate,
  landedClose,
  landedCommit,
  landedNote,
  openWork,
  reportedLandedShas,
  taskTrailer,
  trailerTaskIds,
  type MainCommit,
} from "./landed";
import { completionLabel, completionOf } from "./model";

const CREATED = 1_790_420_547_093;

const commit = (overrides: Partial<MainCommit> = {}): MainCommit => ({
  sha: "a94a2f1c0ffee00000000000000000000000abcd",
  committedAt: CREATED + 60_000,
  message: "New task: leave unset composer picks out of task_new's RPC input\n\nBody.",
  ...overrides,
});

const task = { id: "task_zifx1ljo8k", createdAt: CREATED, closedAt: null, stage: "research" as const, buildState: "none" as const };

describe("trailers", () => {
  it("round-trips the task id and ignores lookalikes", () => {
    expect(trailerTaskIds(`Fix\n\n${taskTrailer("task_abc123")}\nCo-Authored-By: x`)).toEqual(["task_abc123"]);
    expect(trailerTaskIds("Fix\n\nOrchestrator-Task: task_a\norchestrator-task: TASK_B")).toEqual(["task_a", "task_b"]);
    expect(trailerTaskIds("mentions Orchestrator-Task: task_a inline")).toEqual([]);
    expect(trailerTaskIds("Orchestrator-Task: nope")).toEqual([]);
  });
});

describe("reportedLandedShas", () => {
  it("reads the shas a report says landed", () => {
    // The real report of task_zifx1ljo8k.
    expect(reportedLandedShas("Fixed, landed on main as `a94a2f1`, and the plugin is reloaded.")).toEqual(["a94a2f1"]);
    expect(reportedLandedShas("Landed 4f8f65d and 9C450AB on main")).toEqual(["4f8f65d", "9c450ab"]);
    expect(reportedLandedShas("It lands as cb55c05.")).toEqual(["cb55c05"]);
    // How the other three finished tasks actually said it.
    expect(reportedLandedShas("Both fixes are committed on main as `4f8f65d`, backed up")).toEqual(["4f8f65d"]);
    expect(reportedLandedShas("**What I built (commit 9c450ab, on main, pushed to the backup)**")).toEqual(["9c450ab"]);
    expect(reportedLandedShas("It's committed to main (`cb55c05`), built, reloaded")).toEqual(["cb55c05"]);
    expect(reportedLandedShas("Report.\n\nMore\nlanded a94a2f1 on main")).toEqual(["a94a2f1"]);
  });

  it("is not fooled by shas on lines about something else, or hex words", () => {
    expect(reportedLandedShas("Built a94a2f1; tests pass.")).toEqual([]);
    expect(reportedLandedShas("which d741ed2 already does for new threads")).toEqual([]);
    expect(reportedLandedShas("the domain a94a2f1")).toEqual([]);
    expect(reportedLandedShas("landed, defaced and decade")).toEqual([]);
    expect(reportedLandedShas("landed abc12")).toEqual([]);
    expect(reportedLandedShas(null)).toEqual([]);
    expect(reportedLandedShas("island a94a2f1")).toEqual([]);
  });
});

describe("landedCommit", () => {
  it("ties a commit by its trailer, with no own sha", () => {
    const tagged = commit({ sha: "1111111aaaa", message: `Fix\n\n${taskTrailer(task.id)}` });
    expect(landedCommit({ task, ownShas: [], commits: [commit(), tagged] })).toBe(tagged);
  });

  it("ties a commit by the task's own branch tip or verifiedSha, full or abbreviated", () => {
    const landed = commit();
    const commits = [commit({ sha: "bbbbbbb1" }), landed];
    expect(landedCommit({ task, ownShas: [landed.sha], commits })).toBe(landed);
    expect(landedCommit({ task, ownShas: ["A94A2F1"], commits })).toBe(landed);
  });

  it("ignores empty and too-short own shas", () => {
    expect(landedCommit({ task, ownShas: ["", "a94a2f", "a"], commits: [commit()] })).toBeNull();
    expect(landedCommit({ task, ownShas: ["not-a-sha"], commits: [commit()] })).toBeNull();
  });

  it("the trailer wins over an own sha", () => {
    const tagged = commit({ sha: "2222222aaaa", message: taskTrailer(task.id) });
    expect(landedCommit({ task, ownShas: ["a94a2f1"], commits: [commit(), tagged] })).toBe(tagged);
  });

  it("an own sha not on main is nothing", () => {
    expect(landedCommit({ task, ownShas: ["a94a2f1"], commits: [commit({ sha: "c0ffee12" })] })).toBeNull();
    expect(landedCommit({ task, ownShas: ["a94a2f1"], commits: [] })).toBeNull();
  });

  it("a commit older than the task is not its work, by trailer or own sha", () => {
    const old = { committedAt: CREATED - 1 };
    expect(landedCommit({ task, ownShas: ["a94a2f1"], commits: [commit(old)] })).toBeNull();
    expect(landedCommit({ task, ownShas: [], commits: [commit({ ...old, message: taskTrailer(task.id) })] })).toBeNull();
    expect(landedCommit({ task, ownShas: ["a94a2f1"], commits: [commit({ committedAt: CREATED })] })).not.toBeNull();
  });

  it("another task's trailer is not this task's", () => {
    expect(landedCommit({ task, ownShas: [], commits: [commit({ message: taskTrailer("task_other") })] })).toBeNull();
  });
});

describe("openWork", () => {
  const idle = { task: { buildState: "none" as const }, openTickets: 0, running: false, reloadPending: false };

  it("is null only when nothing is open", () => {
    expect(openWork(idle)).toBeNull();
    expect(openWork({ ...idle, task: { buildState: "preparing" } })).toMatch(/build/);
    expect(openWork({ ...idle, task: { buildState: "running" } })).toMatch(/build/);
    expect(openWork({ ...idle, task: { buildState: "failed" } })).toMatch(/failed/);
    expect(openWork({ ...idle, reloadPending: true })).toBe("a reload is pending");
    expect(openWork({ ...idle, openTickets: 1 })).toMatch(/question/);
    expect(openWork({ ...idle, running: true })).toMatch(/working/);
  });

  it("counts steps left as open work, after everything more urgent", () => {
    expect(openWork({ ...idle, stepsLeft: 2 })).toBe("steps left: 2");
    expect(openWork({ ...idle, stepsLeft: 1 })).toBe(`${STEPS_LEFT_PREFIX}1`);
    expect(openWork({ ...idle, stepsLeft: 0 })).toBeNull();
    expect(openWork({ ...idle, stepsLeft: undefined })).toBeNull();
    expect(openWork({ ...idle, stepsLeft: Number.NaN })).toBeNull();
    expect(openWork({ ...idle, stepsLeft: 2, reloadPending: true })).toBe("a reload is pending");
    expect(openWork({ ...idle, stepsLeft: 2, running: true })).toMatch(/working/);
    expect(openWork({ ...idle, stepsLeft: 2, task: { buildState: "failed" } })).toMatch(/failed/);
  });
});

describe("landedClose", () => {
  const args = {
    task,
    ownShas: ["a94a2f1"],
    commits: [commit()],
    base: "main",
    openTickets: 0,
    running: false,
    reloadPending: false,
    stepsLeft: 0,
  };

  it("closes a task whose own commit is on main and that has nothing open, as a land the board reads", () => {
    const note = landedClose(args);
    expect(note).not.toBeNull();
    expect(completionLabel(completionOf({ note }))).toBe("Landed on main · a94a2f1");
  });

  it("closes on the task's own branch tip on main", () => {
    const tip = "a94a2f1c0ffee00000000000000000000000abcd";
    expect(landedClose({ ...args, ownShas: [tip] })).toMatch(/^Landed on main at a94a2f1/);
  });

  it("closes on the task's verifiedSha on main, with no branch", () => {
    // What server.ts passes: [branch tip if any, verifiedSha if any].
    expect(landedClose({ ...args, ownShas: ["a94a2f1c0ffee00000000000000000000000abcd"] })).not.toBeNull();
  });

  it("never closes on another task's trailer", () => {
    expect(landedClose({ ...args, ownShas: [], commits: [commit({ message: `Fix\n\n${taskTrailer("task_other")}` })] })).toBeNull();
  });

  it("closes a build-stage task whose builder is done", () => {
    expect(landedClose({ ...args, task: { ...task, stage: "build" } })).not.toBeNull();
  });

  it("keeps a task open while it has open work", () => {
    expect(landedClose({ ...args, running: true })).toBeNull();
    expect(landedClose({ ...args, openTickets: 2 })).toBeNull();
    expect(landedClose({ ...args, reloadPending: true })).toBeNull();
    expect(landedClose({ ...args, task: { ...task, stage: "build", buildState: "running" } })).toBeNull();
  });

  it("keeps a task with steps left open, though its landed step is on main with nothing else open", () => {
    // A multi-step task's step carries its trailer: without this it closes after step 1.
    const step = commit({ message: `Step 1 of 5\n\n${taskTrailer(task.id)}` });
    const stepArgs = { ...args, ownShas: [], commits: [step] };
    expect(landedClose(stepArgs)).not.toBeNull();
    expect(landedClose({ ...stepArgs, stepsLeft: 0 })).not.toBeNull();
    expect(landedClose({ ...stepArgs, stepsLeft: 4 })).toBeNull();
    expect(landedClose({ ...stepArgs, stepsLeft: 1 })).toBeNull();
    expect(landedClose({ ...args, stepsLeft: 1 })).toBeNull();
  });

  it("leaves closed tasks and PR-stage tasks alone", () => {
    expect(landedClose({ ...args, task: { ...task, closedAt: 5 } })).toBeNull();
    expect(landedClose({ ...args, task: { ...task, stage: "pr" } })).toBeNull();
    expect(landedClose({ ...args, task: { ...task, stage: "you" } })).toBeNull();
  });

  it("does nothing without a commit of its own on main", () => {
    expect(landedClose({ ...args, commits: [] })).toBeNull();
    expect(landedClose({ ...args, ownShas: [] })).toBeNull();
  });

  it("never closes on a sha the report only mentions (task_hrfk89ypjb)", () => {
    // task_hrfk89ypjb built nothing: no branch, no verifiedSha. Its report named
    // task_xfviq4sxve's migration fix, newer than it, and it was closed on that.
    const hrfk = { id: "task_hrfk89ypjb", createdAt: CREATED, closedAt: null, stage: "research" as const, buildState: "none" as const };
    const report = "Nothing built: the reload failure is still open, even though the migration fix 2af3da6 is on main.";
    const theirs = commit({
      sha: "2af3da6000000000000000000000000000000000",
      message: "Migrations: append labelled_sha at the end; pin recorded migration hashes\n\nOrchestrator-Task: task_xfviq4sxve",
    });
    // The report does say 2af3da6 is on main; that is still not evidence.
    expect(reportedLandedShas(report)).toEqual(["2af3da6"]);
    const own: { branch: string | null; verifiedSha: string | null } = { branch: null, verifiedSha: null };
    const ownShas = [own.branch, own.verifiedSha].filter((sha): sha is string => sha !== null);
    // The report rides along, as the dossier has it: nothing may read it.
    const hrfkArgs = { ...args, task: hrfk, ownShas, commits: [theirs], report };
    expect(landedCommit(hrfkArgs)).toBeNull();
    expect(landedClose(hrfkArgs)).toBeNull();
  });

  it("names the target and the subject", () => {
    expect(landedNote("main", commit())).toMatch(/^Landed on main at a94a2f1: New task: leave unset/);
    expect(landCandidate({ closedAt: null, stage: "research" })).toBe(true);
    expect(landCandidate({ closedAt: null, stage: "done" })).toBe(false);
  });
});
