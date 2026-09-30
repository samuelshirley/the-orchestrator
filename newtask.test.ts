import { describe, expect, it } from "vitest";
import {
  BRIEF_MAX,
  TITLE_CAP,
  TITLE_MODEL,
  newTaskBlock,
  parentChatFor,
  parseSummaryTitle,
  summaryTitlePrompt,
  taskFromAsk,
  taskNewInput,
  type RegisteredChat,
} from "./newtask";

const shop = { id: "proj_f", name: "AcmeGoods", path: "/repos/shop", hostId: "host_1" };
const own: RegisteredChat = { projectId: "proj_f", threadId: "thr_shop" };
const other: RegisteredChat = { projectId: "proj_o", threadId: "thr_other" };

describe("newTaskBlock", () => {
  it("allows a project with a local checkout", () => {
    expect(newTaskBlock({ project: shop })).toBeNull();
  });

  it("is off with no project to work in", () => {
    expect(newTaskBlock({ project: null })).toBe("Add a project first: a task works in one project");
  });

  it("is off without a local checkout", () => {
    expect(newTaskBlock({ project: { ...shop, path: null } })).toBe("AcmeGoods has no local checkout");
    expect(newTaskBlock({ project: { ...shop, hostId: null } })).toBe("AcmeGoods has no local checkout");
  });
});

describe("parentChatFor", () => {
  it("picks the project's own chat", () => {
    expect(parentChatFor("proj_f", [other, own])).toBe("thr_shop");
  });

  it("never falls back to another project's chat: the server starts the project's own", () => {
    expect(parentChatFor("proj_f", [other])).toBeNull();
    expect(parentChatFor("proj_f", [])).toBeNull();
  });
});

describe("taskFromAsk", () => {
  it("keeps the trimmed message verbatim as the brief", () => {
    const text = "  Fix the image upload. It fails on HEIC.\n\nSee the screenshot.  ";
    expect(taskFromAsk(text)).toEqual({
      title: "Fix the image upload",
      brief: "Fix the image upload. It fails on HEIC.\n\nSee the screenshot.",
    });
  });

  it("refuses a message too short to act on", () => {
    expect(() => taskFromAsk("   fix it  ")).toThrow("Say a little more about what the task should do.");
    expect(() => taskFromAsk("")).toThrow("Say a little more");
  });

  it("takes exactly the start_task minimum", () => {
    expect(() => taskFromAsk("123456789")).toThrow("Say a little more");
    expect(taskFromAsk("1234567890").brief).toBe("1234567890");
  });

  it("refuses a message longer than start_task allows", () => {
    expect(() => taskFromAsk("a".repeat(BRIEF_MAX + 1))).toThrow(/^Too long/);
    expect(taskFromAsk("a ".repeat(BRIEF_MAX / 2)).brief.length).toBeLessThanOrEqual(BRIEF_MAX);
  });

  it("titles from the first non-empty line, without markdown noise", () => {
    expect(taskFromAsk("\n\n## Add dark mode to settings\nmore detail here").title).toBe("Add dark mode to settings");
    expect(taskFromAsk("- [ ] > Add a filter\nand sort").title).toBe("[ ] > Add a filter");
    expect(taskFromAsk("> * Quote then bullet about maps").title).toBe("Quote then bullet about maps");
    expect(taskFromAsk("1. Rename the tiers\n2. Update prices").title).toBe("Rename the tiers");
    expect(taskFromAsk("2) Rename the tiers please").title).toBe("Rename the tiers please");
  });

  it("cuts at the first sentence end, keeping a question mark", () => {
    expect(taskFromAsk("Why is the map blank? It was fine yesterday").title).toBe("Why is the map blank?");
    expect(taskFromAsk("Ship the tiers! Today, please").title).toBe("Ship the tiers!");
    expect(taskFromAsk("No sentence end at all here").title).toBe("No sentence end at all here");
  });

  it("does not cut when the first sentence is too short", () => {
    expect(taskFromAsk("Hi. Please fix the login page").title).toBe("Hi. Please fix the login page");
  });

  it("caps a long title at a word boundary", () => {
    const words = "Make the itinerary page load faster by caching the day cards and lazy loading every photo in the gallery";
    const { title } = taskFromAsk(words);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith("…")).toBe(true);
    expect(words.startsWith(title.slice(0, -1))).toBe(true);
    expect(title.slice(0, -1).endsWith(" ")).toBe(false);
    expect(words[title.length - 1]).toBe(" ");
  });

  it("keeps an 80-character title whole and cuts an 81-character one", () => {
    expect(taskFromAsk("y".repeat(80)).title).toBe("y".repeat(80));
    expect(taskFromAsk("y".repeat(81)).title).toBe(`${"y".repeat(79)}…`);
  });

  it("caps a title with no spaces by cutting it", () => {
    const { title } = taskFromAsk("x".repeat(200));
    expect(title).toBe(`${"x".repeat(79)}…`);
  });

  it("falls back when no usable title is left", () => {
    expect(taskFromAsk("#\n-\nok\n\n and more text").title).toBe("New task");
  });
});

/** The host's RPC rule (plugin SDK strictJsonRoundTrip): the path of the first non-JSON value. */
function nonJson(value: unknown, path = "$"): string | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? null : path;
  if (typeof value !== "object") return path;
  const entries = Array.isArray(value) ? value.map((item, index) => [`[${index}]`, item] as const) : Object.entries(value).map(([key, child]) => [`.${key}`, child] as const);
  for (const [step, child] of entries) {
    const found = nonJson(child, `${path}${step}`);
    if (found !== null) return found;
  }
  return null;
}

describe("taskNewInput", () => {
  const parts = [{ type: "text", text: "Fix the itinerary page", mentions: [] }];

  it("leaves out every unset pick, nested ones too", () => {
    const result = taskNewInput({
      projectId: "proj_f",
      input: [{ type: "text", text: "Fix the itinerary page", mentions: [], attachment: undefined }],
      providerId: undefined,
      model: undefined,
      reasoningLevel: undefined,
      permissionMode: undefined,
      serviceTier: undefined,
      executionInputSources: { providerId: "explicit", serviceTier: undefined },
    });
    expect(nonJson(result)).toBeNull();
    expect(result).toEqual({
      projectId: "proj_f",
      input: parts,
      executionInputSources: { providerId: "explicit" },
    });
    expect(Object.keys(result)).toEqual(["projectId", "input", "executionInputSources"]);
    expect(Object.keys(result.input[0] as object)).toEqual(["type", "text", "mentions"]);
  });

  it("keeps every pick that is set", () => {
    const request = {
      projectId: "proj_f",
      input: parts,
      providerId: "claude-code",
      model: "claude-opus-5-5",
      reasoningLevel: "high",
      permissionMode: "auto",
      serviceTier: "fast",
      executionInputSources: { providerId: "explicit", serviceTier: "client-preference" },
    };
    expect(taskNewInput(request)).toEqual(request);
  });

  it("carries nothing the composer adds beyond task_new's fields", () => {
    const request = { projectId: "proj_f", input: parts, title: "extra" } as { projectId: string; input: typeof parts; title: string };
    expect(taskNewInput(request)).toEqual({ projectId: "proj_f", input: parts });
  });

  it("keeps null and falsy values, which are JSON", () => {
    const result = taskNewInput({ projectId: "proj_f", input: [{ type: "text", text: "", flag: false, n: 0, x: null }] });
    expect(result.input).toEqual([{ type: "text", text: "", flag: false, n: 0, x: null }]);
  });
});

describe("summaryTitlePrompt", () => {
  it("asks for one short title and carries the brief", () => {
    const prompt = summaryTitlePrompt("  I blurb talked a lot and I want the title to be a summary.  ");
    expect(prompt).toContain("3 to 8 word");
    expect(prompt).toContain("Fix task summary header");
    expect(prompt).toContain("reply with the title only");
    expect(prompt.endsWith("I blurb talked a lot and I want the title to be a summary.")).toBe(true);
  });

  it("uses the cheapest model", () => {
    expect(TITLE_MODEL).toBe("claude-haiku-4-5");
  });
});

describe("parseSummaryTitle", () => {
  it("keeps a clean reply as it is", () => {
    expect(parseSummaryTitle("Fix task summary header")).toBe("Fix task summary header");
  });

  it("takes the first non-empty line", () => {
    expect(parseSummaryTitle("\n\n  Fix task summary header  \nBecause the title was long.")).toBe("Fix task summary header");
  });

  it("strips quotes, backticks and a trailing period", () => {
    expect(parseSummaryTitle('"Fix task summary header."')).toBe("Fix task summary header");
    expect(parseSummaryTitle("`Fix task summary header`")).toBe("Fix task summary header");
    expect(parseSummaryTitle("\u201cFix task summary header\u201d")).toBe("Fix task summary header");
  });

  it("strips markdown and a Title: prefix", () => {
    expect(parseSummaryTitle("# Fix task summary header")).toBe("Fix task summary header");
    expect(parseSummaryTitle("**Fix task summary header**")).toBe("Fix task summary header");
    expect(parseSummaryTitle("Title: Fix task summary header")).toBe("Fix task summary header");
    expect(parseSummaryTitle('**Title:** "Fix task summary header".')).toBe("Fix task summary header");
  });

  it("collapses whitespace", () => {
    expect(parseSummaryTitle("Fix   task\tsummary  header")).toBe("Fix task summary header");
  });

  it("refuses an empty reply", () => {
    expect(parseSummaryTitle("")).toBeNull();
    expect(parseSummaryTitle("  \n \n")).toBeNull();
    expect(parseSummaryTitle('""')).toBeNull();
  });

  it("refuses a title shorter than the minimum", () => {
    expect(parseSummaryTitle("Go")).toBeNull();
    expect(parseSummaryTitle("Fix")).toBe("Fix");
  });

  it("refuses a title longer than the cap", () => {
    expect(parseSummaryTitle("a".repeat(TITLE_CAP))).toBe("a".repeat(TITLE_CAP));
    expect(parseSummaryTitle("a".repeat(TITLE_CAP + 1))).toBeNull();
  });
});
