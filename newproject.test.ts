import { describe, expect, it } from "vitest";
import {
  GH_LOGIN_ARGS,
  NEW_PROJECT_STEPS,
  PROJECTS_DIR,
  firstCommitFiles,
  firstCommitMessage,
  folderExistsReason,
  ghCreateArgs,
  ghRetryCommand,
  parseGhLogin,
  projectSlug,
  validateNewProject,
  visibilityFromStatus,
} from "./newproject";
import { setOwner } from "./owner";
import { profileFor } from "./profiles";

const parent = "/Users/me/Documents/Github";
const none = { names: [], paths: [] };

describe("projectSlug", () => {
  it("lower-cases and dashes spaces", () => {
    expect(projectSlug("Café Río")).toBe("cafe-rio");
  });
  it("drops accents", () => {
    expect(projectSlug("Café Girona")).toBe("cafe-girona");
    expect(projectSlug("Ñandú")).toBe("nandu");
  });
  it("collapses runs of other characters and trims dashes", () => {
    expect(projectSlug("  --Hello,   World!!  ")).toBe("hello-world");
    expect(projectSlug("a_b.c/d")).toBe("a-b-c-d");
  });
  it("caps at 60 without a trailing dash", () => {
    const slug = projectSlug(`${"a".repeat(59)} b`);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
  });
  it("is empty for a name with no letters or digits", () => {
    expect(projectSlug("!!! ---")).toBe("");
  });
});

describe("validateNewProject", () => {
  it("accepts a good name and says where it goes", () => {
    expect(validateNewProject("Café Río", none, parent)).toEqual({
      ok: true,
      slug: "cafe-rio",
      path: `${parent}/cafe-rio`,
    });
  });
  it("refuses an empty or whitespace name", () => {
    for (const name of ["", "   "]) {
      expect(validateNewProject(name, none, parent)).toEqual({ ok: false, reason: "Give the project a name." });
    }
  });
  it("refuses a name over 60 characters", () => {
    expect(validateNewProject("x".repeat(61), none, parent).ok).toBe(false);
    expect(validateNewProject("x".repeat(60), none, parent).ok).toBe(true);
  });
  it("refuses a name whose slug is empty", () => {
    const check = validateNewProject("¿¡!?", none, parent);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/letter or digit/);
  });
  it("refuses an existing project name, case-insensitively", () => {
    const check = validateNewProject("café río", { names: ["Café Río"], paths: [] }, parent);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain("Café Río");
  });
  it("refuses a path that is already a project", () => {
    const check = validateNewProject("Café", { names: ["Other"], paths: [`${parent}/cafe/`] }, parent);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain(`${parent}/cafe`);
  });
  it("tolerates a trailing slash on the parent", () => {
    const check = validateNewProject("x", none, `${parent}/`);
    expect(check.ok && check.path).toBe(`${parent}/x`);
  });
});

describe("folderExistsReason", () => {
  it("names the path and the other way in", () => {
    expect(folderExistsReason("/a/b")).toMatch(/\/a\/b already exists.*Add existing folder/);
  });
});

describe("firstCommitFiles", () => {
  const files = firstCommitFiles("Café Río");
  const file = (path: string) => files.find((entry) => entry.path === path)?.content ?? "";
  it("writes README, CLAUDE.md and .gitignore", () => {
    expect(files.map((entry) => entry.path).sort()).toEqual([".gitignore", "CLAUDE.md", "README.md"]);
  });
  it("titles README and CLAUDE.md with the name", () => {
    expect(file("README.md").startsWith("# Café Río\n")).toBe(true);
    expect(file("CLAUDE.md").startsWith("# CLAUDE.md: Café Río\n")).toBe(true);
  });
  it("puts the rules in CLAUDE.md", () => {
    expect(file("CLAUDE.md")).toMatch(/Never touch production data/);
    expect(file("CLAUDE.md")).toContain("- Merging is the owner's, never an agent's.");
    // A new repo never carries the name of whoever made it (owner.ts).
    setOwner("Alex");
    try {
      expect(firstCommitFiles("Café Río").find((entry) => entry.path === "CLAUDE.md")?.content).not.toMatch(/Alex/);
    } finally {
      setOwner(null);
    }
  });
  it("ignores .claude/, which builds require", () => {
    expect(file(".gitignore").split("\n")).toContain(".claude/");
    expect(file(".gitignore").split("\n")).toEqual(expect.arrayContaining([".DS_Store", ".env*"]));
  });
  it("names the first commit", () => {
    expect(firstCommitMessage(" Café Río ")).toBe("Café Río: first commit");
  });
});

describe("gh repo create", () => {
  it("creates a private repo under the given owner and pushes", () => {
    expect(ghCreateArgs("octocat", "cafe-rio", "/p/cafe-rio")).toEqual([
      "repo",
      "create",
      "octocat/cafe-rio",
      "--private",
      "--source",
      "/p/cafe-rio",
      "--remote",
      "origin",
      "--push",
    ]);
  });
  it("is never public", () => {
    const args = ghCreateArgs("octocat", "x", "/p/x");
    expect(args).toContain("--private");
    expect(args).not.toContain("--public");
    expect(args).not.toContain("--internal");
    expect(ghRetryCommand("octocat", "x", "/p/x")).toContain("--private");
    expect(ghRetryCommand("octocat", "x", "/p/x")).not.toContain("--public");
  });
  it("gives a pasteable retry command, path quoted", () => {
    expect(ghRetryCommand("octocat", "cafe-rio", "/Users/me/Documents/Github/cafe-rio")).toBe(
      "gh repo create octocat/cafe-rio --private --source '/Users/me/Documents/Github/cafe-rio' --remote origin --push",
    );
    expect(ghRetryCommand("octocat", "a", "/it's")).toContain(`'/it'\\''s'`);
  });
});

describe("parseGhLogin", () => {
  it("asks gh who is signed in", () => {
    expect(GH_LOGIN_ARGS).toEqual(["api", "user", "--jq", ".login"]);
  });
  it("accepts a GitHub login, trimmed", () => {
    expect(parseGhLogin("octo-cat")).toBe("octo-cat");
    expect(parseGhLogin("a-b1")).toBe("a-b1");
    expect(parseGhLogin("octocat\n")).toBe("octocat");
    expect(parseGhLogin("a".repeat(39))).toBe("a".repeat(39));
  });
  it("refuses anything that is not a login", () => {
    for (const bad of ["", "a b", "a/b", "-a", "x; rm -rf ~", "a".repeat(40), "a\nb"]) {
      expect(parseGhLogin(bad)).toBeNull();
    }
  });
});

describe("visibilityFromStatus", () => {
  it("reads an unauthenticated lookup", () => {
    expect(visibilityFromStatus(404)).toBe("private");
    expect(visibilityFromStatus(200)).toBe("public");
    expect(visibilityFromStatus(403)).toBe("unknown");
    expect(visibilityFromStatus(500)).toBe("unknown");
  });
});

describe("the order", () => {
  it("commits before gh, and verifies last", () => {
    expect(NEW_PROJECT_STEPS.indexOf("git commit")).toBeLessThan(NEW_PROJECT_STEPS.indexOf("gh repo create --private --push"));
    expect(NEW_PROJECT_STEPS[NEW_PROJECT_STEPS.length - 1]).toBe("verify private");
    expect(PROJECTS_DIR).toEqual(["Documents", "Github"]);
  });
});

describe("a new project's profile", () => {
  it("is PR-based, never land: main", () => {
    expect(
      profileFor({ name: "some-new-thing", gitRemoteUrl: "https://github.com/octocat/some-new-thing.git" }).land,
    ).toBe("pr");
  });
});
