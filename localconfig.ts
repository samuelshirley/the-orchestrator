// The owner's own settings, read from a file on this machine and never from
// this repo: ~/.config/the-orchestrator/config.json. It holds the profiles for
// the owner's own projects (profiles.ts has only the built-in ones) and the
// Chrome account browser agents use. A file that is missing is an empty
// config. A file that is wrong in any way is not used at all, and loudly: the
// board shows one red line saying why, and build, open_pr and ready_for_review
// refuse for every project but The Orchestrator's own (configBlocks). Pure:
// the host reads the file (host.ts `localConfig`) and keeps a copy of the last
// valid one. The only writer is the setup wizard (setupwizard.ts, host.ts
// `saveSetup`): it sets `projectsDir` and the name, keeps every other key, and
// never writes over a file that has a problem. localconfig.test.ts pins the rules.
import { z } from "zod";
import { couldCopyEnv, type ProjectProfile } from "./profiles";

/** Under the home directory; the host joins it. */
export const LOCAL_CONFIG_PATH = [".config", "the-orchestrator", "config.json"] as const;
/** What a person reads and edits. */
export const LOCAL_CONFIG_DISPLAY = `~/${LOCAL_CONFIG_PATH.join("/")}`;
/** The host's copy of the last valid file, in its data dir. */
export const LOCAL_CONFIG_LAST_GOOD = "local-config.last-good.json";
/** The host reads no more than this of the file; a longer one is refused. */
export const LOCAL_CONFIG_MAX_CHARS = 200_000;

/** Built-in profile keys (profiles.ts) a local profile may not take. */
export const RESERVED_PROFILE_KEYS: readonly string[] = ["default", "the-orchestrator"];

const line = (max: number) => z.string().min(1).max(max);
const argv = z.array(line(500)).min(1).max(30);

/** Exactly `ProjectProfile` (profiles.ts); the type check below keeps them in agreement. */
export const projectProfileSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "must be lower-case letters, digits and dashes, at most 40"),
    names: z.array(line(100)).max(20),
    remotes: z.array(z.string().regex(/^[^/\s]+\/[^/\s]+$/, "must be owner/repo").max(200)).max(20),
    checks: z.array(line(500)).max(20),
    ci: z.enum(["full", "none"]),
    markers: z
      .object({ preview: line(200).nullable(), e2e: line(200).nullable(), ios: line(200).nullable() })
      .strict(),
    iosPaths: z.array(line(300)).max(50),
    aiTestsLabel: line(100).nullable(),
    aiRanPatterns: z.array(line(300)).max(20),
    sharedPaths: z.array(line(300)).max(50),
    mirrors: z.array(z.tuple([line(300), line(300)])).max(20),
    build: z.enum(["worktree", "flux-prompts"]),
    land: z.enum(["pr", "main"]),
    backup: line(100).nullable(),
    afterLand: z.array(argv).max(10),
    worktreeInclude: z.array(line(300)).max(50),
    productionEnv: z.boolean(),
    setup: z.array(argv).max(10),
    testRules: z.array(z.object({ pattern: line(300), test: line(300) }).strict()).max(50),
    rules: z.array(line(500)).max(20),
  })
  .strict();

type Mutable<T> = T extends readonly (infer U)[] ? Mutable<U>[] : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
/** Fails to compile when the schema and the interface drift apart. */
export type ProfileSchemaAgrees = Assert<Same<Mutable<ProjectProfile>, Mutable<z.infer<typeof projectProfileSchema>>>>;

export const localConfigSchema = z
  .object({
    /** The owner's first name in every prompt and on the board (owner.ts); absent: the first word of git's user.name. */
    ownerName: z.string().min(1).max(40).optional(),
    /** The Google account of the Chrome profile browser agents use; null or absent: whichever Chrome is connected. */
    chromeAccount: z
      .string()
      .max(200)
      .regex(/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/, "must be an email address")
      .nullable()
      .optional(),
    /**
     * The folder The Orchestrator may work in: Add project makes new folders
     * here, and the setup wizard lists its repos. Absent: ~/Documents/Github.
     * The host checks it is inside the home directory (setupwizard.ts).
     */
    projectsDir: z.string().max(500).regex(/^\//, "must be an absolute path").optional(),
    profiles: z.array(projectProfileSchema).max(50).optional(),
  })
  .strict();

export interface LocalConfig {
  ownerName: string | null;
  chromeAccount: string | null;
  projectsDir: string | null;
  profiles: readonly ProjectProfile[];
}

export const EMPTY_LOCAL_CONFIG: LocalConfig = { ownerName: null, chromeAccount: null, projectsDir: null, profiles: [] };

/** The first rule a schema-valid file still breaks, or null. */
function unsafe(profiles: readonly ProjectProfile[]): string | null {
  const seen = new Set<string>();
  for (const profile of profiles) {
    const name = `profile "${profile.key}"`;
    if (RESERVED_PROFILE_KEYS.includes(profile.key)) return `${name} uses a built-in key`;
    if (seen.has(profile.key)) return `${name} is there twice`;
    seen.add(profile.key);
    // Merge is a production deploy: only the built-in Orchestrator profile lands on main.
    if (profile.land === "main") return `${name} has land "main", which only The Orchestrator's own profile may have (use "pr")`;
    if (profile.productionEnv) {
      const env = profile.worktreeInclude.find(couldCopyEnv);
      if (env !== undefined) return `${name} is productionEnv, so its worktreeInclude may not have ${JSON.stringify(env)}, which could copy an .env file`;
    }
    for (const pattern of profile.aiRanPatterns) {
      try {
        new RegExp(pattern, "iu");
      } catch {
        return `${name} has an aiRanPatterns entry that is not a regular expression`;
      }
    }
  }
  return null;
}

/** Until the first read: nothing is known about the file, so nothing relies on it. */
export const LOCAL_CONFIG_NOT_READ = `${LOCAL_CONFIG_DISPLAY} has not been read yet.`;

/** What the server holds: the config in force, and why the file is not it, if so. */
export interface LocalConfigState {
  config: LocalConfig;
  problem: string | null;
  /** True once the host has answered: the file's text, or that there is none. */
  read: boolean;
}

export const INITIAL_LOCAL_CONFIG: LocalConfigState = { config: EMPTY_LOCAL_CONFIG, problem: LOCAL_CONFIG_NOT_READ, read: false };

/**
 * The state after one read. `answer` is what the host said (`text` null: no
 * such file, which is no problem), or null when the host call itself failed:
 * then the last state stands, and before any read that is still a problem.
 */
export function nextLocalConfig(previous: LocalConfigState, answer: { text: string | null } | null): LocalConfigState {
  if (answer === null) return previous;
  return { ...parseLocalConfig(answer.text), read: true };
}

/**
 * Why build, open_pr and ready_for_review refuse for this project, or null.
 * A file that is wrong is never a silent fall back to the default profile:
 * that would drop the project's ai-tests gate, held paths and production-env
 * rule. Only The Orchestrator's own built-in profile needs no file.
 */
export function configBlocks(problem: string | null, profileKey: string): string | null {
  if (problem === null || profileKey === "the-orchestrator") return null;
  return `${problem} Fix ${LOCAL_CONFIG_DISPLAY}: build, open_pr and ready_for_review refuse until it loads.`;
}

/**
 * The config from the file's text (null: no file). Anything wrong with the
 * file makes `problem` one sentence and the config empty: never half a file.
 */
export function parseLocalConfig(text: string | null): { config: LocalConfig; problem: string | null } {
  if (text === null) return { config: EMPTY_LOCAL_CONFIG, problem: null };
  const refuse = (issue: string) => ({
    config: EMPTY_LOCAL_CONFIG,
    problem: `${LOCAL_CONFIG_DISPLAY} is not in use: ${issue}.`,
  });
  if (text.length > LOCAL_CONFIG_MAX_CHARS) return refuse("it is larger than 200 KB");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return refuse("it is not valid JSON");
  }
  const parsed = localConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first === undefined || first.path.length === 0 ? "" : `${first.path.join(".")}: `;
    return refuse(`${where}${(first?.message ?? "it does not match the schema").slice(0, 200)}`);
  }
  const profiles = parsed.data.profiles ?? [];
  const broken = unsafe(profiles);
  if (broken !== null) return refuse(broken);
  return {
    config: {
      ownerName: parsed.data.ownerName ?? null,
      chromeAccount: parsed.data.chromeAccount ?? null,
      projectsDir: parsed.data.projectsDir ?? null,
      profiles,
    },
    problem: null,
  };
}
