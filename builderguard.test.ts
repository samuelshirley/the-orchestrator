import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  builderSettings,
  checkCommand,
  envPatternsOf,
  guardHookCommand,
  pluginSourceRoot,
  repoOf,
  type GuardContext,
} from "./builderguard";
import { LEGACY_SETTINGS_URL, withoutLegacyRoute } from "./legacyroute";

const REPO = "/Users/me/Github/app";
const WT = `${REPO}/.claude/worktrees/x`;
const SHOP_SCRIPTS: Record<string, string> = {
  test: "vitest run",
  "test:unit": "vitest run src",
  typecheck: "tsc --noEmit",
  "db:push": "drizzle-kit push",
  nuke: "rm -rf ~",
  e2e: "playwright test",
  "e2e:smoke": "playwright test --grep smoke",
  foo: "npm run e2e",
  deploy: "vercel --prod",
  safe: "npm run test",
  loop: "npm run loop",
  prebuild: "rm -rf /",
  build: "tsc",
};

function ctx(over: Partial<GuardContext> = {}): GuardContext {
  return { cwd: WT, worktree: WT, scripts: SHOP_SCRIPTS, ...over };
}

const allow = (command: string, over: Partial<GuardContext> = {}) =>
  expect(checkCommand(command, ctx(over)), command).toBeNull();
const deny = (command: string, pattern?: RegExp, over: Partial<GuardContext> = {}) => {
  const verdict = checkCommand(command, ctx(over));
  expect(verdict, command).not.toBeNull();
  if (pattern !== undefined) expect(verdict?.reason, command).toMatch(pattern);
};

describe("checkCommand: what builders do every day", () => {
  it.each([
    "npx tsc --noEmit",
    "npm run test",
    "npm test",
    "npm run test:unit",
    "npm run typecheck -- --pretty",
    "npx vitest run x",
    "npx vitest run",
    "rm -rf node_modules dist",
    "rm -rf ./tmp/x",
    "rm -r src/old && mkdir src/new",
    "rm -f ../../../x.txt",
    "git commit -m 'Fix the thing'",
    "git status",
    "git -C . log --oneline -5",
    "git diff HEAD~1 -- src/a.ts",
    "psql -h localhost -U me app_dev",
    "psql postgres://me@localhost:5432/app",
    "psql app_dev",
    "cat src/a.ts",
    "cat playwright.config.ts",
    "grep -rn DATABASE_URL .env.example src",
    "curl https://example.com",
    "curl -fsSL -o out.json https://example.com/x",
    "curl -X POST http://localhost:3000/api/x -d '{}'",
    "ls -la && echo done 2>&1 | tail -5",
    "cd mobile && npx tsc --noEmit",
    "find . -name '*.log' -delete",
    "find dist -type f -exec rm {} +",
    "supabase status",
    "DATABASE_URL=postgres://localhost/test npx drizzle-kit push",
    "npx drizzle-kit generate",
    "echo $HOME",
    "for f in a b; do echo $f; done",
    "(cd src && ls)",
    "node -e 'console.log(1)'",
  ])("allows %s", (command) => allow(command));

  it("allows a Claude-style commit message heredoc, quotes and parens included", () => {
    allow(`git commit -m "$(cat <<'EOF'\nFix (don't) \`break\` git push docs\n\nOrchestrator-Task: task_x\nEOF\n)"`);
  });

  it("follows a web app's npm run test into vitest run", () => {
    allow("npm run test", { scripts: { test: "vitest run" } });
    allow("npm run safe");
  });
});

describe("checkCommand: rm -r outside the worktree", () => {
  it.each([
    "rm -rf ~",
    "rm -rf ~/Documents",
    "rm -rf ../../..",
    "rm -rf /Users/x",
    "rm -rf /",
    "rm -fr ..",
    "rm -R ../other",
    "rm --recursive --force /tmp/x",
    "rm -rf .",
    `rm -rf ${WT}`,
    "rm -rf $HOME/x",
    "rm -rf ../*",
    "rm -rf .*",
    'bash -c "rm -rf /"',
    "sh -lc 'rm -rf ~'",
    "echo $(rm -rf ..)",
    "echo `rm -rf ..`",
    "sudo rm -rf /",
    "env FOO=1 rm -rf /",
    "nohup nice -n 5 rm -rf /",
    "eval rm -rf /",
    "ls | xargs rm -rf",
    "cd .. && rm -rf x",
    "cd $SOMEWHERE && rm -rf x",
    "find / -name x -delete",
    "find .. -exec rm -rf {} \\;",
    "npx -c 'rm -rf ~'",
  ])("denies %s", (command) => deny(command));

  it("denies npm run nuke whose script is rm -rf ~", () => deny("npm run nuke", /script "nuke"/));
  it("checks pre scripts too", () => deny("npm run build", /prebuild/));
});

describe("checkCommand: git push", () => {
  it.each(["git push", "git push -f", "git push --force-with-lease", "git push origin +main", "git -C . push", "git -c alias.p=push p"])(
    "denies %s",
    (command) => deny(command, /push/),
  );
  it("names force-push in the reason", () => {
    expect(checkCommand("git push --force", ctx())?.reason).toMatch(/force-push/);
  });
});

describe("checkCommand: prod DB and infra CLIs", () => {
  it.each([
    "vercel --prod",
    "npx vercel deploy",
    "eas submit",
    "eas build --platform ios",
    "neonctl branches list",
    "supabase db push",
    "flyctl deploy",
    "terraform apply",
    "kubectl delete ns x",
    "aws s3 rm s3://x --recursive",
    "firebase deploy",
    "psql $DATABASE_URL",
    "psql postgres://u@ep-x.neon.tech/db",
    "psql -h ep-x.neon.tech -U u db",
    "psql 'host=db.example.com dbname=x'",
    "PGHOST=db.example.com psql",
    "pg_dump --host=prod.example.com app",
    "mysql -hprod.example.com",
    "npx drizzle-kit push",
    "drizzle-kit migrate",
    "DATABASE_URL=$PROD npx drizzle-kit push",
    "DATABASE_URL=postgres://u@ep-x.neon.tech/db npx drizzle-kit push",
    "npx prisma migrate deploy",
    "npx prisma db push",
    "curl -X POST https://api.example.com/x",
    "curl -d 'a=1' https://api.example.com/x",
    "curl --request DELETE https://api.example.com/x",
    "wget --post-data=a https://api.example.com/x",
    "curl -X POST $URL",
  ])("denies %s", (command) => deny(command));

  it("denies an npm run db:push whose script is drizzle-kit push", () => deny("npm run db:push", /drizzle-kit push/));
  it("denies a script that deploys", () => deny("npm run deploy", /vercel/));
});

describe("checkCommand: the main checkout's env files", () => {
  it.each([
    "cat ../../../.env",
    "cat ../../../mobile/.env.local",
    `cat ${REPO}/.env`,
    `cp ${REPO}/.env .env.prod`,
    "head -5 < ../../../.env",
    "node --env-file=../../../.env x.js",
    "cat ../../../.env*",
    'cat "$(git rev-parse --show-toplevel)/.env"',
  ])("denies %s", (command) => deny(command, /env files/));

  it("allows the worktree's own files", () => {
    allow("cat .env.example");
    allow("ls ../../../src");
  });

  it("keeps the builder off its guard settings", () => {
    deny("cat /dev/null > .claude/settings.local.json", /guard/);
    deny("rm .claude/settings.local.json", /guard/);
  });
});

describe("checkCommand: e2e runs", () => {
  it.each([
    "npx playwright test",
    "npx @playwright/test test",
    "node_modules/.bin/playwright test",
    "pnpm exec playwright test",
    "bunx playwright test",
    "yarn playwright test",
    "playwright test",
    "npm run e2e",
    "npm run e2e:smoke",
    "npm run test:e2e:ci",
    "npm run foo",
    "maestro test flow.yaml",
    "./scripts/ios-e2e-local.sh",
    "bash scripts/ios-e2e-local.sh",
  ])("denies %s", (command) => deny(command, /e2e runs against the production DB/));

  it("denies npm run e2e whose script is playwright test, through the expansion", () => {
    deny("npm run check", /production DB/, { scripts: { check: "playwright test" } });
  });

  it("allows unit tests and reading the config", () => {
    allow("npx vitest run");
    allow("npm run test");
    allow("npm run test:unit");
    allow("cat playwright.config.ts");
  });
});

describe("checkCommand: fails closed", () => {
  it.each([
    "echo 'unterminated",
    'echo "unterminated',
    "echo $(ls",
    "echo )",
    "cat <<EOF\nno end",
    "$CMD -rf /",
    "sh -c \"$X\"",
    "echo rm -rf / | bash",
  ])("denies %s", (command) => deny(command));

  it("denies a script that isn't in package.json", () => deny("npm run nosuch", /No package.json script/));
  it("caps script recursion", () => deny("npm run loop", /deeper than 5/));
  it("denies when checking itself throws", () => {
    const broken = ctx({
      scriptsAt: () => {
        throw new Error("boom");
      },
    });
    expect(checkCommand("npm run test", broken)?.reason).toMatch(/guard failed/);
  });

  it("uses scriptsAt for the directory npm runs in", () => {
    const scriptsAt = (dir: string) => (dir === `${WT}/mobile` ? { typecheck: "tsc --noEmit", bad: "eas submit" } : SHOP_SCRIPTS);
    allow("cd mobile && npm run typecheck", { scriptsAt });
    deny("npm --prefix mobile run bad", /eas/, { scriptsAt });
  });
});

describe("repoOf", () => {
  it("strips .claude/worktrees/<slug>", () => {
    expect(repoOf(WT)).toBe(REPO);
    expect(repoOf("/elsewhere")).toBeNull();
  });
});

describe("builderSettings", () => {
  const options = {
    hookCommand: guardHookCommand("/plugins/orc", WT),
    repoPath: REPO,
    envPatterns: envPatternsOf([".env*", "mobile/.env*", "node_modules", "mobile/google-services.json"]),
    worktreePath: WT,
  };

  it("picks the env-like include patterns", () => {
    expect(envPatternsOf([".env*", "/mobile/.env*", ".env.local", "foo.json", "../.env", ".env*"])).toEqual([
      ".env*",
      "mobile/.env*",
      ".env.local",
    ]);
  });

  it("quotes the hook command and fails closed", () => {
    expect(guardHookCommand("/p/it's", "/w")).toBe(`node '/p/it'\\''s/builderguard.ts' '/w' || exit 2`);
  });

  it("keeps existing keys and adds the guard, sandbox and deny rules", () => {
    const existing = {
      enabledMcpjsonServers: ["playwright"],
      permissions: { allow: ["Bash(npm test)"], deny: ["Bash(rm:*)"] },
      hooks: { PostToolUse: [{ matcher: "Edit", hooks: [] }], PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "x" }] }] },
      sandbox: { enabled: false, allowUnsandboxedCommands: true },
    };
    const out = builderSettings(existing, options) as {
      enabledMcpjsonServers: string[];
      permissions: { allow: string[]; deny: string[] };
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }>; PostToolUse: unknown[] };
      sandbox: { enabled: boolean; allowUnsandboxedCommands: boolean; network: { allowedDomains: string[] } };
    };
    expect(out.enabledMcpjsonServers).toEqual(["playwright"]);
    expect(out.permissions.allow).toEqual(["Bash(npm test)"]);
    expect(out.hooks.PostToolUse).toHaveLength(1);
    expect(out.hooks.PreToolUse).toEqual([
      { matcher: "Edit", hooks: [{ type: "command", command: "x" }] },
      { matcher: "Bash", hooks: [{ type: "command", command: options.hookCommand }] },
    ]);
    expect(out.sandbox.enabled).toBe(true);
    expect(out.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(out.sandbox.network.allowedDomains).toEqual(["registry.npmjs.org"]);
    expect(out.permissions.deny).toEqual([
      "Bash(rm:*)",
      `Read(/${REPO}/.env*)`,
      `Read(/${REPO}/mobile/.env*)`,
      "Bash(git push:*)",
      `Edit(/${WT}/.claude/**)`,
    ]);
    expect(out.permissions.deny[1].startsWith("Read(//Users/")).toBe(true);
    // The input is not mutated.
    expect(existing.sandbox.enabled).toBe(false);
  });

  it("is idempotent, and a moved plugin replaces its old hook", () => {
    const once = builderSettings({}, options);
    expect(builderSettings(once, options)).toEqual(once);
    const moved = builderSettings(once, { ...options, hookCommand: guardHookCommand("/new", WT) }) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(moved.hooks.PreToolUse).toHaveLength(1);
    expect(moved.hooks.PreToolUse[0].hooks[0].command).toContain("/new/builderguard.ts");
  });

  it("starts from nothing when the existing file isn't an object", () => {
    expect(builderSettings(["junk"], options)).toEqual(builderSettings({}, options));
  });

  it("never sets a base URL, and a reused worktree loses the removed proxy's key (host writeBuilderGuard)", () => {
    const guarded = builderSettings({}, options);
    expect(JSON.stringify(guarded)).not.toContain("ANTHROPIC_BASE_URL");
    // A worktree the first version routed: the key goes, the guard is the same.
    const legacy = { ...guarded, env: { ANTHROPIC_BASE_URL: LEGACY_SETTINGS_URL } };
    expect(builderSettings(withoutLegacyRoute(legacy) ?? legacy, options)).toEqual(guarded);
    // An owner-set gateway is kept.
    const owner = { env: { ANTHROPIC_BASE_URL: "https://gw.example.com" } };
    expect(withoutLegacyRoute(owner)).toBeNull();
    expect((builderSettings(owner, options).env as Record<string, string>).ANTHROPIC_BASE_URL).toBe("https://gw.example.com");
  });
});

describe("the hook process", () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), "builderguard.ts");
  const root = mkdtempSync(join(tmpdir(), "guard-"));
  const wt = join(root, ".claude", "worktrees", "x");
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, "package.json"), JSON.stringify({ scripts: { test: "vitest run", nuke: "rm -rf ~" } }));
  const run = (input: string, argv: string[] = [wt]) =>
    spawnSync(process.execPath, [file, ...argv], { input, encoding: "utf8" });
  const bash = (command: string) => JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: wt });

  it("exits 2 with the reason on deny, 0 on allow", () => {
    const denied = run(bash("rm -rf ~"));
    expect(denied.status).toBe(2);
    expect(denied.stderr).toMatch(/Builder guard: rm -r ~/);
    expect(run(bash("npm run test")).status).toBe(0);
    expect(run(bash("npm run nuke")).status).toBe(2);
    expect(run(JSON.stringify({ tool_name: "Read", tool_input: {} })).status).toBe(0);
  });

  it("fails closed on bad input or no worktree", () => {
    expect(run("not json").status).toBe(2);
    expect(run(bash("ls"), []).status).toBe(2);
    expect(run(JSON.stringify({ tool_name: "Bash", tool_input: {} })).status).toBe(2);
  });

  it("cleans up", () => {
    rmSync(root, { recursive: true, force: true });
  });
});

describe("pluginSourceRoot", () => {
  it("never trusts bb's host artifacts folder", () => {
    expect(pluginSourceRoot("/Users/x/.bb/plugin-host-artifacts/the-orchestrator/7fdb0e/")).toBeNull();
    expect(pluginSourceRoot("/Users/x/.bb/plugin-host-artifacts/the-orchestrator/7fdb0e")).toBeNull();
    expect(pluginSourceRoot("/Users/x/.bb/plugin-host-artifacts/the-orchestrator/7fdb0e/dist")).toBeNull();
  });
  it("takes <root> from <root>/dist", () => {
    expect(pluginSourceRoot("/repo/dist")).toBe("/repo");
    expect(pluginSourceRoot("/repo/dist/")).toBe("/repo");
  });
  it("takes a source folder as it is", () => {
    expect(pluginSourceRoot("/repo")).toBe("/repo");
    expect(pluginSourceRoot("/repo/")).toBe("/repo");
    expect(pluginSourceRoot("/repo/distant")).toBe("/repo/distant");
  });
  it("gives a hook command that points at <root>/builderguard.ts", () => {
    expect(guardHookCommand(pluginSourceRoot("/repo/dist") ?? "", WT)).toContain("'/repo/builderguard.ts'");
  });
});
