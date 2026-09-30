// PR validation and the test list. Pure: host.ts gathers the facts with gh,
// this decides whether a PR has proven itself for its head commit, and which
// hands-on checks only the owner can do.
import { covers } from "./claims";
import { plumbingRefusal } from "./plumbing";
import type { Checks, PrComment, PrFacts } from "./contract";
import type { ProjectProfile } from "./profiles";

/** A short sha from a comment against the PR's full head sha. */
export function shaMatches(shortSha: string, fullSha: string): boolean {
  const a = shortSha.trim().toLowerCase();
  const b = fullSha.trim().toLowerCase();
  if (a.length < 7 || b.length < 7) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/** The sha a CI sticky comment says it was built from: "Built from `abc1234`". */
export function builtFromSha(body: string): string | null {
  return body.match(/Built from `([0-9a-f]{7,40})`/i)?.[1]?.toLowerCase() ?? null;
}

/** The newest comment carrying `marker` (CI deletes and reposts, but be safe). */
export function stickyComment(
  comments: readonly PrComment[],
  marker: string,
): PrComment | null {
  let newest: PrComment | null = null;
  for (const comment of comments) {
    if (!comment.body.includes(marker)) continue;
    if (newest === null || comment.createdAt >= newest.createdAt) newest = comment;
  }
  return newest;
}

/**
 * The preview was built from an older commit than the PR's head. A PR with no
 * preview comment is not stale — it has no preview (docs-only, or not yet).
 */
export function isPreviewStale(previewSha: string | null, headRefOid: string): boolean {
  if (previewSha === null) return false;
  return !shaMatches(previewSha, headRefOid);
}

export type PrTone =
  | "running"
  | "ready"
  | "failing"
  | "stale"
  | "draft"
  | "merged"
  | "closed"
  | "open";

/**
 * The board colour for a PR. Red beats everything (it needs a fix), running
 * checks are amber (a stale preview mid-run is expected), then a preview
 * built from an older commit is grey-with-a-warning, then green.
 */
export function prTone(pr: {
  state: "open" | "closed" | "merged";
  isDraft: boolean;
  checks: Checks;
  mergeable: "mergeable" | "conflicting" | "unknown";
  mergeStateStatus: string;
  headRefOid: string;
  previewSha: string | null;
}): PrTone {
  if (pr.state === "merged") return "merged";
  if (pr.state === "closed") return "closed";
  if (
    pr.mergeable === "conflicting" ||
    pr.mergeStateStatus === "DIRTY" ||
    pr.checks === "failing"
  ) {
    return "failing";
  }
  if (pr.checks === "pending") return "running";
  if (isPreviewStale(pr.previewSha, pr.headRefOid)) return "stale";
  if (pr.isDraft) return "draft";
  if (pr.checks === "passing") return "ready";
  return "open";
}

export type VerdictKind =
  | "ready"
  | "add_label"
  | "waiting"
  | "failing"
  | "stale"
  | "closed";

export interface Verdict {
  kind: VerdictKind;
  /** Plain sentences, most important first. Empty only for "ready" with nothing to note. */
  reasons: string[];
  /** When kind is "add_label": the label is already on and must be removed and re-added. */
  readd: boolean;
}

/** Does a head-built, passing sticky comment say the AI-tests run ran? */
export function aiRanIn(body: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => new RegExp(pattern, "iu").test(body));
}

function touchesAny(files: readonly string[], patterns: readonly string[]): boolean {
  return files.some((file) => patterns.some((pattern) => covers(pattern, file)));
}

const SUPERSEDED = /stale-banner:start/;

/**
 * Has this PR proven itself for its head commit? In order: open and
 * mergeable; every check green; the preview, E2E and (for mobile changes)
 * iOS sticky comments all built from the head commit and passing; and last,
 * the ai-tests label run on that same commit. A profile with no CI can only
 * check the PR is open and mergeable. `labelledSha` is the head the label was
 * last added on (the dossier's): the paid label goes on at most once per head.
 */
export function validatePr(
  facts: PrFacts,
  profile: ProjectProfile,
  labelledSha: string | null = null,
): Verdict {
  const head = facts.headRefOid;
  const short = head.slice(0, 7);
  if (facts.state !== "open") {
    return { kind: "closed", reasons: [`PR #${facts.number} is ${facts.state}.`], readd: false };
  }
  const failing: string[] = [];
  const stale: string[] = [];
  const waiting: string[] = [];

  if (profile.land === "pr") {
    const plumbing = plumbingRefusal(facts.files);
    if (plumbing) failing.push(plumbing);
  }
  if (facts.mergeable === "conflicting" || facts.mergeStateStatus === "DIRTY") {
    failing.push("Merge conflicts with the base branch: rebase and push.");
  } else if (facts.mergeStateStatus === "BEHIND") {
    failing.push("Behind the base branch, and branch protection needs it up to date: rebase and push.");
  }
  if (facts.isDraft) waiting.push("The PR is a draft.");

  if (facts.checks === "failing") {
    const names = facts.failingChecks.slice(0, 5).join(", ");
    failing.push(`Checks failing on ${short}${names ? `: ${names}` : ""}.`);
  } else if (facts.checks === "pending") {
    waiting.push(`Checks still running on ${short}.`);
  } else if (facts.checks === "none" && profile.ci === "full") {
    waiting.push(`No checks reported yet for ${short}.`);
  }

  let aiRan = false;
  if (profile.ci === "full") {
    const { preview, e2e, ios } = profile.markers;
    if (preview !== null) {
      const comment = stickyComment(facts.comments, preview);
      const sha = comment === null ? null : builtFromSha(comment.body);
      if (sha === null) {
        waiting.push("No preview comment yet.");
      } else if (!shaMatches(sha, head)) {
        const line = `Preview built from ${sha}, but the head is ${short}.`;
        if (facts.checks === "pending") waiting.push(line);
        else stale.push(`${line} The preview is stale.`);
      }
    }
    if (e2e !== null) {
      const comment = stickyComment(facts.comments, e2e);
      const sha = comment === null ? null : builtFromSha(comment.body);
      if (comment === null || sha === null) {
        waiting.push("No E2E results comment yet.");
      } else if (!shaMatches(sha, head) || SUPERSEDED.test(comment.body)) {
        waiting.push(`E2E results are not for ${short} yet.`);
      } else if (/###\s*❌/u.test(comment.body)) {
        failing.push(`E2E failed on ${short}.`);
      } else {
        aiRan = aiRanIn(comment.body, profile.aiRanPatterns);
      }
    }
    if (ios !== null) {
      // The AI shard may run whatever the PR touches, so its proof counts on
      // any PR; only PRs touching iosPaths must carry a passing comment.
      const comment = stickyComment(facts.comments, ios);
      const sha = comment === null ? null : builtFromSha(comment.body);
      const passed = comment !== null && /\*\*Passed\.\*\*/.test(comment.body);
      if (comment === null || sha === null) {
        if (touchesAny(facts.files, profile.iosPaths)) {
          waiting.push("No iOS e2e comment yet (this PR touches mobile/).");
        }
      } else if (shaMatches(sha, head) && passed) {
        if (aiRanIn(comment.body, profile.aiRanPatterns)) aiRan = true;
      } else if (touchesAny(facts.files, profile.iosPaths)) {
        if (!shaMatches(sha, head)) waiting.push(`iOS e2e results are not for ${short} yet.`);
        else if (/\*\*Failed\.\*\*/.test(comment.body)) failing.push(`iOS e2e failed on ${short}.`);
        else failing.push(`iOS e2e did not run on ${short}.`);
      }
    }
  }

  if (failing.length > 0) {
    return { kind: "failing", reasons: [...failing, ...stale, ...waiting], readd: false };
  }
  if (stale.length > 0) return { kind: "stale", reasons: [...stale, ...waiting], readd: false };
  if (waiting.length > 0) return { kind: "waiting", reasons: waiting, readd: false };

  const label = profile.aiTestsLabel;
  if (label !== null && profile.ci === "full") {
    const on = facts.labels.includes(label);
    if (on && aiRan) return { kind: "ready", reasons: [], readd: false };
    // Added once on this head already: never again, or each call starts another paid run.
    if (labelledSha !== null && shaMatches(labelledSha, head)) {
      return {
        kind: "waiting",
        reasons: [
          on
            ? `Waiting on the ${label} run for ${short}.`
            : `${label} was already added once on ${short} and is off now; not adding it twice on one head.`,
        ],
        readd: false,
      };
    }
    if (!on) {
      return {
        kind: "add_label",
        reasons: [`Everything else is green on ${short}: add ${label} last.`],
        readd: false,
      };
    }
    return {
      kind: "add_label",
      reasons: [`${label} is on, but no ${label} run has been seen on ${short}: re-adding it once for this head.`],
      readd: true,
    };
  }
  return { kind: "ready", reasons: [], readd: false };
}

const HEADING = /^\s*(#{1,6}\s+|\*\*|__)/;
const NOT_VERIFIED = /\b(not verified|unverified|could ?n[o']t verify|did not verify|didn't verify|not tested|untested)\b/i;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/;

/**
 * What the PR body says was not verified: bullets under a heading that says
 * so ("## Not verified"), and any bullet that starts "Not verified: …".
 */
export function notVerifiedItems(body: string): string[] {
  const items: string[] = [];
  let inSection = false;
  for (const line of body.split(/\r?\n/)) {
    if (HEADING.test(line) && !BULLET.test(line)) {
      inSection = NOT_VERIFIED.test(line);
      continue;
    }
    const bullet = line.match(BULLET)?.[1];
    if (bullet === undefined) continue;
    const inline = bullet.match(/^(?:\*\*)?(?:not verified|unverified|untested)(?:\*\*)?\s*[:—–-]\s*(.+)$/i)?.[1];
    if (inline !== undefined) items.push(inline.trim());
    else if (inSection) items.push(bullet.trim());
  }
  return items;
}

/** A test list item that tells the owner how to open the preview: "How to open it (iOS): …". */
export const HOW_TO_OPEN = /^\s*how to open it\b/i;

/**
 * PR-based projects: the owner's list must start with how to open the preview.
 * Null when the first item is a "How to open it" line, else the refusal.
 */
export function howToOpenGap(extra: readonly string[]): string | null {
  if (extra.length > 0 && HOW_TO_OPEN.test(extra[0])) return null;
  return 'testList must start with a "How to open it (<platform>): …" line per platform the PR touches: web, the preview URL for the head; iOS, the OTA link or QR with its channel, or the TestFlight build number containing the head. A platform with no preview for this head says so plainly ("How to open it (iOS): no iOS preview for <sha7> yet"). Take them from CI output, PR comments or deploy checks; never guess, and if one cannot be found, say what is missing.';
}

/**
 * The owner's hands-on list: how to open the preview first, then one line per
 * profile rule the diff trips, then everything the PR says it could not
 * verify, then the rest of what the agent added.
 */
export function deriveTestList({
  files,
  body,
  profile,
  extra,
}: {
  files: readonly string[];
  body: string;
  profile: Pick<ProjectProfile, "testRules">;
  extra: readonly string[];
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (item: string) => {
    const clean = item.trim();
    const key = clean.toLowerCase();
    if (clean === "" || seen.has(key)) return;
    seen.add(key);
    out.push(clean);
  };
  for (const item of extra) if (HOW_TO_OPEN.test(item)) add(item);
  for (const rule of profile.testRules) {
    if (files.some((file) => covers(rule.pattern, file))) add(rule.test);
  }
  for (const item of notVerifiedItems(body)) add(`Not verified by the agent: ${item}`);
  for (const item of extra) add(item);
  return out;
}
