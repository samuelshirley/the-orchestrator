// Browser work runs in the owner's own everyday Chrome, through the Claude in Chrome
// extension. Their sessions there stay signed in indefinitely, and there is no
// second Chrome for them to mistake for their own. A separate Chrome lost
// sign-ins on every relaunch (Apple's `myacinfo` is a session cookie) and
// needed a window to sign in.
// Agents open tabs in a "Claude" tab group: no window, no change of focus, so
// they work in the background while the owner works. With the extension in more
// than one Chrome profile, the local config's `chromeAccount` (localconfig.ts)
// names the one to use: each session picks the browser whose Google account
// page shows it. With none set, agents use the connected Chrome and ask when
// there are several. Pure; browser.test.ts pins the rules.
//
// One agent in Chrome at a time: dozens of agent tabs (40 renderers, 7.9 GB
// in the 12:44 Jetsam report on 2026-09-24) helped take the Mac down. The
// holder of the lease (store.ts) works in at most BROWSER_MAX_TABS tabs of
// its own and closes them before its pass ends; the lease is released then
// either way (server.ts, on thread idle/failed/archived).

import { owner, owners } from "./owner";

/** The Claude MCP server name: its tools are mcp__claude-in-chrome__*. */
export const BROWSER_MCP = "claude-in-chrome";
const TOOLS = `mcp__${BROWSER_MCP}__*`;
/** Shows which Google account a connected browser is signed in as. */
export const ACCOUNT_CHECK_URL = "https://myaccount.google.com/";

/** Tabs of its own the lease holder may have open at once. */
export const BROWSER_MAX_TABS = 3;
/** A lease not renewed for this long is free: its holder died without releasing. */
export const BROWSER_LEASE_STALE_MS = 30 * 60_000;

export type Lease = { holderThreadId: string; taskId: string | null; since: number; renewedAt: number };

export type LeaseDecision =
  | { action: "granted" }
  | { action: "held-by-you" }
  | { action: "wait"; reason: string };

/** Whether this thread may use the owner's Chrome now. `holder` names the current holder for the reason. */
export function leaseDecision(args: { lease: Lease | null; threadId: string; now: number; holder?: string }): LeaseDecision {
  const { lease, threadId, now } = args;
  if (lease === null || now - lease.renewedAt >= BROWSER_LEASE_STALE_MS) return { action: "granted" };
  if (lease.holderThreadId === threadId) return { action: "held-by-you" };
  const who = args.holder ?? (lease.taskId !== null ? `${lease.taskId} (${lease.holderThreadId})` : lease.holderThreadId);
  return { action: "wait", reason: `wait: ${who} is using the browser; do non-browser work and try again later.` };
}

/**
 * For threads that do browser work: tasks and research. `account` is the
 * Google account of the only Chrome profile agents may use; null: no profile
 * is singled out.
 */
export function sharedBrowserRules(account: string | null): string {
  const first =
    account === null
      ? `First use: list_connected_browsers; if several, ask_sam a decision ask for which one, end your turn (research: tell your task).`
      : `First use: list_connected_browsers; if several, select_browser each until your own tab on ${ACCOUNT_CHECK_URL} shows ${account}. Never use another profile. None does? ask_sam a command ask, reason "account", to sign in to the Claude extension in the ${account} Chrome (research: tell your task); end your turn.`;
  return `Browser: ${owners()} own Chrome, ${account === null ? "" : `profile ${account}, `}only through ${TOOLS}. One agent at a time: browser acquire before any of them; told to wait, do non-browser work or end your pass saying so.
${first}
Only tabs you create (tabs_context_mcp createIfEmpty, tabs_create_mcp), at most ${BROWSER_MAX_TABS}; close them all before your pass ends, then browser release. Never close, reload or navigate ${owners()} tabs. Never open, resize or focus a window; never run Chrome, open -a, pkill or osascript on it.
Signed out of a site? Open a new tab on its sign-in page, leave it open, ask_sam a command ask, reason "account": "Sign in to <site> in the new tab in your Chrome${account === null ? "" : ` (${account})`}, tick Keep me signed in, reply done", end your turn; carry on once answered. Research: tell your task instead.
Never ask ${owner()} to use or close a browser except for that sign-in.`;
}

/** The short form for Patches. */
export function sharedBrowserBrief(account: string | null): string {
  return `Browser: ${owners()} own Chrome${account === null ? "" : ` (${account})`} through ${TOOLS}, one agent at a time: browser acquire first, at most ${BROWSER_MAX_TABS} tabs you create, then close them and browser release; never touch their tabs or open a window. Signed out: open a new tab on the sign-in page and ask_sam (reason "account") to sign in there.`;
}

/** Builders never drive Chrome. */
export function builderBrowserRule(): string {
  return `No browser: builders never call ${TOOLS}. If the work needs one, say so in your report; your task does it.`;
}
