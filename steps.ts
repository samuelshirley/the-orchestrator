// A task with several build-and-land steps stays open between them. land()
// takes `more` (what is left); with it, a confirmed reload releases the claims
// and the build slot, records the landed commit and tells the thread to carry
// on, and the task is not closed. The final land (no `more`) or an explicit
// close ends it. The steps left live in the dossier's meta, one row per task;
// landed.ts and done.ts keep a task with steps left open, and the board shows
// "Step landed, N left" (model.ts).
// Pure; steps.test.ts pins it.

/** Meta key holding a task's steps record. */
export function stepsKey(taskId: string): string {
  return `steps_left:${taskId}`;
}

/** How much of one step is kept. */
export const STEP_MAX = 300;

/** How many steps are kept. */
export const STEPS_MAX = 20;

const NONE = /^(?:none|nothing|n\/a|-)\.?$/i;

/**
 * land's `more` text as a list of steps: one per line or ";", bullets and
 * numbering dropped. "none", "nothing", "n/a", "-" and "" are no steps.
 */
export function parseMore(value: string | null | undefined): string[] {
  if (typeof value !== "string") return [];
  const out: string[] = [];
  for (const raw of value.split(/[\n;]/)) {
    const step = raw
      .trim()
      .replace(/^(?:[-*•–—]+|\(?\d{1,3}[.):]|step\s+\d{1,3}\s*[.):-])\s+/i, "")
      .trim();
    if (step === "" || NONE.test(step)) continue;
    out.push(step.slice(0, STEP_MAX));
    if (out.length === STEPS_MAX) break;
  }
  return out;
}

/** A task's steps, as stored under stepsKey(taskId). */
export interface StepsRecord {
  /** What is still to build and land. */
  left: string[];
  /** Shas of the steps landed so far, oldest first. */
  landed: string[];
}

export function serializeSteps(record: StepsRecord): string {
  return JSON.stringify({ left: record.left, landed: record.landed });
}

/** A stored record, or null when it is not one. */
export function parseSteps(raw: string | null): StepsRecord | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { left, landed } = value as Record<string, unknown>;
  const strings = (list: unknown): list is string[] => Array.isArray(list) && list.every((item) => typeof item === "string");
  if (!strings(left) || !strings(landed)) return null;
  return { left, landed };
}

/** The record after a step landed: its sha added, the steps left replaced. */
export function stepLanded(record: StepsRecord | null, sha: string, left: readonly string[]): StepsRecord {
  const landed = record?.landed ?? [];
  return { left: [...left], landed: landed.includes(sha) ? [...landed] : [...landed, sha] };
}

/** How many steps the stored record says are left; none when absent or unreadable. */
export function stepsLeftCount(raw: string | null): number {
  return parseSteps(raw)?.left.length ?? 0;
}

/** land keeps the task open only when it named at least one step left. */
export function keepOpenAfterLand(more: readonly string[] | null | undefined): boolean {
  return more !== null && more !== undefined && more.length > 0;
}

/** Told to the task's thread once a step's reload is live. */
export function stepLandedMessage(taskId: string, sha: string, left: readonly string[]): string {
  const steps = left.map((step, index) => `${index + 1}. ${step}`).join("\n");
  return `[The Orchestrator] Reloaded: ${sha.slice(0, 7)} is live. ${taskId} stays open, claims and build slot released. Carry on with:\n${steps}\nCall build again with the next step's touches. Pass \`more\` to land while steps are left; the final land (no \`more\`) closes ${taskId}.`;
}

/** The board's label for a kept-open task. */
export function stepsLabel(left: number): string {
  return `Step landed, ${left} left`;
}

/** land's reply when the task stays open. */
export function stepKeptReply(taskId: string, left: number): string {
  return `${taskId} stays open with ${left} step${left === 1 ? "" : "s"} left: build again for the next one.`;
}

/** The release recorded when a step landed and the task stays open. */
export function stepReleaseReason(sha: string, left: number): string {
  return `Step landed at ${sha.slice(0, 7)}; kept open with ${left} step${left === 1 ? "" : "s"} left.`;
}
