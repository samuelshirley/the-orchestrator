// Task and research threads share the project's main checkout. Spawning them
// with a `project-checkout` provider intent makes bb provision every time, and
// provisioning binds the shared checkout environment to the new thread
// (owner_thread_id, claim_path). If bb restarts before the thread attaches, the
// claim sticks and every other thread in that environment gets HTTP 409
// "Cannot checkout branch while another thread is using this workspace".
// Reusing the existing environment never takes that claim. Pure: server.ts
// lists the environments and spawns.

import { WORKTREES_DIR } from "./worktrees";

export const CHECKOUT_PROVIDER = "project-checkout";

/** The fields of a bb Environment this module reads. */
export interface CheckoutCandidate {
  id: string;
  projectId: string;
  hostId: string;
  path: string | null;
  environmentProviderId: string | null;
  isWorktree: boolean;
  managed: boolean;
  status: string;
  lifecycle: { phase: string };
  updatedAt: number;
}

export interface CheckoutTarget {
  projectId: string;
  hostId: string;
  path: string;
}

const trimSlashes = (path: string) => path.replace(/\/+$/, "") || "/";

function isCheckoutOf(env: CheckoutCandidate, target: CheckoutTarget): boolean {
  if (env.projectId !== target.projectId || env.hostId !== target.hostId) return false;
  if (env.path === null || trimSlashes(env.path) !== trimSlashes(target.path)) return false;
  if (env.isWorktree || trimSlashes(env.path).includes(`/${WORKTREES_DIR}/`)) return false;
  // bb's own unmanaged host workspace on the same path is the checkout too.
  const provider = env.environmentProviderId;
  if (provider !== CHECKOUT_PROVIDER && !(provider === null && !env.managed)) return false;
  return env.status === "ready" && env.lifecycle.phase === "active";
}

/** The checkout environment a task or research thread should reuse, newest first; null to provision one. */
export function pickCheckoutEnvironment(envs: readonly CheckoutCandidate[], target: CheckoutTarget): string | null {
  let best: CheckoutCandidate | null = null;
  for (const env of envs) {
    if (!isCheckoutOf(env, target)) continue;
    if (best === null || env.updatedAt > best.updatedAt) best = env;
  }
  return best?.id ?? null;
}
