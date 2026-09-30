// New task: the owner's "+" next to Tasks starts a task in its own clean chat. The
// first message becomes the task; the thread hangs under the project's Patches
// chat like one start_task opens. Pure; newtask.test.ts pins it.

/** start_task's limits: a task from "+" must be one Patches could have started. */
export const TITLE_MIN = 3;
export const BRIEF_MIN = 10;
export const BRIEF_MAX = 20_000;
/** A shown title is shorter than start_task allows: it lives in a narrow list. */
export const TITLE_CAP = 80;
/** The model that summarises a New task's title: the cheapest. One constant, so a router can swap it. */
export const TITLE_MODEL = "claude-haiku-4-5";

export interface NewTaskProject {
  id: string;
  name: string;
  path: string | null;
  hostId: string | null;
}

export interface RegisteredChat {
  projectId: string;
  threadId: string;
}

/**
 * Why "+" is off, as its tooltip, or null when it may start a task. A project
 * with no Patches chat yet is not off: the server starts its chat first.
 */
export function newTaskBlock({ project }: { project: NewTaskProject | null }): string | null {
  if (project === null) return "Add a project first: a task works in one project";
  if (project.path === null || project.hostId === null) return `${project.name} has no local checkout`;
  return null;
}

/** The Patches chat a new task hangs under: its project's own, never another's. */
export function parentChatFor(projectId: string, chats: readonly RegisteredChat[]): string | null {
  return chats.find((chat) => chat.projectId === projectId)?.threadId ?? null;
}

const LEADING_NOISE = /^(?:(?:#{1,6}|[-*+>]|\d+[.)])(?:\s+|$))+/;
const SENTENCE_END = /[.?!]\s/;

/** Title and brief from the owner's first message; throws with what to fix. */
export function taskFromAsk(text: string): { title: string; brief: string } {
  const brief = text.trim();
  if (brief.length < BRIEF_MIN) throw new Error("Say a little more about what the task should do.");
  if (brief.length > BRIEF_MAX) throw new Error(`Too long: keep the first message under ${BRIEF_MAX} characters.`);
  return { title: titleFrom(brief), brief };
}

function titleFrom(brief: string): string {
  const line = brief
    .split("\n")
    .map((candidate) => candidate.trim().replace(LEADING_NOISE, "").trim())
    .find((candidate) => candidate !== "");
  let title = line ?? "";
  // The first sentence, without its full stop; a question keeps its mark.
  const end = SENTENCE_END.exec(title);
  const sentence = end === null ? null : title.slice(0, end.index + 1).replace(/\.$/, "");
  if (sentence !== null && sentence.length >= TITLE_MIN) title = sentence;
  if (title.length > TITLE_CAP) {
    const cut = title.slice(0, TITLE_CAP - 1);
    const space = cut.lastIndexOf(" ");
    title = `${(space >= TITLE_MIN ? cut.slice(0, space) : cut).trimEnd()}…`;
  }
  return title.length >= TITLE_MIN ? title : "New task";
}

/**
 * The one-shot ask for a summary title. titleFrom's first sentence is the
 * title until the reply lands; parseSummaryTitle decides if it may replace it.
 */
export function summaryTitlePrompt(brief: string): string {
  return [
    "Write a title for the task below, for a narrow task list.",
    "One line: a 3 to 8 word imperative or noun phrase that summarises the whole task,",
    'like "Fix task summary header" or "Test tickets open the preview first".',
    "No quotes, no trailing period, nothing else: reply with the title only.",
    "",
    "The task:",
    brief.trim(),
  ].join("\n");
}

/** The title in a model's reply, cleaned, or null when it is not one to show. */
export function parseSummaryTitle(reply: string): string | null {
  const line = reply
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== "");
  if (line === undefined) return null;
  let title = line.replace(/^#{1,6}\s*/, "");
  let before: string;
  do {
    before = title;
    title = title
      .replace(/^\*+|\*+$/g, "")
      .replace(/^title\s*:\s*/i, "")
      .replace(/^["'`\u201c\u2018]+|["'`\u201d\u2019]+$/g, "")
      .replace(/\.+$/, "")
      .trim();
  } while (title !== before);
  title = title.replace(/\s+/g, " ");
  if (title.length < TITLE_MIN || title.length > TITLE_CAP) return null;
  return title;
}

const TASK_NEW_FIELDS = [
  "projectId",
  "input",
  "providerId",
  "model",
  "reasoningLevel",
  "permissionMode",
  "serviceTier",
  "executionInputSources",
] as const;
type TaskNewField = (typeof TASK_NEW_FIELDS)[number];

/**
 * task_new's RPC input from a composer request. The host refuses an undefined
 * anywhere in RPC input ("is not a JSON value") before the schema sees it, so
 * unset picks are left out, nested ones too, as is anything else the composer adds.
 */
export function taskNewInput<R extends { projectId: string; input: readonly unknown[] }>(
  request: R,
): Pick<R, TaskNewField & keyof R> {
  const picked = Object.fromEntries(
    TASK_NEW_FIELDS.filter((field) => field in request).map((field) => [field, (request as Record<string, unknown>)[field]]),
  );
  return withoutUndefined(picked) as Pick<R, TaskNewField & keyof R>;
}

function withoutUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutUndefined) as T;
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, withoutUndefined(child)]),
  ) as T;
}
