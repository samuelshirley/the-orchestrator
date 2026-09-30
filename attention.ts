// What may reach the owner, and in what shape. Pure; attention.test.ts pins it.
//
// The owner's rule: anything an agent can run, it runs. What reaches them is either
// a decision with options (and the agent's pick), or a command only they can
// run, with the reason only they can. A failed build goes back to its task to
// fix first; it reaches the owner only after BUILD_FAILURE_LIMIT tries.

import { Owner, owner } from "./owner";

/** Build failures in a row a task fixes on its own before the owner sees it. */
export const BUILD_FAILURE_LIMIT = 2;

/** Why a command can only be the owner's: their login, their account, their hardware. */
export const SAM_ONLY_REASONS = ["credential", "account", "device"] as const;
export type SamOnlyReason = (typeof SAM_ONLY_REASONS)[number];

export type Ask =
  | {
      kind: "decision";
      question: string;
      /** 2–5 concrete choices; the owner can still type their own. */
      options: string[];
      /** Index into options: the agent's pick, so "yes" is one click. */
      recommended: number;
    }
  | {
      kind: "command";
      /** What it does and why only the owner can run it. */
      question: string;
      command: string;
      cwd: string | null;
      reason: SamOnlyReason;
    };

/** Why this ask cannot reach the owner as written; null when it can. */
export function validateAsk(ask: Ask): string | null {
  if (ask.question.trim().length < 10) return "Say what you need in a full sentence.";
  if (ask.kind === "decision") {
    const options = ask.options.map((option) => option.trim()).filter(Boolean);
    if (options.length < 2 || options.length > 5) {
      return `A decision needs 2 to 5 options (got ${options.length}). If there is nothing to choose, decide it and record the decision.`;
    }
    if (new Set(options).size !== options.length) return "The options repeat.";
    if (!Number.isInteger(ask.recommended) || ask.recommended < 0 || ask.recommended >= ask.options.length) {
      return "Recommend one of the options: recommended is its index.";
    }
    return null;
  }
  if (ask.command.trim() === "") return "Give the exact command.";
  if (!SAM_ONLY_REASONS.includes(ask.reason)) {
    return `A command reaches ${owner()} only for their ${SAM_ONLY_REASONS.join(", ")}. Anything else, run it yourself.`;
  }
  return null;
}

/** The one-line form: what the ticket stores, what the task hears back. */
export function askLine(ask: Ask): string {
  if (ask.kind === "decision") {
    const options = ask.options
      .map((option, index) => `${option.trim()}${index === ask.recommended ? " (recommended)" : ""}`)
      .join(" / ");
    return `${ask.question.trim()} Options: ${options}`;
  }
  return `${ask.question.trim()} Run: ${ask.command.trim()}${ask.cwd ? ` (in ${ask.cwd})` : ""}`;
}

/** A failed build is the owner's only once the task has tried and failed enough. */
export function buildNeedsSam(task: { buildState: string; buildFailures: number }): boolean {
  return task.buildState === "failed" && task.buildFailures >= BUILD_FAILURE_LIMIT;
}

/** What the owning task hears when its build fails. */
export function buildFailedMessage({
  taskId,
  reason,
  failures,
  worktreePath,
}: {
  taskId: string;
  reason: string;
  failures: number;
  worktreePath: string | null;
}): string {
  const head = `[The Orchestrator] The build for ${taskId} failed (${failures} of ${BUILD_FAILURE_LIMIT} before ${owner()} sees it); its claims are released.\n\n${reason}`;
  if (failures < BUILD_FAILURE_LIMIT) {
    return `${head}\n\nFix it yourself. Read the error, run what you need to find the cause${worktreePath ? ` (the worktree ${worktreePath} is kept and the next build reuses it)` : ""}, then call build again with the same touches. Do not ask ${owner()} for anything you can run.`;
  }
  return `${head}\n\n${Owner()} now has it on their board with Retry and Dismiss. If only they can unblock it (their login, account or device), ask_sam with a command ask saying exactly what to run. Otherwise keep fixing it and call build again.`;
}
