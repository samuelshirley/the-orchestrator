import { describe, expect, it } from "vitest";
import { LOCAL_CONFIG_MAX_CHARS, parseLocalConfig } from "./localconfig";
import { parseGhLogin } from "./newproject";
import type { ProjectProfile } from "./profiles";
import {
  DEFAULT_PROJECTS_DIR,
  GH_SIGN_IN_COMMAND,
  NO_REPOS_NOTE,
  PROJECTS_DIR_MAX,
  REPO_LIST_CAP,
  claudeSignIn,
  ghSignIn,
  mergeSetupIntoConfig,
  needsSetup,
  originUrlOf,
  ownerNameToSave,
  pickRepos,
  projectsDirInForce,
  repoChoices,
  safeRemote,
  signInLine,
  validateProjectsDir,
  type RepoEntry,
} from "./setupwizard";

const HOME = "/Users/me";

const SHOP: ProjectProfile = {
  key: "acme-shop",
  names: ["Acme Shop"],
  remotes: ["acme/shop"],
  checks: ["npm test"],
  ci: "full",
  markers: { preview: "<!-- preview -->", e2e: null, ios: null },
  iosPaths: [],
  aiTestsLabel: "ai-tests",
  aiRanPatterns: ["ai tests? ran"],
  sharedPaths: ["package.json"],
  mirrors: [["web/a.ts", "mobile/a.ts"]],
  build: "worktree",
  land: "pr",
  backup: null,
  afterLand: [],
  worktreeInclude: [".mcp.json"],
  productionEnv: true,
  setup: [["npm", "ci"]],
  testRules: [{ pattern: "^src/", test: "npm test" }],
  rules: ["Never touch production data."],
};

describe("needsSetup", () => {
  it("is true only with no folder in the config and no projects", () => {
    expect(needsSetup({ projectsDir: null, projectCount: 0 })).toBe(true);
    expect(needsSetup({ projectsDir: "/Users/me/Code", projectCount: 0 })).toBe(false);
    expect(needsSetup({ projectsDir: null, projectCount: 1 })).toBe(false);
    expect(needsSetup({ projectsDir: "/Users/me/Code", projectCount: 3 })).toBe(false);
  });
  it("waits for a config that was read and has no problem", () => {
    expect(needsSetup({ projectsDir: null, projectCount: 0, configReady: false })).toBe(false);
    expect(needsSetup({ projectsDir: null, projectCount: 0, configReady: true })).toBe(true);
  });
});

describe("validateProjectsDir", () => {
  const ok = (path: string) => {
    const check = validateProjectsDir(path, HOME);
    if (!check.ok) throw new Error(check.reason);
    return check.path;
  };
  const refused = (path: string, home = HOME) => {
    const check = validateProjectsDir(path, home);
    if (check.ok) throw new Error(`${path} was allowed as ${check.path}`);
    return check.reason;
  };

  it("suggests ~/Documents/Github, which is allowed", () => {
    expect(DEFAULT_PROJECTS_DIR).toBe("~/Documents/Github");
    expect(ok(DEFAULT_PROJECTS_DIR)).toBe("/Users/me/Documents/Github");
  });
  it("expands a leading ~ and normalises", () => {
    expect(ok("~/Code")).toBe("/Users/me/Code");
    expect(ok("  /Users/me/Code/  ")).toBe("/Users/me/Code");
    expect(ok("/Users/me//Code/./repos/")).toBe("/Users/me/Code/repos");
    expect(validateProjectsDir("~/Code", "/Users/me/")).toEqual({ ok: true, path: "/Users/me/Code" });
  });
  it("refuses nothing, a relative path and another user's ~", () => {
    expect(refused("")).toContain("Say which folder");
    expect(refused("   ")).toContain("Say which folder");
    expect(refused("Code")).toContain("full path");
    expect(refused("~other/Code")).toContain("full path");
  });
  it("refuses the home folder itself, the disk and anything outside home", () => {
    expect(refused("~")).toContain("not the home folder itself");
    expect(refused("/Users/me/")).toContain("not the home folder itself");
    expect(refused("/")).toContain("whole disk");
    expect(refused("/etc")).toContain("inside your home folder");
    expect(refused("/Users/me2/Code")).toContain("inside your home folder");
    expect(refused("/Users")).toContain("inside your home folder");
  });
  it('refuses ".." anywhere, so nothing climbs out', () => {
    expect(refused("~/Code/../../other")).toContain('".."');
    expect(refused("/Users/me/../me/Code")).toContain('".."');
    expect(refused("~/..")).toContain('".."');
  });
  it("refuses control characters and a path over the cap", () => {
    expect(refused("~/Co\nde")).toContain("character");
    expect(refused("~/Co\u0000de")).toContain("character");
    expect(refused("~/Code‮")).toContain("character");
    expect(refused(`~/${"x".repeat(PROJECTS_DIR_MAX)}`)).toContain(String(PROJECTS_DIR_MAX));
    expect(ok(`/Users/me/${"x".repeat(PROJECTS_DIR_MAX - 10)}`).length).toBe(PROJECTS_DIR_MAX);
  });
  it("refuses everything while the home folder is not known", () => {
    expect(refused("~/Code", "")).toContain("home folder is not known");
    expect(refused("/Code", "/")).toContain("home folder is not known");
    expect(refused("~/Code", "Users/me")).toContain("home folder is not known");
  });
  it("what it allows, the config accepts", () => {
    expect(parseLocalConfig(JSON.stringify({ projectsDir: ok("~/Code") })).problem).toBeNull();
  });
});

describe("projectsDirInForce", () => {
  it("is the default with no folder in the config: an install without one behaves as before", () => {
    expect(projectsDirInForce(null, HOME)).toEqual({ ok: true, path: "/Users/me/Documents/Github" });
  });
  it("is the config's folder when it has one", () => {
    expect(projectsDirInForce("/Users/me/Code", HOME)).toEqual({ ok: true, path: "/Users/me/Code" });
  });
  it("refuses a config folder outside home rather than falling back", () => {
    const check = projectsDirInForce("/etc", HOME);
    expect(check.ok).toBe(false);
    expect(check.ok ? "" : check.reason).toContain("projectsDir in ~/.config/the-orchestrator/config.json is not usable");
  });
});

describe("repoChoices", () => {
  const entries: RepoEntry[] = [
    { name: "zeta", git: true, remote: "git@github.com:acme/zeta.git" },
    { name: "alpha", git: true, remote: null },
    { name: "notes", git: false, remote: null },
    { name: "shop", git: true, remote: "https://github.com/acme/shop.git" },
  ];
  it("lists in name order; a git repo that is not a project can be ticked", () => {
    const { choices, note } = repoChoices("/Users/me/Code/", { entries, truncated: false }, ["/Users/me/Code/shop/"]);
    expect(choices.map((choice) => choice.name)).toEqual(["alpha", "notes", "shop", "zeta"]);
    expect(choices.find((choice) => choice.name === "alpha")).toEqual({
      name: "alpha",
      path: "/Users/me/Code/alpha",
      remote: null,
      added: false,
      selectable: true,
      reason: null,
    });
    expect(choices.find((choice) => choice.name === "notes")).toMatchObject({ selectable: false, added: false, reason: "Not a git repo." });
    expect(choices.find((choice) => choice.name === "shop")).toMatchObject({ selectable: false, added: true, reason: "Already a project." });
    expect(note).toBeNull();
  });
  it("says so when there is no repo at all", () => {
    expect(repoChoices("/Users/me/Code", { entries: [], truncated: false }, []).note).toBe(NO_REPOS_NOTE);
    expect(repoChoices("/Users/me/Code", { entries: [entries[2]!], truncated: false }, []).note).toBe(NO_REPOS_NOTE);
    expect(NO_REPOS_NOTE).toContain("You can add projects later");
  });
  it("cuts at the cap and says so", () => {
    expect(REPO_LIST_CAP).toBe(200);
    const many = Array.from({ length: 250 }, (_, index) => ({ name: `r${String(index).padStart(3, "0")}`, git: true, remote: null }));
    const { choices, note } = repoChoices("/Users/me/Code", { entries: many, truncated: false }, []);
    expect(choices).toHaveLength(200);
    expect(choices[199]!.name).toBe("r199");
    expect(note).toContain("Only the first 200 folders are listed");
    expect(repoChoices("/Users/me/Code", { entries, truncated: true }, []).note).toContain("Only the first 200");
  });
  it("never lets a name that is not one folder be ticked", () => {
    const odd = ["../out", ".hidden", "a/b", "", "bad\nname"].map((name) => ({ name, git: true, remote: null }));
    for (const choice of repoChoices("/Users/me/Code", { entries: odd, truncated: false }, []).choices) {
      expect(choice.selectable).toBe(false);
    }
  });
});

describe("pickRepos", () => {
  const { choices } = repoChoices(
    "/Users/me/Code",
    {
      entries: [
        { name: "alpha", git: true, remote: null },
        { name: "notes", git: false, remote: null },
        { name: "shop", git: true, remote: null },
      ],
      truncated: false,
    },
    ["/Users/me/Code/shop"],
  );
  it("gives each ticked repo its path, or why it is not added", () => {
    expect(pickRepos(["alpha", "notes", "shop", "gone", "alpha"], choices)).toEqual([
      { name: "alpha", ok: true, path: "/Users/me/Code/alpha" },
      { name: "notes", ok: false, reason: "Not a git repo." },
      { name: "shop", ok: false, reason: "Already a project." },
      { name: "gone", ok: false, reason: "It is not in the folder any more." },
    ]);
    expect(pickRepos([], choices)).toEqual([]);
  });
});

describe("originUrlOf", () => {
  const config = [
    "[core]",
    "\trepositoryformatversion = 0",
    '[remote "upstream"]',
    "\turl = git@github.com:other/shop.git",
    '[remote "origin"]',
    "\turl = https://someone:ghp_secret@github.com/acme/shop.git",
    "\tfetch = +refs/heads/*:refs/remotes/origin/*",
    '[branch "main"]',
    "\tremote = origin",
  ].join("\n");
  it("reads origin's url and drops any user or token", () => {
    expect(originUrlOf(config)).toBe("https://github.com/acme/shop.git");
    expect(originUrlOf('[remote "origin"]\n  url = git@github.com:acme/shop.git\n')).toBe("git@github.com:acme/shop.git");
  });
  it("is null with no origin", () => {
    expect(originUrlOf("[core]\n\tbare = false\n")).toBeNull();
    expect(originUrlOf('[remote "upstream"]\n\turl = x\n')).toBeNull();
    expect(originUrlOf("")).toBeNull();
  });
  it("safeRemote keeps one capped line", () => {
    expect(safeRemote("https://token@github.com/acme/shop")).toBe("https://github.com/acme/shop");
    expect(safeRemote("  ")).toBeNull();
    expect(safeRemote(`https://github.com/${"x".repeat(400)}`)!.length).toBe(300);
  });
});

describe("ownerNameToSave", () => {
  it("leaves the file alone when the name was not changed", () => {
    expect(ownerNameToSave("Robin", "Robin", "Robin")).toBeUndefined();
    expect(ownerNameToSave("  Robin ", "Robin", "Robin")).toBeUndefined();
    expect(ownerNameToSave("", "Robin", "Robin")).toBeUndefined();
    expect(ownerNameToSave("Alex", "Alex", "Robin")).toBeUndefined();
  });
  it("writes a name that differs from git's, and takes it out when put back to git's", () => {
    expect(ownerNameToSave("Alex", "Robin", "Robin")).toBe("Alex");
    expect(ownerNameToSave("Robin", "Alex", "Robin")).toBeNull();
  });
});

describe("mergeSetupIntoConfig", () => {
  const merged = (existing: string | null, setup: { projectsDir: string; ownerName?: string | null }) => {
    const result = mergeSetupIntoConfig(existing, setup);
    if (!result.ok) throw new Error(result.reason);
    return result.text;
  };
  const refused = (existing: string | null, setup: { projectsDir: string; ownerName?: string | null }) => {
    const result = mergeSetupIntoConfig(existing, setup);
    if (result.ok) throw new Error("it was written");
    return result.reason;
  };

  it("a missing file gives a minimal valid one", () => {
    const text = merged(null, { projectsDir: "/Users/me/Code" });
    expect(text).toBe('{\n  "projectsDir": "/Users/me/Code"\n}\n');
    expect(parseLocalConfig(text)).toEqual({
      config: { ownerName: null, chromeAccount: null, projectsDir: "/Users/me/Code", profiles: [] },
      problem: null,
    });
  });

  it("keeps every other key, in its place, with profiles unchanged", () => {
    const existing = JSON.stringify({ profiles: [SHOP], chromeAccount: "someone@example.com", ownerName: "Alex" });
    const text = merged(existing, { projectsDir: "/Users/me/Code" });
    const raw = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(raw)).toEqual(["profiles", "chromeAccount", "ownerName", "projectsDir"]);
    expect(raw.profiles).toEqual([SHOP]);
    // Key order inside a profile too: the text of the rest is the same text.
    expect(JSON.stringify(raw.profiles)).toBe(JSON.stringify([SHOP]));
    const before = parseLocalConfig(existing).config;
    expect(parseLocalConfig(text)).toEqual({ config: { ...before, projectsDir: "/Users/me/Code" }, problem: null });
  });

  it("replaces a folder already there without moving it", () => {
    const existing = JSON.stringify({ projectsDir: "/Users/me/Old", profiles: [] });
    const text = merged(existing, { projectsDir: "/Users/me/Code" });
    expect(Object.keys(JSON.parse(text) as object)).toEqual(["projectsDir", "profiles"]);
    expect(parseLocalConfig(text).config.projectsDir).toBe("/Users/me/Code");
  });

  it("writes the name only when given one, and takes it out on null", () => {
    expect(JSON.parse(merged(null, { projectsDir: "/Users/me/Code", ownerName: " Alex " }))).toEqual({
      ownerName: "Alex",
      projectsDir: "/Users/me/Code",
    });
    const named = JSON.stringify({ ownerName: "Alex", profiles: [SHOP] });
    expect(parseLocalConfig(merged(named, { projectsDir: "/Users/me/Code" })).config.ownerName).toBe("Alex");
    expect(parseLocalConfig(merged(named, { projectsDir: "/Users/me/Code", ownerName: undefined })).config.ownerName).toBe("Alex");
    const cleared = merged(named, { projectsDir: "/Users/me/Code", ownerName: null });
    expect("ownerName" in (JSON.parse(cleared) as object)).toBe(false);
    expect(parseLocalConfig(cleared).config.profiles).toEqual([SHOP]);
  });

  it("refuses a file that has a problem instead of overwriting it", () => {
    expect(refused("{ not json", { projectsDir: "/Users/me/Code" })).toContain("it is not valid JSON");
    expect(refused("{ not json", { projectsDir: "/Users/me/Code" })).toContain("does not overwrite");
    expect(refused(JSON.stringify({ chromeAcount: "x" }), { projectsDir: "/Users/me/Code" })).toContain("chromeAcount");
    expect(refused(JSON.stringify({ profiles: [{ ...SHOP, land: "main" }] }), { projectsDir: "/Users/me/Code" })).toContain('land "main"');
    expect(refused("[]", { projectsDir: "/Users/me/Code" })).toContain("not in use");
    expect(refused(" ".repeat(LOCAL_CONFIG_MAX_CHARS + 1), { projectsDir: "/Users/me/Code" })).toContain("larger than 200 KB");
  });

  it("refuses a folder or a name the config would not read", () => {
    expect(refused(null, { projectsDir: "Code" })).toContain("full path");
    expect(refused(null, { projectsDir: `/${"x".repeat(PROJECTS_DIR_MAX)}` })).toContain("full path");
    expect(refused(null, { projectsDir: "/Users/me/Code", ownerName: "x".repeat(41) })).toContain("40 characters");
    expect(refused(null, { projectsDir: "/Users/me/Code", ownerName: "  " })).toContain("40 characters");
    expect(refused(null, { projectsDir: "/Users/me/Code", ownerName: "A\nB" })).toContain("one line");
  });

  it("refuses a result that would be over the file's cap", () => {
    const sized = (length: number) =>
      JSON.stringify({ profiles: Array.from({ length: 50 }, (_, index) => ({ ...SHOP, key: `p-${index}`, rules: Array.from({ length: 20 }, () => "r".repeat(length)) })) });
    let length = 100;
    while (sized(length + 1).length <= LOCAL_CONFIG_MAX_CHARS) length += 1;
    const big = sized(length);
    expect(parseLocalConfig(big).problem).toBeNull();
    // It fits as written; laid out with the folder added it would not, so nothing is written.
    expect(refused(big, { projectsDir: "/Users/me/Code" })).toContain("larger than 200 KB");
  });
});

describe("sign-in state", () => {
  const end = (code: number | "ENOENT" | null, stdout = "", stderr = "") => ({ code, stdout, stderr });
  it("gh: the login when signed in", () => {
    expect(ghSignIn(end(0, "octocat\n"), parseGhLogin)).toEqual({ state: "in", account: "octocat" });
  });
  it("gh: signed out only when gh says so; anything else is unknown", () => {
    expect(ghSignIn(end(4, "", "To get started with GitHub CLI, please run:  gh auth login"), parseGhLogin)).toEqual({ state: "out", account: null });
    expect(ghSignIn(end(1, "", "error connecting to api.github.com"), parseGhLogin)).toEqual({ state: "unknown", account: null });
    expect(ghSignIn(end(null), parseGhLogin)).toEqual({ state: "unknown", account: null });
    expect(ghSignIn(end(0, "not a login!\n"), parseGhLogin)).toEqual({ state: "unknown", account: null });
    expect(ghSignIn(end("ENOENT"), parseGhLogin)).toEqual({ state: "missing", account: null });
  });
  it("claude: reads loggedIn and the email, nothing else", () => {
    expect(claudeSignIn(end(0, JSON.stringify({ loggedIn: true, email: "someone@example.com", orgId: "x" })))).toEqual({
      state: "in",
      account: "someone@example.com",
    });
    expect(claudeSignIn(end(0, JSON.stringify({ loggedIn: true, email: "not an email\nrun this" })))).toEqual({ state: "in", account: null });
    expect(claudeSignIn(end(1, JSON.stringify({ loggedIn: false })))).toEqual({ state: "out", account: null });
    expect(claudeSignIn(end(0, "Logged in"))).toEqual({ state: "unknown", account: null });
    expect(claudeSignIn(end(0, "null"))).toEqual({ state: "unknown", account: null });
    expect(claudeSignIn(end(0, "{}"))).toEqual({ state: "unknown", account: null });
    expect(claudeSignIn(end("ENOENT"))).toEqual({ state: "missing", account: null });
  });
  it("says who is signed in, or the exact command", () => {
    expect(signInLine("GitHub", { state: "in", account: "octocat" }, GH_SIGN_IN_COMMAND)).toEqual({
      text: "GitHub: signed in as octocat.",
      command: null,
      ok: true,
    });
    expect(signInLine("Claude", { state: "in", account: null }, "claude auth login").text).toBe("Claude: signed in.");
    expect(signInLine("GitHub", { state: "out", account: null }, GH_SIGN_IN_COMMAND)).toEqual({
      text: "GitHub: not signed in. Run in Terminal:",
      command: "gh auth login",
      ok: false,
    });
    expect(signInLine("GitHub", { state: "missing", account: null }, GH_SIGN_IN_COMMAND).command).toBe("gh auth login");
    expect(signInLine("Claude", { state: "unknown", account: null }, "claude auth login")).toMatchObject({ command: "claude auth login", ok: false });
  });
});
