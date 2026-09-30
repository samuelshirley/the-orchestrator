import { describe, expect, it } from "vitest";
import { isDocsOnly, isOrchestratorOnly, plumbingRefusal } from "./plumbing";

describe("plumbingRefusal (real app-repo PRs)", () => {
  it("#61: app code with its CLAUDE.md and design doc is fine", () => {
    expect(
      plumbingRefusal([
        "CLAUDE.md",
        "docs/design/subscriptions.md",
        "src/lib/paywallCopy.ts",
        "src/server/payments/copy.ts",
      ]),
    ).toBeNull();
  });

  it("#56: a .worktreeinclude is refused by name", () => {
    const why = plumbingRefusal([".worktreeinclude"]);
    expect(why).toContain("Orchestrator plumbing stays out of app repos");
    expect(why).toContain("Drop these from the branch: .worktreeinclude.");
  });

  it("#60: a root .mcp.json is refused", () => {
    const why = plumbingRefusal([".mcp.json", "docs/design/playwright-mcp.md"]);
    expect(why).toContain(".mcp.json");
    expect(why).not.toContain("playwright-mcp.md");
  });

  it("#57: a docs-only branch is refused", () => {
    expect(plumbingRefusal(["docs/design/mobile-release.md"])).toBe(
      "A PR to an app repo carries app code: docs ride with the change they describe.",
    );
  });

  it("repo config (.gitignore, CI) is app code", () => {
    expect(plumbingRefusal([".gitignore", ".github/workflows/ci.yml"])).toBeNull();
  });

  it("refuses .claude/ but not a file merely named claude", () => {
    expect(plumbingRefusal([".claude/settings.local.json"])).toContain(".claude/settings.local.json");
    expect(plumbingRefusal(["src/claude.ts"])).toBeNull();
  });

  it("only the root .mcp.json is plumbing", () => {
    expect(plumbingRefusal(["mobile/.mcp.json"])).toBeNull();
  });

  it("refuses an agent brief riding with app code", () => {
    expect(plumbingRefusal(["docs/bugs/x-prompt.md", "src/app/page.tsx"])).toContain("docs/bugs/x-prompt.md");
  });

  it("no files, no refusal", () => {
    expect(plumbingRefusal([])).toBeNull();
  });

  it("names at most 8, then counts the rest", () => {
    const files = Array.from({ length: 10 }, (_, i) => `.claude/f${i}`);
    const why = plumbingRefusal(files) ?? "";
    expect(why).toContain(".claude/f7");
    expect(why).not.toContain(".claude/f8");
    expect(why).toContain("…and 2 more");
  });
});

describe("isOrchestratorOnly", () => {
  it("covers each subtree and exact file", () => {
    for (const file of [
      ".bb-env-setup.sh",
      ".claude-tmp/x",
      ".handoff/notes.md",
      ".playwright-mcp/shot.png",
      "docs/tasks/release.md",
      "./.worktreeinclude",
    ]) {
      expect(isOrchestratorOnly(file), file).toBe(true);
    }
    expect(isOrchestratorOnly("docs/prompt.md")).toBe(false);
    expect(isOrchestratorOnly("src/prompt-builder.ts")).toBe(false);
  });
});

describe("isDocsOnly", () => {
  it("is docs/ and Markdown at any depth", () => {
    expect(isDocsOnly("docs/diagram.png")).toBe(true);
    expect(isDocsOnly("mobile/README.md")).toBe(true);
    expect(isDocsOnly("CLAUDE.md")).toBe(true);
    expect(isDocsOnly("src/docs.ts")).toBe(false);
  });
});
