import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { setOwner } from "./owner";
import {
  REPORT_MAX_BYTES,
  dataDirFromThreadStorage,
  followUpRefusal,
  reportDir,
  reportDoneLine,
  reportFactsRefusal,
  reportFollowUpMessage,
  reportItemTitle,
  reportPathFor,
  reportPathRefusal,
  reportReviewedNote,
  reportStatusLabel,
  reportSubmittedReply,
  reportSummary,
  reportTitleRefusal,
  reportToldMessage,
  threadStorageRoot,
  type ReportFacts,
} from "./report";
import { completionOf } from "./model";

beforeEach(() => setOwner("Alex"));
afterEach(() => setOwner(null));

const ROOT = "/Users/a/.bb/thread-storage";
const TASK = "task_dnox79pzrc";
const good = `${ROOT}/${TASK}/report.md`;

describe("threadStorageRoot", () => {
  it("is ~/.bb/thread-storage, or under bb's data dir when it is known", () => {
    expect(threadStorageRoot("/Users/a")).toBe(ROOT);
    expect(threadStorageRoot("/Users/a/")).toBe(ROOT);
    expect(threadStorageRoot("/Users/a", "/Volumes/bb/")).toBe("/Volumes/bb/thread-storage");
    expect(threadStorageRoot("/Users/a", "  ")).toBe(ROOT);
  });

  it("reads bb's data dir from a thread's own storage path", () => {
    expect(dataDirFromThreadStorage("/Users/a/.bb/thread-storage/thr_sw7vcagsdh")).toBe("/Users/a/.bb");
    expect(dataDirFromThreadStorage(undefined)).toBeNull();
    expect(dataDirFromThreadStorage("relative/thread-storage/thr_x")).toBeNull();
    expect(dataDirFromThreadStorage("/Users/a/.bb/thread-storage")).toBeNull();
  });

  it("puts the task's report in its own folder", () => {
    expect(reportDir(ROOT, TASK)).toBe(`${ROOT}/${TASK}`);
    expect(reportPathFor(ROOT, TASK)).toBe(good);
  });
});

describe("reportPathRefusal", () => {
  const check = (path: string, taskId = TASK) => reportPathRefusal({ path, taskId, root: ROOT });

  it("accepts an absolute .md path under the task's folder, nested too", () => {
    expect(check(good)).toBeNull();
    expect(check(`${ROOT}/${TASK}/notes/jev-validation-report.md`)).toBeNull();
  });

  it("refuses a relative path", () => {
    expect(check(`.bb/thread-storage/${TASK}/report.md`)).toMatch(/absolute path/);
    expect(check("report.md")).toMatch(/absolute path/);
  });

  it("refuses . and .. segments, even ones that land back inside", () => {
    expect(check(`${ROOT}/${TASK}/../${TASK}/report.md`)).toMatch(/\.\. segments/);
    expect(check(`${ROOT}/${TASK}/../task_other/report.md`)).toMatch(/\.\. segments/);
    expect(check(`${ROOT}/${TASK}/./report.md`)).toMatch(/\.\. segments/);
  });

  it("refuses anything but .md", () => {
    expect(check(`${ROOT}/${TASK}/report.txt`)).toMatch(/\.md file/);
    expect(check(`${ROOT}/${TASK}/report.md.sh`)).toMatch(/\.md file/);
    expect(check(`${ROOT}/${TASK}/report.MD`)).toMatch(/\.md file/);
  });

  it("refuses another task's folder, the root, a sibling sharing the prefix, and the folder itself", () => {
    expect(check(`${ROOT}/task_other/report.md`)).toMatch(/must be under/);
    expect(check(`${ROOT}/report.md`)).toMatch(/must be under/);
    expect(check(`${ROOT}/${TASK}x/report.md`)).toMatch(/must be under/);
    expect(check(`${ROOT}/${TASK}.md`)).toMatch(/must be under/);
    expect(check("/etc/passwd.md")).toMatch(/must be under/);
  });

  it("refuses a task id that could walk a path, and NUL bytes", () => {
    expect(check(good, "../task_x")).toMatch(/not a task id/);
    expect(check(good, "task_A/../b")).toMatch(/not a task id/);
    expect(check(good, "")).toMatch(/not a task id/);
    expect(check(`${ROOT}/${TASK}/re\0port.md`)).toMatch(/NUL/);
  });
});

describe("reportFactsRefusal", () => {
  const real = "/private/a/.bb/thread-storage";
  const facts = (overrides: Partial<Extract<ReportFacts, { exists: true }>> = {}): ReportFacts => ({
    exists: true,
    realPath: `${real}/${TASK}/report.md`,
    realRoot: real,
    isFile: true,
    size: 1200,
    ...overrides,
  });
  const check = (value: ReportFacts) => reportFactsRefusal({ taskId: TASK, facts: value });

  it("accepts a real, non-empty .md file inside the real task folder", () => {
    expect(check(facts())).toBeNull();
    expect(check(facts({ size: REPORT_MAX_BYTES }))).toBeNull();
  });

  it("refuses a missing file", () => {
    expect(check({ exists: false })).toMatch(/no file/);
  });

  it("refuses a symlink that resolves outside the task folder", () => {
    expect(check(facts({ realPath: "/Users/a/.ssh/id_rsa.md" }))).toMatch(/resolves outside/);
    expect(check(facts({ realPath: `${real}/task_other/report.md` }))).toMatch(/resolves outside/);
    expect(check(facts({ realPath: `${real}/${TASK}x/report.md` }))).toMatch(/resolves outside/);
  });

  it("refuses a link to a file that is not .md, a folder, an empty file and one past 2 MB", () => {
    expect(check(facts({ realPath: `${real}/${TASK}/secrets.env` }))).toMatch(/not \.md/);
    expect(check(facts({ isFile: false }))).toMatch(/not a regular file/);
    expect(check(facts({ size: 0 }))).toMatch(/empty/);
    expect(check(facts({ size: REPORT_MAX_BYTES + 1 }))).toMatch(/limit is 2097152 \(2 MB\)/);
  });
});

// The host's readReport gathers these facts with realpath and stat; this does
// the same on a real temp folder, so a symlink escape is a real one.
describe("on a real disk", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "orc-report-")));
  const root = join(base, "thread-storage");
  const dir = join(root, TASK);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(root, "task_other"), { recursive: true });
  writeFileSync(join(dir, "report.md"), "# Where things stand\n\nAll good.\n");
  writeFileSync(join(dir, "empty.md"), "");
  writeFileSync(join(root, "task_other", "theirs.md"), "# Not yours\n");
  writeFileSync(join(base, "secret.md"), "secret\n");
  writeFileSync(join(dir, "big.md"), Buffer.alloc(REPORT_MAX_BYTES + 1, "a"));
  symlinkSync(join(base, "secret.md"), join(dir, "escape.md"));
  symlinkSync(join(root, "task_other", "theirs.md"), join(dir, "other.md"));
  symlinkSync(join(root, "task_other"), join(root, "task_linked"));
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  function verdict(path: string, taskId = TASK): string | null {
    const lexical = reportPathRefusal({ path, taskId, root });
    if (lexical !== null) return lexical;
    let facts: ReportFacts;
    try {
      const realPath = realpathSync(path);
      const info = statSync(realPath);
      facts = { exists: true, realPath, realRoot: realpathSync(root), isFile: info.isFile(), size: info.size };
    } catch {
      facts = { exists: false };
    }
    return reportFactsRefusal({ taskId, facts });
  }

  it("accepts the task's own report", () => {
    expect(verdict(join(dir, "report.md"))).toBeNull();
  });

  it("refuses a symlink out of the folder, into another task's, and a linked task folder", () => {
    expect(verdict(join(dir, "escape.md"))).toMatch(/resolves outside/);
    expect(verdict(join(dir, "other.md"))).toMatch(/resolves outside/);
    expect(verdict(join(root, "task_linked", "theirs.md"), "task_linked")).toMatch(/resolves outside/);
  });

  it("refuses a missing, empty or oversized file", () => {
    expect(verdict(join(dir, "nope.md"))).toMatch(/no file/);
    expect(verdict(join(dir, "empty.md"))).toMatch(/empty/);
    expect(verdict(join(dir, "big.md"))).toMatch(/limit/);
  });

  it("refuses a .. walk before touching the disk", () => {
    expect(verdict(`${dir}/../task_other/theirs.md`)).toMatch(/\.\. segments/);
  });
});

describe("title and summary", () => {
  it("takes a one-line title of at most 120 characters", () => {
    expect(reportTitleRefusal("Jev validation")).toBeNull();
    expect(reportTitleRefusal("x".repeat(120))).toBeNull();
    expect(reportTitleRefusal("x".repeat(121))).toMatch(/at most 120/);
    expect(reportTitleRefusal("   ")).toMatch(/title/);
    expect(reportTitleRefusal("one\ntwo")).toMatch(/one line/);
  });

  it("takes 1-3 summary lines, trimmed, and none at all", () => {
    expect(reportSummary(undefined)).toEqual({ ok: true, summary: null });
    expect(reportSummary(" \n ")).toEqual({ ok: true, summary: null });
    expect(reportSummary(" Jev routes.\n\n Routing holds. ")).toEqual({ ok: true, summary: "Jev routes.\nRouting holds." });
    expect(reportSummary("a\nb\nc")).toEqual({ ok: true, summary: "a\nb\nc" });
    expect(reportSummary("a\nb\nc\nd")).toEqual({ ok: false, reason: "The summary is 4 lines; at most 3." });
    expect(reportSummary("x".repeat(601))).toMatchObject({ ok: false });
  });
});

describe("what everyone is told", () => {
  it("tells the task to end on its Done line, waiting on the owner", () => {
    expect(reportDoneLine()).toBe("Done: report submitted, waiting on Alex to review");
    expect(reportSubmittedReply("tkt_1", false)).toContain("Opened report ticket tkt_1");
    expect(reportSubmittedReply("tkt_1", true)).toContain("Updated report ticket tkt_1");
    expect(reportSubmittedReply("tkt_1", false)).toMatch(/End your turn with: Done: report submitted, waiting on Alex to review$/);
  });

  it("tells Patches the title, summary and path, and not to paste it", () => {
    const told = reportToldMessage({ id: TASK, title: "Validate Jev" }, { path: good, title: "Jev check", summary: "Two findings." }, false);
    expect(told).toContain('"Jev check"');
    expect(told).toContain("Two findings.");
    expect(told).toContain(`File: ${good}`);
    expect(told).toContain('"Review report: Jev check"');
    expect(told).toContain("do not paste the report");
  });

  it("titles the board's item and status by the owner's name", () => {
    expect(reportItemTitle("Jev check")).toBe("Review report: Jev check");
    expect(reportStatusLabel()).toBe("Report ready · waiting on Alex");
    setOwner(null);
    expect(reportStatusLabel()).toBe("Report ready · waiting on the owner");
  });

  it("closes as Done, reviewed by the owner", () => {
    expect(reportReviewedNote()).toBe("Done: Report reviewed by Alex");
    expect(completionOf({ note: reportReviewedNote() })).toEqual({ kind: "done" });
  });

  it("sends the owner's follow-up and keeps the ticket open", () => {
    expect(reportFollowUpMessage("tkt_1", "  Check the relay too. ")).toContain("Alex read your report (ticket tkt_1) and follows up:\n\nCheck the relay too.");
    expect(reportFollowUpMessage("tkt_1", "x")).toContain("call submit_report again");
    expect(followUpRefusal(" ")).toMatch(/Write what/);
    expect(followUpRefusal("x".repeat(4001))).toMatch(/4000/);
    expect(followUpRefusal("Look at the logs")).toBeNull();
  });
});
