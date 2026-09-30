import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACCOUNT_CHECK_URL,
  BROWSER_LEASE_STALE_MS,
  BROWSER_MAX_TABS,
  BROWSER_MCP,
  builderBrowserRule,
  leaseDecision,
  sharedBrowserBrief,
  sharedBrowserRules,
} from "./browser";
import { setOwner } from "./owner";

// The name is whoever runs it (owner.ts): a neutral one here, the fallback after.
beforeEach(() => setOwner("Alex"));
afterEach(() => setOwner(null));

/** Left over from the headless Playwright Chrome; none of it may come back. */
const RETIRED = ["mcp__browser__", "9222", "headless", "open -na", "--user-data-dir", "sign-in window", "shared browser"];

const ACCOUNT = "someone@example.com";
/** With a Chrome account in the local config, and with none. */
const CASES: readonly (string | null)[] = [ACCOUNT, null];

describe("The owner's Chrome", () => {
  it("drives Claude in Chrome, in the profile the local config names", () => {
    expect(BROWSER_MCP).toBe("claude-in-chrome");
    expect(ACCOUNT_CHECK_URL).toBe("https://myaccount.google.com/");
    for (const text of [sharedBrowserRules(ACCOUNT), sharedBrowserBrief(ACCOUNT)]) {
      expect(text).toContain("Alex's own Chrome");
      expect(text).toContain("mcp__claude-in-chrome__*");
      expect(text).toContain(ACCOUNT);
      expect(text).toContain("tabs you create");
      expect(text).toContain("new tab");
      expect(text).toContain('reason "account"');
    }
    expect(sharedBrowserRules(ACCOUNT)).toContain(`Browser: Alex's own Chrome, profile ${ACCOUNT}, only through mcp__claude-in-chrome__*.`);
    expect(sharedBrowserBrief(ACCOUNT)).toContain(`Browser: Alex's own Chrome (${ACCOUNT}) through`);
  });

  it("has every session pick the configured account's browser, and no other profile", () => {
    const text = sharedBrowserRules(ACCOUNT);
    const list = text.indexOf("list_connected_browsers");
    const select = text.indexOf("select_browser");
    expect(list).toBeGreaterThanOrEqual(0);
    expect(select).toBeGreaterThan(list);
    expect(text).toContain(`your own tab on https://myaccount.google.com/ shows ${ACCOUNT}`);
    expect(text).toContain("Never use another profile.");
    expect(text).toContain(`sign in to the Claude extension in the ${ACCOUNT} Chrome`);
  });

  it("with no account set, names none and skips the profile check", () => {
    const rules = sharedBrowserRules(null);
    const brief = sharedBrowserBrief(null);
    for (const text of [rules, brief]) {
      expect(text).toContain("Alex's own Chrome");
      expect(text).toContain("mcp__claude-in-chrome__*");
      expect(text).toContain("tabs you create");
      expect(text).toContain('reason "account"');
      expect(text).not.toContain("@");
      expect(text).not.toContain("null");
      expect(text).not.toContain(ACCOUNT_CHECK_URL);
      expect(text).not.toContain("profile");
    }
    expect(rules).toContain("Browser: Alex's own Chrome, only through mcp__claude-in-chrome__*.");
    expect(rules).toContain("First use: list_connected_browsers; if several, ask_sam a decision ask for which one, end your turn");
    expect(rules).not.toContain("select_browser each");
    expect(rules).toContain('"Sign in to <site> in the new tab in your Chrome, tick Keep me signed in, reply done"');
    expect(brief).toContain("Browser: Alex's own Chrome through mcp__claude-in-chrome__*");
  });

  it("keeps the tab, lease and never-touch rules word for word without an account", () => {
    const lines = (text: string) => text.split("\n");
    const withAccount = lines(sharedBrowserRules(ACCOUNT));
    const without = lines(sharedBrowserRules(null));
    expect(without).toHaveLength(withAccount.length);
    // Line 3: own tabs only, the limit, never the owner's tabs or windows. Line 5: the only ask.
    expect(without[2]).toBe(withAccount[2]);
    expect(without[4]).toBe(withAccount[4]);
    expect(without[0]).toBe(withAccount[0]?.replace(`profile ${ACCOUNT}, `, ""));
    expect(without[3]).toBe(withAccount[3]?.replace(` (${ACCOUNT})`, ""));
    expect(sharedBrowserBrief(null)).toBe(sharedBrowserBrief(ACCOUNT).replace(` (${ACCOUNT})`, ""));
  });

  it.each(CASES)("works only in its own tabs, and never touches the owner's tabs or windows (account %s)", (account) => {
    const text = sharedBrowserRules(account);
    expect(text).toContain("tabs_context_mcp createIfEmpty");
    expect(text).toContain("tabs_create_mcp");
    expect(text).toContain("close them all before your pass ends, then browser release");
    expect(text).toContain("Never close, reload or navigate Alex's tabs.");
    expect(text).toContain("Never open, resize or focus a window");
    expect(text).toContain("never run Chrome, open -a, pkill or osascript on it");
    expect(sharedBrowserBrief(account)).toContain("never touch their tabs or open a window");
  });

  it.each(CASES)("signs in through a new tab and a Needs-you ask, then carries on in the background (account %s)", (account) => {
    const text = sharedBrowserRules(account);
    const tab = text.indexOf("Open a new tab on its sign-in page, leave it open");
    const ask = text.indexOf('ask_sam a command ask, reason "account": "Sign in to <site> in the new tab', tab);
    expect(tab).toBeGreaterThanOrEqual(0);
    expect(ask).toBeGreaterThan(tab);
    expect(text).toContain(
      `"Sign in to <site> in the new tab in your Chrome${account === null ? "" : ` (${account})`}, tick Keep me signed in, reply done"`,
    );
    expect(text).toContain("end your turn; carry on once answered.");
    expect(text).toContain("Research: tell your task instead.");
    expect(text).toContain("Never ask Alex to use or close a browser except for that sign-in.");
  });

  it.each(CASES)("keeps nothing of the headless Playwright Chrome (account %s)", (account) => {
    for (const text of [sharedBrowserRules(account), sharedBrowserBrief(account)]) {
      for (const gone of RETIRED) expect(text, gone).not.toContain(gone);
    }
    // pkill appears only as something never to run.
    expect(sharedBrowserRules(account).match(/pkill/g)).toHaveLength(1);
    expect(sharedBrowserRules(account)).toContain("never run Chrome, open -a, pkill");
  });

  it("stays short", () => {
    // The budget was set with a 20-character account; a long one still has to fit the 4,096 cap (prompts.test.ts).
    expect(sharedBrowserRules("sam@acme-example.com").length).toBeLessThanOrEqual(1300);
    expect(sharedBrowserBrief("sam@acme-example.com").length).toBeLessThanOrEqual(380);
    expect(sharedBrowserRules(null).length).toBeLessThanOrEqual(1300);
    expect(sharedBrowserBrief(null).length).toBeLessThanOrEqual(380);
    expect(builderBrowserRule().length).toBeLessThanOrEqual(140);
  });
});

describe("browser lease", () => {
  const NOW = 1_800_000_000_000;
  const lease = (holderThreadId: string, renewedAt = NOW - 1000) => ({ holderThreadId, taskId: "task_1", since: renewedAt, renewedAt });

  it("grants a free browser, and tells its holder it already has it", () => {
    expect(leaseDecision({ lease: null, threadId: "thr_a", now: NOW })).toEqual({ action: "granted" });
    expect(leaseDecision({ lease: lease("thr_a"), threadId: "thr_a", now: NOW })).toEqual({ action: "held-by-you" });
  });
  it("makes everyone else wait, naming the holder", () => {
    const decision = leaseDecision({ lease: lease("thr_a"), threadId: "thr_b", now: NOW });
    expect(decision).toEqual({
      action: "wait",
      reason: "wait: task_1 (thr_a) is using the browser; do non-browser work and try again later.",
    });
  });
  it("frees a lease not renewed for 30 minutes, not a minute sooner", () => {
    expect(BROWSER_LEASE_STALE_MS).toBe(30 * 60_000);
    expect(leaseDecision({ lease: lease("thr_a", NOW - BROWSER_LEASE_STALE_MS + 1), threadId: "thr_b", now: NOW }).action).toBe("wait");
    expect(leaseDecision({ lease: lease("thr_a", NOW - BROWSER_LEASE_STALE_MS), threadId: "thr_b", now: NOW }).action).toBe("granted");
  });
  it("puts the lease and the tab limit in every browser prompt; builders get none", () => {
    expect(BROWSER_MAX_TABS).toBe(3);
    for (const account of CASES) {
      for (const text of [sharedBrowserRules(account), sharedBrowserBrief(account)]) {
        expect(text).toContain("one agent at a time".replace(/^o/, text === sharedBrowserRules(account) ? "O" : "o"));
        expect(text).toContain("browser acquire");
        expect(text).toContain("browser release");
        expect(text).toContain(`at most ${BROWSER_MAX_TABS}`);
      }
      expect(sharedBrowserRules(account)).toContain("told to wait, do non-browser work or end your pass saying so");
    }
    expect(builderBrowserRule()).toContain("builders never call mcp__claude-in-chrome__*");
  });
});
