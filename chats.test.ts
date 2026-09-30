import { describe, expect, it } from "vitest";
import {
  RETIRED_ANY_CHAT_KEY,
  chatKey,
  chatOfThreadKey,
  chatRefusal,
  chatTasks,
  claimedChat,
  focusedProject,
  isUnread,
  parentFixes,
  reattachedMessage,
  replyAtKey,
  seenAtKey,
  shouldStartChat,
  unheardReason,
} from "./chats";

describe("chat keys", () => {
  it("gives each project its own key, in the format existing chats were stored under", () => {
    expect(chatKey("proj_a")).toBe("orchestrator_thread_id:proj_a");
    expect(chatKey("proj_a")).not.toBe(chatKey("proj_b"));
  });

  it("has no key for a chat outside a project: the Any-project chat is gone", () => {
    for (const id of ["proj_a", "*", ""]) expect(chatKey(id)).not.toBe(RETIRED_ANY_CHAT_KEY);
  });

  it("scopes reply and seen times to the chat", () => {
    expect(replyAtKey("proj_a")).toBe("chat_reply_at:orchestrator_thread_id:proj_a");
    expect(seenAtKey("proj_a")).toBe("chat_seen_at:orchestrator_thread_id:proj_a");
    expect(chatOfThreadKey("thr_1")).toBe("chat_of_thread:thr_1");
  });
});

describe("focusedProject", () => {
  const projects = [
    { id: "p_h", hidden: true },
    { id: "p_a", hidden: false },
    { id: "p_b", hidden: false },
  ];

  it("keeps the stored project while it exists", () => {
    expect(focusedProject("p_b", projects)).toBe("p_b");
  });

  it("keeps a hidden project the owner opened", () => {
    expect(focusedProject("p_h", projects)).toBe("p_h");
  });

  it("picks the first visible project when nothing is stored (the old Any project)", () => {
    expect(focusedProject(null, projects)).toBe("p_a");
  });

  it("picks the first visible project when the stored one is gone", () => {
    expect(focusedProject("p_removed", projects)).toBe("p_a");
  });

  it("picks the first project when every one is hidden", () => {
    expect(focusedProject(null, [{ id: "p_h", hidden: true }])).toBe("p_h");
  });

  it("is null only with no projects at all", () => {
    expect(focusedProject(null, [])).toBeNull();
    expect(focusedProject("p_a", [])).toBeNull();
  });
});

describe("isUnread", () => {
  it("is unread when a reply came after the last look and the chat is not shown", () => {
    expect(isUnread({ replyAt: 200, seenAt: 100, shown: false })).toBe(true);
  });

  it("is unread when a reply came and the chat was never seen", () => {
    expect(isUnread({ replyAt: 5, seenAt: null, shown: false })).toBe(true);
  });

  it("is read when no reply has come", () => {
    expect(isUnread({ replyAt: null, seenAt: null, shown: false })).toBe(false);
    // Even against a seen time that is not a real time: no reply, nothing unread.
    expect(isUnread({ replyAt: null, seenAt: -1, shown: false })).toBe(false);
  });

  it("counts a never-seen chat as seen at 0", () => {
    expect(isUnread({ replyAt: 0, seenAt: null, shown: false })).toBe(false);
    expect(isUnread({ replyAt: 1, seenAt: null, shown: false })).toBe(true);
  });

  it("is read when the owner looked after the reply", () => {
    expect(isUnread({ replyAt: 100, seenAt: 200, shown: false })).toBe(false);
  });

  it("is read when the owner looked in the same millisecond as the reply", () => {
    expect(isUnread({ replyAt: 100, seenAt: 100, shown: false })).toBe(false);
  });

  it("is never unread while it is the chat on screen", () => {
    expect(isUnread({ replyAt: 200, seenAt: 100, shown: true })).toBe(false);
  });
});

describe("claimedChat", () => {
  const base = { projectId: "proj_a", projectKind: "standard" as const };

  it("no longer makes an orchestrator thread in Personal with no project a chat", () => {
    expect(claimedChat({ role: "orchestrator", metadataProjectId: undefined, projectId: "personal", projectKind: "personal" })).toBeNull();
    expect(claimedChat({ role: "orchestrator", metadataProjectId: null, projectId: "personal", projectKind: "personal" })).toBeNull();
  });

  it("makes an orchestrator thread in its own project that project's chat", () => {
    expect(claimedChat({ ...base, role: "orchestrator", metadataProjectId: "proj_a" })).toEqual({ projectId: "proj_a" });
  });

  it("refuses a thread that was not started as Patches", () => {
    expect(claimedChat({ ...base, role: "task", metadataProjectId: "proj_a" })).toBeNull();
  });

  it("refuses a project chat whose thread lives in another project", () => {
    expect(claimedChat({ ...base, role: "orchestrator", metadataProjectId: "proj_b" })).toBeNull();
  });

  it("refuses a chat with no project outside Personal", () => {
    expect(claimedChat({ ...base, role: "orchestrator", metadataProjectId: undefined })).toBeNull();
  });

  it("refuses a project chat in Personal", () => {
    expect(claimedChat({ role: "orchestrator", metadataProjectId: "personal", projectId: "personal", projectKind: "personal" })).toBeNull();
  });

  it("refuses a non-string project id", () => {
    expect(claimedChat({ ...base, role: "orchestrator", metadataProjectId: 7 })).toBeNull();
  });
});

describe("chatTasks", () => {
  const tasks = [
    { id: "task_1", projectId: "proj_a" },
    { id: "task_2", projectId: "proj_b" },
    { id: "task_3", projectId: "proj_a" },
  ];

  it("gives a chat only its own project's tasks, in order", () => {
    expect(chatTasks(tasks, "proj_a").map((task) => task.id)).toEqual(["task_1", "task_3"]);
    expect(chatTasks(tasks, "proj_b").map((task) => task.id)).toEqual(["task_2"]);
  });

  it("gives a project with no tasks none", () => {
    expect(chatTasks(tasks, "proj_c")).toEqual([]);
  });
});

describe("chatRefusal", () => {
  it("lets a chat act on its own project's task", () => {
    expect(chatRefusal("proj_a", { id: "task_1", projectId: "proj_a" }, "Alpha")).toBeNull();
  });

  it("refuses another project's task and names the chat that can", () => {
    expect(chatRefusal("proj_a", { id: "task_2", projectId: "proj_b" }, "Beta")).toBe(
      "task_2 is in Beta: ask in Beta's Patches chat.",
    );
  });
});

describe("shouldStartChat", () => {
  const base = { hasChat: false, hasCheckout: true, kind: "standard" as const };

  it("starts a chat for a project with a checkout and no chat", () => {
    expect(shouldStartChat(base)).toBe(true);
  });

  it("never starts a second chat", () => {
    expect(shouldStartChat({ ...base, hasChat: true })).toBe(false);
  });

  it("needs a local checkout to start in", () => {
    expect(shouldStartChat({ ...base, hasCheckout: false })).toBe(false);
  });

  it("never starts one in Personal", () => {
    expect(shouldStartChat({ ...base, kind: "personal" })).toBe(false);
  });
});

describe("parentFixes", () => {
  const chats = new Map<string, string | null>([
    ["p_ft", "thr_ft_new"],
    ["p_orc", "thr_orc"],
    ["p_none", null],
  ]);
  const fixesFor = (parent: string | null | undefined, projectId = "p_ft") =>
    parentFixes({
      tasks: [{ id: "task_1", projectId, threadId: "thr_t" }],
      parents: parent === undefined ? new Map() : new Map([["thr_t", parent]]),
      chats,
    });

  it("re-attaches a task with no parent, an archived chat or another project's chat", () => {
    // The bug: every open task was detached or left under an archived chat, so no chat heard it go idle.
    const fix = [{ taskId: "task_1", threadId: "thr_t", projectId: "p_ft", chatThreadId: "thr_ft_new" }];
    expect(fixesFor(null)).toEqual(fix);
    expect(fixesFor("thr_ft_old_archived")).toEqual(fix);
    expect(fixesFor("thr_orc")).toEqual(fix);
  });

  it("leaves a task under its own chat, and one whose parent is unknown", () => {
    expect(fixesFor("thr_ft_new")).toEqual([]);
    expect(fixesFor(undefined)).toEqual([]);
  });

  it("says when the project has no chat to hang it under", () => {
    expect(fixesFor(null, "p_none")).toEqual([{ taskId: "task_1", threadId: "thr_t", projectId: "p_none", chatThreadId: null }]);
    expect(fixesFor(null, "p_unknown")).toMatchObject([{ chatThreadId: null }]);
  });

  it("skips a task with no thread", () => {
    expect(parentFixes({ tasks: [{ id: "task_1", projectId: "p_ft", threadId: null }], parents: new Map(), chats })).toEqual([]);
  });
});

describe("reattachedMessage", () => {
  it("names every task once, one line each", () => {
    expect(reattachedMessage("AcmeGoods", [{ id: "task_a", title: "Fix login" }, { id: "task_b", title: "Tiers" }])).toBe(
      "[The Orchestrator] Re-attached 2 tasks of AcmeGoods to this chat: they had no live Patches chat as parent, so you heard nothing from them. Check each with task_status and send it what it needs next:\n- task_a: Fix login\n- task_b: Tiers",
    );
    expect(reattachedMessage("X", [{ id: "task_a", title: "A" }])).toContain("Re-attached 1 task of X");
  });
});

describe("unheardReason", () => {
  it("is null when the task is heard, and says why when not", () => {
    expect(unheardReason(undefined, "AcmeGoods")).toBeNull();
    expect(unheardReason({ taskId: "t", threadId: "thr", projectId: "p", chatThreadId: "thr_c" }, "AcmeGoods")).toBe(
      "No Patches chat hears it (its parent is not AcmeGoods' chat)",
    );
    expect(unheardReason({ taskId: "t", threadId: "thr", projectId: "p", chatThreadId: null }, "AcmeGoods")).toContain("has no live chat");
    expect(unheardReason({ taskId: "t", threadId: "thr", projectId: "p", chatThreadId: "thr_c" }, "Café Río")).toContain("Café Río's chat");
  });
});
