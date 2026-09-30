/**
 * The owner's typed answers on a Needs-you ticket, keyed by question text rather
 * than position: the task can add questions to its open ticket (or replace
 * them) while the form is mounted, and an index-based array sized on mount
 * then drops every write past its end. Questions are unique within a ticket
 * (`Store.addQuestions` skips duplicates), so the text is a safe key.
 */
export type AnswerDraft = Readonly<Record<string, string>>;

/** A new draft with `question` answered `value`; the input is left alone. */
export function withAnswer(draft: AnswerDraft, question: string, value: string): AnswerDraft {
  return { ...draft, [question]: value };
}

/** One answer per current question, in order, "" where the owner wrote nothing. */
export function answersFor(questions: readonly string[], draft: AnswerDraft): string[] {
  return questions.map((question) => (Object.hasOwn(draft, question) ? draft[question] : undefined) ?? "");
}
