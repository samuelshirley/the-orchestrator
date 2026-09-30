import { describe, expect, it } from "vitest";
import {
  expandedProject,
  shouldAdoptSidebar,
  sidebarRows,
  threadListProviderId,
  type SidebarInput,
  type SidebarRow,
} from "./sidebar";

function input(overrides: Partial<SidebarInput> = {}): SidebarInput {
  return {
    projects: [
      { id: "p_a", name: "Alpha", hidden: false },
      { id: "p_b", name: "Beta", hidden: false },
      { id: "p_h", name: "Hidden", hidden: true },
    ],
    patchesChats: [
      { projectId: "p_a", threadId: "thr_pa", unread: true },
      { projectId: "p_h", threadId: "thr_ph", unread: false },
    ],
    tasks: [
      { id: "t1", projectId: "p_a", title: "Tiers", threadId: "thr_t1" },
      { id: "t2", projectId: "p_b", title: "Login", threadId: "thr_t2" },
      { id: "t3", projectId: "p_a", title: "Not started", threadId: null },
      { id: "t4", projectId: "p_h", title: "Quiet", threadId: "thr_t4" },
    ],
    children: [
      { taskId: "t1", threadId: "thr_r1", kind: "research", label: "prices" },
      { taskId: "t1", threadId: "thr_b1", kind: "build", label: "task/tiers" },
      { taskId: "t1", threadId: "thr_gone", kind: "build", label: "old" },
    ],
    liveThreadIds: new Set(["thr_r1", "thr_b1"]),
    badges: new Map([
      ["p_a", { needsYou: 2, working: 1 }],
    ]),
    focusProjectId: "p_a",
    activeThreadId: null,
    otherAgents: 3,
    ...overrides,
  };
}

const keys = (rows: SidebarRow[]) => rows.map((row) => row.key);

describe("shouldAdoptSidebar", () => {
  it("switches only the host's default list, and only once", () => {
    expect(shouldAdoptSidebar("thread-list/thread-list", false)).toBe(true);
    expect(shouldAdoptSidebar("__automatic__", false)).toBe(true);
    expect(shouldAdoptSidebar("__builtin__", false)).toBe(true);
    expect(shouldAdoptSidebar("thread-list/thread-list", true)).toBe(false);
  });

  it("leaves a list the owner picked themself, ours included", () => {
    expect(shouldAdoptSidebar("someone-else/list", false)).toBe(false);
    expect(shouldAdoptSidebar(threadListProviderId("the-orchestrator"), false)).toBe(false);
  });

  it("names the provider the way the host does", () => {
    expect(threadListProviderId("the-orchestrator")).toBe("the-orchestrator/chats");
  });
});

describe("sidebarRows", () => {
  it("lists every chat, the focused project's tasks with their live children, then other agents", () => {
    const rows = sidebarRows(input());
    expect(keys(rows)).toEqual(["chat:p_a", "task:t1", "child:thr_r1", "child:thr_b1", "chat:p_b", "agents"]);
    expect(rows[0]).toMatchObject({ threadId: "thr_pa", unread: true, focused: true, badge: { needsYou: 2, working: 1 } });
    expect(rows[2]).toMatchObject({ title: "Research: prices", depth: 1 });
    expect(rows[4]).toMatchObject({ threadId: null, badge: { needsYou: 0, working: 0 }, focused: false });
    expect(rows[5]).toEqual({ kind: "agents", key: "agents", count: 3 });
  });

  it("carries each task's and child's liveness indicator, and none when nothing runs", () => {
    const rows = sidebarRows(
      input({
        indicators: new Map([
          ["thr_t1", { kind: "working" as const }],
          ["thr_b1", { kind: "trouble" as const, reason: "no activity for 13 min" }],
        ]),
      }),
    );
    expect(rows.find((row) => row.key === "task:t1")).toMatchObject({ indicator: { kind: "working" } });
    expect(rows.find((row) => row.key === "child:thr_b1")).toMatchObject({ indicator: { kind: "trouble", reason: "no activity for 13 min" } });
    expect(rows.find((row) => row.key === "child:thr_r1")).toMatchObject({ indicator: null });
    expect(sidebarRows(input()).find((row) => row.key === "task:t1")).toMatchObject({ indicator: null });
  });

  it("has no Any-project row: with no focus it opens the first visible project", () => {
    const rows = sidebarRows(input({ focusProjectId: null }));
    expect(keys(rows)).toEqual(["chat:p_a", "task:t1", "child:thr_r1", "child:thr_b1", "chat:p_b", "agents"]);
    expect(rows[0]).toMatchObject({ focused: true });
    expect(rows.some((row) => row.kind === "task" && row.projectId !== "p_a")).toBe(false);
  });

  it("follows the active thread's project over the board's focus, and marks that row", () => {
    const rows = sidebarRows(input({ activeThreadId: "thr_b1" }));
    expect(rows.filter((row) => row.kind === "task" && row.active).map((row) => row.key)).toEqual(["child:thr_b1"]);

    const onBeta = sidebarRows(input({ activeThreadId: "thr_t2" }));
    expect(keys(onBeta)).toEqual(["chat:p_a", "chat:p_b", "task:t2", "agents"]);
    expect(onBeta.find((row) => row.key === "task:t2")).toMatchObject({ active: true });
  });

  it("marks a chat active when its own thread is open", () => {
    const rows = sidebarRows(input({ activeThreadId: "thr_pa", focusProjectId: "p_b" }));
    expect(rows[0]).toMatchObject({ key: "chat:p_a", active: true, focused: false });
    expect(expandedProject(input({ activeThreadId: "thr_pa", focusProjectId: "p_b" }))).toBe("p_a");
  });

  it("keeps a hidden project's chat reachable while it is in view", () => {
    expect(keys(sidebarRows(input({ focusProjectId: "p_h" })))).toEqual([
      "chat:p_a",
      "chat:p_b",
      "chat:p_h",
      "task:t4",
      "agents",
    ]);
  });

  it("opens the first visible project when the focused one is gone", () => {
    const rows = sidebarRows(input({ focusProjectId: "p_removed" }));
    expect(keys(rows).slice(0, 2)).toEqual(["chat:p_a", "task:t1"]);
    expect(rows[0]).toMatchObject({ focused: true });
  });

  it("lists only other agents with no projects at all", () => {
    expect(keys(sidebarRows(input({ projects: [], focusProjectId: null })))).toEqual(["agents"]);
  });
});
