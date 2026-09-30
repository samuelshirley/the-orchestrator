import { configDefaults, defineConfig } from "vitest/config";

// Task worktrees live under .claude/worktrees with their own copies of these
// tests; running them here would test other branches, not this checkout.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, ".claude/**"] },
});
