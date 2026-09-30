import { describe, expect, it } from "vitest";
import type { PrComment, PrFacts } from "./contract";
import { DEFAULT_PROFILE, githubSlug, profileFor, type ProjectProfile } from "./profiles";
import {
  builtFromSha,
  deriveTestList,
  howToOpenGap,
  isPreviewStale,
  notVerifiedItems,
  prTone,
  shaMatches,
  stickyComment,
  validatePr,
} from "./validation";

const HEAD = "cc65f6a1234567890abcdef1234567890abcdef0";
const OLD = "137e13f";
/** A deploying web + mobile app: full CI, sticky comments, an AI-tests run, production env. */
const SHOP: ProjectProfile = {
  key: "shop",
  names: ["acme shop"],
  remotes: ["acme/shop"],
  checks: ["npx tsc --noEmit", "npm run test", "cd app && npx tsc --noEmit"],
  ci: "full",
  markers: {
    preview: "<!-- shop-preview -->",
    e2e: "<!-- shop-e2e-results -->",
    ios: "<!-- shop-ios-e2e -->",
  },
  iosPaths: ["app/**"],
  aiTestsLabel: "ai-tests",
  aiRanPatterns: ["Assistant specs ran", "\\| `ai` \\| ✅ success"],
  sharedPaths: ["CLAUDE.md", "docs/notes.md", "packages/shared/**"],
  mirrors: [["web/shared/**", "packages/shared/**"]],
  build: "worktree",
  land: "pr",
  backup: null,
  afterLand: [],
  worktreeInclude: [".claude/settings.local.json"],
  productionEnv: true,
  setup: [
    ["npm", "ci", "--no-audit", "--no-fund"],
    ["npm", "--prefix", "app", "ci", "--no-audit", "--no-fund"],
  ],
  testRules: [
    { pattern: "app/**", test: "On a device, with the latest build" },
    { pattern: "server/billing/**", test: "A test payment" },
    { pattern: "server/webhooks/billing/**", test: "A test payment" },
    { pattern: "web/admin/**", test: "The admin page on the preview" },
    { pattern: "src/lib/assistant/**", test: "Assistant: needs the ai-tests run (Assistant specs ran on the head commit)" },
  ],
  rules: [
    "Follow CLAUDE.md and the guide it links for the folder you change.",
    "Tests and seed scripts use the local database only.",
    "Merging is Alex's: merge = production deploy. Never merge.",
    "Run the unit tests before you commit.",
  ],
};
/** A Flux project: no CI, no code builds. */
const BOARD: ProjectProfile = {
  key: "board",
  names: ["acme board", "acme-board"],
  remotes: ["acme/board"],
  checks: [],
  ci: "none",
  markers: { preview: null, e2e: null, ios: null },
  iosPaths: [],
  aiTestsLabel: null,
  aiRanPatterns: [],
  sharedPaths: ["CLAUDE.md"],
  mirrors: [],
  build: "flux-prompts",
  land: "pr",
  backup: null,
  afterLand: [],
  worktreeInclude: [],
  productionEnv: false,
  setup: [],
  testRules: [],
  rules: [
    "Follow CLAUDE.md. Read docs/prompting.md before writing a prompt.",
    "Paste Flux prompts into Flux yourself in your own tab in Alex's Chrome; anything that spends ACUs waits for Alex's approval (ask_sam).",
    "Never open secrets.env.",
  ],
};
/** What the local config's `profiles` would hold. */
const LOCAL: readonly ProjectProfile[] = [SHOP, BOARD];
const shop = profileFor({ name: "Acme Shop", gitRemoteUrl: "git@github.com:acme/Shop.git" }, LOCAL);
const board = profileFor({ name: "Acme Board", gitRemoteUrl: "https://github.com/acme/board.git" }, LOCAL);

const preview = (sha: string): PrComment => ({
  body: `<!-- shop-preview -->\n### 🔍 Preview for this PR\n\nBuilt from \`${sha}\` · [CI run](x)`,
  createdAt: 3,
});
const e2e = (sha: string, { pass = true, aiRan = false, superseded = false } = {}): PrComment => ({
  body: [
    "<!-- shop-e2e-results -->",
    superseded ? "<!-- stale-banner:start -->\n> Superseded\n<!-- stale-banner:end -->" : "",
    `### ${pass ? "✅" : "❌"} E2E results — 78 passed`,
    aiRan ? "> 💸 **Assistant specs ran.**" : "> ⏭️ **Assistant specs did not run**",
    `Built from \`${sha}\` · [CI run](x)`,
  ].join("\n"),
  createdAt: 4,
});
const ios = (sha: string, outcome: "Passed" | "Failed" | "Did not run", extra = ""): PrComment => ({
  body: `<!-- shop-ios-e2e -->\n### 📱 iOS e2e (simulator)\n\n**${outcome}.** text\n${extra}\n\nBuilt from \`${sha}\` · [CI run](x)`,
  createdAt: 5,
});

function facts(overrides: Partial<PrFacts> = {}): PrFacts {
  return {
    number: 55,
    url: "https://github.com/acme/Shop/pull/55",
    state: "open",
    isDraft: false,
    headRefName: "task/tiers",
    headRefOid: HEAD,
    checks: "passing",
    failingChecks: [],
    mergeable: "mergeable",
    mergeStateStatus: "CLEAN",
    labels: [],
    files: ["src/lib/dates.ts"],
    body: "",
    comments: [preview(HEAD.slice(0, 7)), e2e(HEAD.slice(0, 7))],
    ...overrides,
  };
}

describe("stale preview", () => {
  it("reads the Built-from sha and compares short against full", () => {
    expect(builtFromSha(preview("abc1234").body)).toBe("abc1234");
    expect(shaMatches("cc65f6a", HEAD)).toBe(true);
    expect(shaMatches(OLD, HEAD)).toBe(false);
  });

  it("is stale only when a preview exists and was built from another commit", () => {
    expect(isPreviewStale(OLD, HEAD)).toBe(true);
    expect(isPreviewStale("cc65f6a", HEAD)).toBe(false);
    expect(isPreviewStale(null, HEAD)).toBe(false);
  });

  it("takes the newest sticky comment", () => {
    const older = { ...preview(OLD), createdAt: 1 };
    const newer = { ...preview("cc65f6a"), createdAt: 9 };
    expect(stickyComment([newer, older], "<!-- shop-preview -->")).toBe(newer);
  });
});

describe("prTone", () => {
  const base = {
    state: "open" as const,
    isDraft: false,
    checks: "passing" as const,
    mergeable: "mergeable" as const,
    mergeStateStatus: "CLEAN",
    headRefOid: HEAD,
    previewSha: "cc65f6a",
  };
  it("is green when checks pass on a fresh preview", () => expect(prTone(base)).toBe("ready"));
  it("is grey-stale when checks are done but the preview is older than head", () =>
    expect(prTone({ ...base, previewSha: OLD })).toBe("stale"));
  it("is amber while checks run, even with an old preview", () =>
    expect(prTone({ ...base, checks: "pending", previewSha: OLD })).toBe("running"));
  it("is red on failing checks or conflicts", () => {
    expect(prTone({ ...base, checks: "failing" })).toBe("failing");
    expect(prTone({ ...base, mergeable: "conflicting" })).toBe("failing");
  });
});

describe("validatePr (a full-CI app)", () => {
  it("asks for ai-tests last, only once everything else is green for head", () => {
    expect(validatePr(facts(), shop)).toMatchObject({ kind: "add_label", readd: false });
  });

  it("is ready once the ai-tests run passed on the head commit", () => {
    const verdict = validatePr(
      facts({ labels: ["ai-tests"], comments: [preview("cc65f6a"), e2e("cc65f6a", { aiRan: true })] }),
      shop,
    );
    expect(verdict).toEqual({ kind: "ready", reasons: [], readd: false });
  });

  it("re-adds ai-tests once when no run is seen on the head", () => {
    const verdict = validatePr(facts({ labels: ["ai-tests"] }), shop);
    expect(verdict).toMatchObject({ kind: "add_label", readd: true });
    expect(verdict.reasons[0]).toContain("re-adding it once for this head");
    expect(verdict.reasons[0]).not.toContain("remove and re-add");
  });

  it("refuses orchestrator plumbing, whatever else is green", () => {
    const verdict = validatePr(facts({ files: [".worktreeinclude"] }), shop);
    expect(verdict.kind).toBe("failing");
    expect(verdict.reasons[0]).toContain("Drop these from the branch: .worktreeinclude.");
  });

  it("refuses a docs-only PR", () => {
    const verdict = validatePr(facts({ files: ["docs/guides/release.md"] }), shop);
    expect(verdict.kind).toBe("failing");
    expect(verdict.reasons).toContain("A PR to an app repo carries app code: docs ride with the change they describe.");
  });

  it("app code with its docs is unaffected", () => {
    const verdict = validatePr(facts({ files: ["CLAUDE.md", "src/lib/paywallCopy.ts"] }), shop);
    expect(verdict).toMatchObject({ kind: "add_label" });
  });

  it("does not police a land-main project", () => {
    const verdict = validatePr(facts({ files: [".claude/settings.json"] }), { ...shop, land: "main" });
    expect(verdict.kind).toBe("add_label");
  });

  it("calls a finished PR with an older preview stale, not ready", () => {
    const verdict = validatePr(facts({ comments: [preview(OLD), e2e("cc65f6a")] }), shop);
    expect(verdict.kind).toBe("stale");
    expect(verdict.reasons[0]).toContain(OLD);
  });

  it("waits while checks run or comments are not in for head", () => {
    expect(validatePr(facts({ checks: "pending" }), shop).kind).toBe("waiting");
    expect(validatePr(facts({ comments: [preview("cc65f6a"), e2e(OLD)] }), shop).kind).toBe("waiting");
    expect(
      validatePr(facts({ comments: [preview("cc65f6a"), e2e("cc65f6a", { superseded: true })] }), shop).kind,
    ).toBe("waiting");
  });

  it("fails on red checks, red E2E, conflicts, or a PR behind main", () => {
    expect(validatePr(facts({ checks: "failing", failingChecks: ["Unit tests"] }), shop).reasons[0]).toContain("Unit tests");
    expect(validatePr(facts({ comments: [preview("cc65f6a"), e2e("cc65f6a", { pass: false })] }), shop).kind).toBe("failing");
    expect(validatePr(facts({ mergeable: "conflicting" }), shop).kind).toBe("failing");
    expect(validatePr(facts({ mergeStateStatus: "BEHIND" }), shop).kind).toBe("failing");
  });

  it("needs a passing iOS comment for head only when an iOS path changed", () => {
    const mobile = { files: ["app/screens/index.tsx"] };
    expect(validatePr(facts(mobile), shop).kind).toBe("waiting");
    expect(validatePr(facts({ ...mobile, comments: [preview("cc65f6a"), e2e("cc65f6a"), ios("cc65f6a", "Failed")] }), shop).kind).toBe("failing");
    expect(validatePr(facts({ ...mobile, comments: [preview("cc65f6a"), e2e("cc65f6a"), ios("cc65f6a", "Did not run")] }), shop).kind).toBe("failing");
    expect(validatePr(facts({ ...mobile, comments: [preview("cc65f6a"), e2e("cc65f6a"), ios("cc65f6a", "Passed")] }), shop).kind).toBe("add_label");
  });

  it("says closed for a merged PR", () => {
    expect(validatePr(facts({ state: "merged" }), shop).kind).toBe("closed");
  });
});

describe("validatePr: AI-run proof and one label per head", () => {
  const H = "cc65f6a";
  const labelled = (comments: PrComment[], files = ["src/lib/dates.ts"]) =>
    facts({ labels: ["ai-tests"], files, comments: [preview(H), ...comments] });

  it("reads the AI-run proof from a passing iOS comment on head, an iOS path touched or not", () => {
    for (const files of [["src/lib/dates.ts"], ["app/screens/index.tsx"]]) {
      expect(validatePr(labelled([e2e(H), ios(H, "Passed", "> 💸 **Assistant specs ran.**")], files), shop).kind).toBe("ready");
      expect(validatePr(labelled([e2e(H), ios(H, "Passed", "| `ai` | ✅ success · 4 flows |")], files), shop).kind).toBe("ready");
    }
  });

  it("reads it from the E2E comment when the iOS comment lacks it", () => {
    expect(validatePr(labelled([e2e(H, { aiRan: true }), ios(H, "Passed")]), shop).kind).toBe("ready");
  });

  it("does not count an iOS comment that is off head or not passed", () => {
    const aiRan = "> 💸 **Assistant specs ran.**";
    expect(validatePr(labelled([e2e(H), ios(OLD, "Passed", aiRan)]), shop)).toMatchObject({ kind: "add_label", readd: true });
    expect(validatePr(labelled([e2e(H), ios(H, "Did not run", aiRan)]), shop)).toMatchObject({ kind: "add_label", readd: true });
  });

  it("does not count a skipped ai shard or one that did not run", () => {
    for (const extra of ["| `ai` | ⚪ skipped |", "The Assistant flows (`ai` shard) did not run."]) {
      expect(validatePr(labelled([e2e(H), ios(H, "Passed", extra)]), shop)).toMatchObject({ kind: "add_label", readd: true });
    }
  });

  it("re-adds once when neither comment has the proof", () => {
    expect(validatePr(labelled([e2e(H), ios(H, "Passed")]), shop, null)).toMatchObject({ kind: "add_label", readd: true });
  });

  it("treats a profile with no patterns as no proof", () => {
    const bare = { ...shop, aiRanPatterns: [] };
    expect(validatePr(labelled([e2e(H, { aiRan: true }), ios(H, "Passed", "| `ai` | ✅ success |")]), bare)).toMatchObject({
      kind: "add_label",
      readd: true,
    });
  });

  it("never adds the label twice on an unchanged head, however often it is asked", () => {
    const pr = labelled([e2e(H), ios(H, "Passed")]);
    let labelledSha: string | null = null;
    const verdicts = [];
    for (let call = 0; call < 6; call++) {
      const verdict = validatePr(pr, shop, labelledSha);
      verdicts.push(verdict);
      if (verdict.kind === "add_label") labelledSha = pr.headRefOid; // as the server records it
    }
    expect(verdicts[0]).toMatchObject({ kind: "add_label", readd: true });
    for (const verdict of verdicts.slice(1)) {
      expect(verdict).toMatchObject({ kind: "waiting", readd: false });
      expect(verdict.reasons[0]).toContain("Waiting on the ai-tests run for");
      expect(verdict.reasons[0]).not.toContain("re-add");
    }
    expect(verdicts.filter((verdict) => verdict.readd)).toHaveLength(1);
  });

  it("waits, not adds, when the label was added on this head and is off now", () => {
    const verdict = validatePr(facts({ labels: [] }), shop, HEAD);
    expect(verdict).toMatchObject({ kind: "waiting", readd: false });
    expect(verdict.reasons[0]).toContain("not adding it twice on one head");
  });

  it("is ready when the run it waited on proved itself", () => {
    expect(validatePr(labelled([e2e(H), ios(H, "Passed", "| `ai` | ✅ success |")]), shop, HEAD).kind).toBe("ready");
  });

  it("adds again once for a new head", () => {
    expect(validatePr(labelled([e2e(H)]), shop, OLD)).toMatchObject({ kind: "add_label", readd: true });
    expect(validatePr(facts(), shop, OLD)).toMatchObject({ kind: "add_label", readd: false });
  });
});

describe("validatePr (no CI)", () => {
  it("only needs an open, mergeable PR", () => {
    expect(validatePr(facts({ checks: "none", comments: [] }), board).kind).toBe("ready");
    expect(validatePr(facts({ checks: "none", comments: [], mergeable: "conflicting" }), board).kind).toBe("failing");
  });
});

describe("test list", () => {
  it("derives hands-on checks from the diff paths", () => {
    const list = deriveTestList({
      files: [
        "app/screens/paywall.tsx",
        "server/billing/states.ts",
        "server/webhooks/billing/route.ts",
        "web/admin/page.tsx",
        "src/lib/assistant/tools/search.ts",
        "README.md",
      ],
      body: "",
      profile: shop,
      extra: [],
    });
    expect(list).toEqual([
      "On a device, with the latest build",
      "A test payment",
      "The admin page on the preview",
      "Assistant: needs the ai-tests run (Assistant specs ran on the head commit)",
    ]);
  });

  it("adds the PR body's not-verified items and the agent's extras, deduplicated", () => {
    const body = [
      "## What changed",
      "- a thing",
      "",
      "## Not verified",
      "- Signed-in paywall on a real device",
      "- [ ] Restore purchases",
      "",
      "## Checks",
      "- Not verified: the annual price copy",
      "- tsc passed",
    ].join("\n");
    expect(notVerifiedItems(body)).toEqual([
      "Signed-in paywall on a real device",
      "Restore purchases",
      "the annual price copy",
    ]);
    const list = deriveTestList({ files: [], body, profile: DEFAULT_PROFILE, extra: ["Restore purchases", "Look at the chart"] });
    expect(list).toContain("Not verified by the agent: Restore purchases");
    expect(list).toContain("Look at the chart");
    expect(list.filter((item) => item === "Look at the chart")).toHaveLength(1);
  });

  it("puts How to open it lines first, in their order", () => {
    const list = deriveTestList({
      files: ["app/screens/paywall.tsx"],
      body: "## Not verified\n- Restore purchases",
      profile: shop,
      extra: [
        "How to open it (web): https://preview.example.com/shop-x",
        "Look at the chart",
        "How to open it (iOS): no iOS preview for cc65f6a yet",
      ],
    });
    expect(list).toEqual([
      "How to open it (web): https://preview.example.com/shop-x",
      "How to open it (iOS): no iOS preview for cc65f6a yet",
      "On a device, with the latest build",
      "Not verified by the agent: Restore purchases",
      "Look at the chart",
    ]);
  });
});

describe("howToOpenGap", () => {
  it("passes a list that starts with How to open it", () => {
    expect(howToOpenGap(["How to open it (web): https://preview.example.com/x", "Log in"])).toBeNull();
    expect(howToOpenGap(["how to open it (iOS): TestFlight build 142 (cc65f6a)"])).toBeNull();
  });

  it("refuses an empty list", () => {
    expect(howToOpenGap([])).toMatch(/How to open it/);
  });

  it("refuses a list whose first item is something else, even with How to open it later", () => {
    const gap = howToOpenGap(["Log in", "How to open it (web): https://preview.example.com/x"]);
    expect(gap).not.toBeNull();
    expect(gap).toMatch(/TestFlight build number/);
    expect(gap).toMatch(/never guess/);
  });
});

describe("profiles", () => {
  it("matches by remote slug first, then name", () => {
    expect(githubSlug("git@github.com:acme/Shop.git")).toBe("acme/shop");
    expect(profileFor({ name: "anything", gitRemoteUrl: "https://github.com/acme/board" }, LOCAL).key).toBe("board");
    expect(profileFor({ name: "Acme Board", gitRemoteUrl: null }, LOCAL).build).toBe("flux-prompts");
    // No local config: the same project gets the default profile.
    expect(profileFor({ name: "Acme Board", gitRemoteUrl: "https://github.com/acme/board" }).key).toBe("default");
    expect(profileFor({ name: "the-orchestrator" }).checks).toContain("bb plugin build");
    expect(profileFor({ name: "unknown" }).key).toBe("default");
  });
});
