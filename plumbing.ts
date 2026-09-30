// Orchestrator plumbing: files that exist only so The Orchestrator can run a
// project. They stay here (profiles.ts) and never ride a PR into an app repo.
// Pure — open_pr and validatePr hand in the branch's changed files.
import { covers } from "./claims";

/** Exact paths or `dir/**` subtrees, repo-relative. */
export const ORCHESTRATOR_ONLY: readonly string[] = [
  // Worktree includes and setup live in profiles.ts (worktreeInclude, setup);
  // the host applies them to every worktree it creates.
  ".worktreeinclude",
  ".bb-env-setup.sh",
  // Browser work runs in the owner's Chrome through Claude in Chrome, not a per-repo
  // MCP config. Root only: an app may ship its own nested one.
  ".mcp.json",
  // Agent settings, scratch space and handoffs.
  ".claude/**",
  ".claude-tmp/**",
  ".handoff/**",
  ".playwright-mcp/**",
  // Task notes for agents stay in the task thread.
  "docs/tasks/**",
];

/** Agent briefs (`docs/bugs/onboarding-fix-prompt.md`) at any depth. */
const PROMPT_FILE = /-prompt\.md$/i;

function normalize(file: string): string {
  let path = file.trim().replace(/\\/g, "/");
  while (path.startsWith("./")) path = path.slice(2);
  return path;
}

export function isOrchestratorOnly(file: string): boolean {
  const path = normalize(file);
  return ORCHESTRATOR_ONLY.some((pattern) => covers(pattern, path)) || PROMPT_FILE.test(path);
}

/** Documentation: anything under docs/, and Markdown anywhere. */
export function isDocsOnly(file: string): boolean {
  const path = normalize(file);
  return covers("docs/**", path) || /\.md$/i.test(path);
}

const NAMED = 8;

/**
 * Why a PR to an app repo with these changed files is refused, or null when
 * it carries app code. Plumbing is refused outright; a docs-only branch is
 * refused because docs ride with the change they describe.
 */
export function plumbingRefusal(files: readonly string[]): string | null {
  const plumbing = files.filter(isOrchestratorOnly);
  if (plumbing.length > 0) {
    const named = plumbing.slice(0, NAMED).join(", ");
    const more = plumbing.length > NAMED ? ` …and ${plumbing.length - NAMED} more` : "";
    return (
      "Orchestrator plumbing stays out of app repos: worktree includes and setup go in " +
      "The Orchestrator's profiles.ts; notes for agents stay in the task thread. " +
      `Drop these from the branch: ${named}${more}.`
    );
  }
  if (files.length > 0 && files.every(isDocsOnly)) {
    return "A PR to an app repo carries app code: docs ride with the change they describe.";
  }
  return null;
}
