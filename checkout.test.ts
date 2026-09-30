import { describe, expect, it } from "vitest";
import { CHECKOUT_PROVIDER, type CheckoutCandidate, pickCheckoutEnvironment } from "./checkout";

const REPO = "/Users/me/Documents/Github/AcmeGoods";
const target = { projectId: "proj_a", hostId: "host_a", path: REPO };

/** env_wdhv6vrfmc as bb listed it on 2026-09-24. */
function env(overrides: Partial<CheckoutCandidate> = {}): CheckoutCandidate {
  return {
    id: "env_checkout",
    projectId: "proj_a",
    hostId: "host_a",
    path: REPO,
    environmentProviderId: CHECKOUT_PROVIDER,
    isWorktree: false,
    managed: false,
    status: "ready",
    lifecycle: { phase: "active" },
    updatedAt: 100,
    ...overrides,
  };
}

describe("pickCheckoutEnvironment", () => {
  it("reuses the project's checkout environment", () => {
    expect(pickCheckoutEnvironment([env()], target)).toBe("env_checkout");
  });

  it("ignores a trailing slash on either side", () => {
    expect(pickCheckoutEnvironment([env({ path: `${REPO}/` })], target)).toBe("env_checkout");
    expect(pickCheckoutEnvironment([env()], { ...target, path: `${REPO}//` })).toBe("env_checkout");
  });

  it("accepts bb's unmanaged host workspace on the same path", () => {
    expect(pickCheckoutEnvironment([env({ environmentProviderId: null })], target)).toBe("env_checkout");
    expect(pickCheckoutEnvironment([env({ environmentProviderId: null, managed: true })], target)).toBeNull();
  });

  it("refuses another host, project, path, provider, status or lifecycle", () => {
    for (const other of [
      env({ hostId: "host_b" }),
      env({ projectId: "proj_b" }),
      env({ path: `${REPO}-copy` }),
      env({ path: null }),
      env({ environmentProviderId: "git-worktree" }),
      env({ environmentProviderId: "personal-workspace", managed: true }),
      env({ status: "provisioning" }),
      env({ status: "error" }),
      env({ lifecycle: { phase: "retiring" } }),
      env({ lifecycle: { phase: "destroyed" } }),
    ]) {
      expect(pickCheckoutEnvironment([other], target), JSON.stringify(other)).toBeNull();
    }
  });

  it("never picks a worktree, even one claiming the checkout provider", () => {
    const worktree = `${REPO}/.claude/worktrees/landing-page`;
    expect(pickCheckoutEnvironment([env({ path: worktree, isWorktree: true })], target)).toBeNull();
    expect(pickCheckoutEnvironment([env({ isWorktree: true })], target)).toBeNull();
    expect(pickCheckoutEnvironment([env({ path: worktree })], { ...target, path: worktree })).toBeNull();
  });

  it("picks the most recently updated of several", () => {
    const envs = [env({ id: "env_old", updatedAt: 1 }), env({ id: "env_new", updatedAt: 3 }), env({ id: "env_mid", updatedAt: 2 })];
    expect(pickCheckoutEnvironment(envs, target)).toBe("env_new");
    expect(pickCheckoutEnvironment([env({ id: "env_new", updatedAt: 9, hostId: "host_b" }), env({ id: "env_ok" })], target)).toBe("env_ok");
  });

  it("gives null for an empty list", () => {
    expect(pickCheckoutEnvironment([], target)).toBeNull();
  });
});
