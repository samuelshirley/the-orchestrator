// The first name of whoever runs The Orchestrator, for every string an agent
// or the owner reads. From the local config's `ownerName` (localconfig.ts),
// else the first word of git's user.name, else "the owner". The server sets it
// after each local config load; the app sets its own copy from the board
// payload. Tool names, stored keys and ids never carry it. Pure apart from the
// one name held here; owner.test.ts pins it.

/** What the owner is called when neither the config nor git has a name. */
export const OWNER_FALLBACK = "the owner";
/** The dossier meta key holding the name as of the last load, for the next start. */
export const OWNER_NAME_KEY = "owner_name";
/** No name is longer than this in a prompt. */
export const OWNER_NAME_MAX = 40;

/** One line of plain text: control characters become spaces, runs of spaces one, cut at the cap. */
function clean(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, OWNER_NAME_MAX)
    .trim();
}

/**
 * The name in force: the config's name as written (trimmed) when it has one,
 * else the first word of git's user.name, else the fallback.
 */
export function ownerFirstName(configName: string | null | undefined, gitUserName: string | null | undefined): string {
  const fromConfig = clean(configName);
  if (fromConfig !== "") return fromConfig;
  const fromGit = clean(clean(gitUserName).split(" ")[0]);
  if (fromGit !== "") return fromGit;
  return OWNER_FALLBACK;
}

let current = OWNER_FALLBACK;

/** Set the name every later owner() call gives; nothing usable resets it to the fallback. */
export function setOwner(name: string | null | undefined): void {
  const cleaned = clean(name);
  current = cleaned === "" ? OWNER_FALLBACK : cleaned;
}

/** "Alex", or "the owner". */
export function owner(): string {
  return current;
}

/** Possessive: "Alex's", or "the owner's". */
export function owners(): string {
  return `${current}'s`;
}

/** At the start of a sentence: "Alex", or "The owner". */
export function Owner(): string {
  return current.charAt(0).toUpperCase() + current.slice(1);
}

/** Possessive at the start of a sentence: "Alex's", or "The owner's". */
export function Owners(): string {
  return `${Owner()}'s`;
}
