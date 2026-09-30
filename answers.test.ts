import { describe, expect, it } from "vitest";
import { answersFor, withAnswer, type AnswerDraft } from "./answers";

describe("answer draft", () => {
  it("keeps answer 1 and takes answers 2 and 3 when the ticket grows from 1 to 3 questions", () => {
    let draft: AnswerDraft = withAnswer({}, "Q1?", "my own answer");
    expect(answersFor(["Q1?"], draft)).toEqual(["my own answer"]);
    const grown = ["Q1?", "Q2?", "Q3?"];
    expect(answersFor(grown, draft)).toEqual(["my own answer", "", ""]);
    draft = withAnswer(draft, "Q2?", "second");
    draft = withAnswer(draft, "Q3?", "third");
    expect(answersFor(grown, draft)).toEqual(["my own answer", "second", "third"]);
  });

  it("returns exactly one answer per current question", () => {
    const draft = withAnswer(withAnswer({}, "A?", "a"), "Gone?", "old");
    expect(answersFor(["A?", "B?"], draft)).toEqual(["a", ""]);
    expect(answersFor([], draft)).toEqual([]);
  });

  it("does not give a replaced question the old one's answer", () => {
    const draft = withAnswer({}, "Old?", "yes");
    expect(answersFor(["New?"], draft)).toEqual([""]);
  });

  it("ignores inherited object keys", () => {
    expect(answersFor(["toString", "constructor"], {})).toEqual(["", ""]);
  });

  it("overwrites an answer and never mutates its input", () => {
    const before = withAnswer({}, "Q?", "first");
    const after = withAnswer(before, "Q?", "second");
    expect(before).toEqual({ "Q?": "first" });
    expect(after).not.toBe(before);
    expect(answersFor(["Q?"], after)).toEqual(["second"]);
  });
});
