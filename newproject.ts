// Add project: a new folder under the owner's projects folder (the local
// config's `projectsDir`, else ~/Documents/Github) with a first commit, a
// private GitHub repo under whoever `gh` is signed in as on this machine, and
// its own Patches chat. The pure policy lives here (slug, validation, first
// files, the gh argv, reading the gh login, what the visibility check means); host.ts does the writes, server.ts registers it.
// No node imports: the app uses projectSlug for its live preview.

/** Under the home directory: where new projects go when the local config names no folder (setupwizard.ts). */
export const PROJECTS_DIR = ["Documents", "Github"] as const;
export const PROJECT_NAME_MAX = 60;
const SLUG_MAX = 60;
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** "Café Río" → "cafe-rio": lower-case, accents dropped, runs of anything else one dash. */
export function projectSlug(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
}

export type NewProjectCheck = { ok: true; slug: string; path: string } | { ok: false; reason: string };

export function validateNewProject(
  name: string,
  existing: { names: readonly string[]; paths: readonly string[] },
  parentDir: string,
): NewProjectCheck {
  const trimmed = name.trim();
  if (trimmed === "") return { ok: false, reason: "Give the project a name." };
  if (trimmed.length > PROJECT_NAME_MAX) {
    return { ok: false, reason: `Keep the name to ${PROJECT_NAME_MAX} characters or fewer.` };
  }
  const slug = projectSlug(trimmed);
  if (!SLUG_PATTERN.test(slug)) {
    return { ok: false, reason: "Use at least one letter or digit in the name: it becomes the folder's name." };
  }
  const lower = trimmed.toLowerCase();
  const same = existing.names.find((other) => other.trim().toLowerCase() === lower);
  if (same !== undefined) return { ok: false, reason: `There is already a project called ${same}. Pick another name.` };
  const path = `${parentDir.replace(/\/+$/, "")}/${slug}`;
  if (existing.paths.some((other) => other.replace(/\/+$/, "") === path)) {
    return { ok: false, reason: `${path} is already a project. Pick another name.` };
  }
  return { ok: true, slug, path };
}

/** The host's lstat check, said plainly. */
export function folderExistsReason(path: string): string {
  return `${path} already exists. Pick another name, or use Add existing folder… to register it.`;
}

export function firstCommitFiles(name: string): { path: string; content: string }[] {
  const title = name.trim();
  return [
    { path: "README.md", content: `# ${title}\n\nA new project. Start with [CLAUDE.md](CLAUDE.md).\n` },
    {
      path: "CLAUDE.md",
      content: [
        `# CLAUDE.md: ${title}`,
        "",
        "This is a map. Fill it in as the project takes shape: what it is, where things live, and what must not break.",
        "",
        "## Rules nobody waives",
        "- Follow this file.",
        "- Never touch production data.",
        "- Merging is the owner's, never an agent's.",
        "",
      ].join("\n"),
    },
    // Builds refuse a repo that does not ignore .claude/ (worktrees live there).
    { path: ".gitignore", content: ".claude/\n.DS_Store\n.env*\n" },
  ];
}

export function firstCommitMessage(name: string): string {
  return `${name.trim()}: first commit`;
}

/** `gh api user --jq .login`: the account gh is signed in as. */
export const GH_LOGIN_ARGS = ["api", "user", "--jq", ".login"] as const;
const GH_LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

/**
 * The login from that command's stdout, or null. It goes into a gh argv and a
 * pasteable shell line, so anything that is not GitHub's login shape is refused.
 */
export function parseGhLogin(stdout: string): string | null {
  const login = stdout.trim();
  return GH_LOGIN_PATTERN.test(login) ? login : null;
}

/** Always --private; `--push` sends main to the new origin. */
export function ghCreateArgs(owner: string, slug: string, path: string): string[] {
  return ["repo", "create", `${owner}/${slug}`, "--private", "--source", path, "--remote", "origin", "--push"];
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** The same command as one line the owner can paste into Terminal. */
export function ghRetryCommand(owner: string, slug: string, path: string): string {
  return `gh repo create ${owner}/${slug} --private --source ${shellQuote(path)} --remote origin --push`;
}

export type Visibility = "private" | "public" | "unknown";

/** An unauthenticated GET of the repo: 404 means nobody outside can see it. */
export function visibilityFromStatus(status: number): Visibility {
  if (status === 404) return "private";
  if (status === 200) return "public";
  return "unknown";
}

/** The order the host follows; nothing after a failed step runs. */
export const NEW_PROJECT_STEPS = [
  "mkdir",
  "files",
  "git init -b main",
  "git add -A",
  "git commit",
  "gh repo create --private --push",
  "verify private",
] as const;
