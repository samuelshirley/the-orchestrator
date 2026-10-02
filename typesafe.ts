// Where TypeSafe's hosted Jev is, and the key for it. Jev steers one thing:
// the model of task, research and build agents (modelroute.ts).
//
// The key is JEV_API_KEY in ~/.config/the-orchestrator/jev.env, next to the
// local config and outside every repo. Only host.ts reads the file; a file
// that group or others can read is refused (no key). The key never leaves
// the host except in the Authorization header to TYPESAFE_BASE_URL: it is
// never logged, never in an error, never sent to the board or the dossier.
//
// Pure: host.ts reads the file and its mode, this reads the text.

/** A constant, not configurable: the key is only ever sent here. */
export const TYPESAFE_BASE_URL = "https://api.typesafe.ai";
/** An alias; the answer's `model` names the version that answered, and that is what is stored. */
export const TYPESAFE_MODEL = "jev-latest";
export const JEV_KEY_NAME = "JEV_API_KEY";
/** Under the home folder, beside the local config (localconfig.ts LOCAL_CONFIG_PATH). */
export const JEV_KEY_PATH = [".config", "the-orchestrator", "jev.env"] as const;
export const JEV_KEY_DISPLAY = `~/${JEV_KEY_PATH.join("/")}`;
/** The host re-reads the file at most this often, so a new key is picked up without a reload. */
export const KEY_REREAD_MS = 60_000;
/** Longer than any .env line we want; a bigger file is not read past this. */
export const KEY_FILE_MAX_CHARS = 64_000;

export interface TypesafeConfig {
  baseUrl: string;
  key: string;
  model: string;
}

/**
 * TypeSafe's config from the text of jev.env: a line `JEV_API_KEY=...`, with
 * optional `export` and matching quotes; the last such line wins, as in a
 * shell. Null (no call) when the file or the line is missing, or the key is
 * empty, has whitespace or anything but printable ASCII (it goes into a header).
 */
export function typesafeConfig(envText: string | null): TypesafeConfig | null {
  if (envText === null) return null;
  let key: string | null = null;
  for (const line of envText.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?JEV_API_KEY\s*=(.*)$/.exec(line);
    if (match === null) continue;
    let value = match[1].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) value = value.slice(1, -1);
    key = value;
  }
  if (key === null || !/^[\x21-\x7e]{1,512}$/.test(key)) return null;
  return { baseUrl: TYPESAFE_BASE_URL, key, model: TYPESAFE_MODEL };
}

/** Why there is no key: no file or no valid line, or a file others can read. */
export type KeyProblem = "missing" | "open";
export type KeyState = { ok: true; config: TypesafeConfig } | { ok: false; problem: KeyProblem };

/**
 * The key from the file as the host found it: null when it is not there.
 * A file whose mode lets group or others in (mode & 0o077) is refused, key or not.
 */
export function keyFromFile(file: { text: string; mode: number } | null): KeyState {
  if (file === null) return { ok: false, problem: "missing" };
  if ((file.mode & 0o077) !== 0) return { ok: false, problem: "open" };
  const config = typesafeConfig(file.text);
  return config === null ? { ok: false, problem: "missing" } : { ok: true, config };
}

/** The board's words for a key problem. */
export function keyProblemText(problem: KeyProblem): string {
  return problem === "open"
    ? `${JEV_KEY_DISPLAY} is readable by others: chmod 600 it.`
    : `No ${JEV_KEY_NAME} in ${JEV_KEY_DISPLAY}.`;
}

/** Whether the host's cached reading is due a re-read. */
export function keyStale(now: number, readAt: number | null): boolean {
  return readAt === null || now - readAt >= KEY_REREAD_MS;
}
