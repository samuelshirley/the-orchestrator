import { describe, expect, it } from "vitest";
import { z } from "zod";
import { flag, text } from "./toolargs";

describe("flag", () => {
  it("takes real booleans", () => {
    expect(flag().parse(true)).toBe(true);
    expect(flag().parse(false)).toBe(false);
  });

  it('takes exactly "true" and "false" from stale tool schemas', () => {
    expect(flag().parse("true")).toBe(true);
    expect(flag().parse("false")).toBe(false);
  });

  it("refuses anything else", () => {
    for (const bad of ["yes", "no", "1", "0", "", "TRUE", "False", " true", 1, 0, null, undefined, {}, []]) {
      expect(flag().safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("composes with optional and default as tool params use it", () => {
    const params = z.object({ a: flag().optional(), b: flag().default(false) });
    expect(params.parse({})).toEqual({ b: false });
    expect(params.parse({ a: "false", b: "true" })).toEqual({ a: false, b: true });
    expect(params.safeParse({ a: "yes" }).success).toBe(false);
  });

  it("keeps its description", () => {
    expect(flag().optional().describe("Also close the task.").description).toBe("Also close the task.");
  });

  it("publishes a plain boolean in the JSON Schema bb sends fresh threads", () => {
    const params = z.object({
      a: flag().optional().describe("Only claim."),
      b: flag().default(false).describe("Also close the task."),
    });
    // bb converts tool parameters with toJSONSchema({ io: "input" }).
    const schema = z.toJSONSchema(params, { io: "input" });
    expect(schema.properties).toEqual({
      a: { type: "boolean", description: "Only claim." },
      b: { type: "boolean", description: "Also close the task." },
    });
    // The preprocess hides .default(false) from the schema; the field stays optional.
    expect(schema.required).toBeUndefined();
    expect(z.toJSONSchema(params).properties).toMatchObject({ a: { type: "boolean" }, b: { type: "boolean" } });
  });
});

describe("text", () => {
  it("takes a string as it is", () => {
    expect(text().parse("wire server.ts; docs")).toBe("wire server.ts; docs");
  });

  it("joins an array of strings with newlines, as a stale thread may send a list", () => {
    expect(text().parse(["wire server.ts", "docs"])).toBe("wire server.ts\ndocs");
    expect(text().parse(["docs"])).toBe("docs");
  });

  it("reads null, undefined and empty as absent", () => {
    for (const absent of [null, undefined, "", "  ", "\n", [], [""]]) {
      const parsed = text().safeParse(absent);
      expect(parsed.success, JSON.stringify(absent)).toBe(true);
      expect(parsed.data, JSON.stringify(absent)).toBeUndefined();
    }
    expect(z.object({ more: text() }).parse({})).toEqual({});
    expect(z.object({ more: text() }).parse({ more: null })).toEqual({});
  });

  it("refuses anything else", () => {
    for (const bad of [1, 0, true, false, {}, { more: "x" }, ["a", 1], [["a"]], [null]]) {
      expect(text().safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("caps the length", () => {
    expect(text(10).safeParse("x".repeat(10)).success).toBe(true);
    expect(text(10).safeParse("x".repeat(11)).success).toBe(false);
    expect(text(10).safeParse(["xxxxx", "xxxxx"]).success).toBe(false);
  });

  it("publishes a plain optional string, with its description, in the JSON Schema bb sends fresh threads", () => {
    const params = z.object({ more: text().describe("What is left.") });
    expect(text().describe("What is left.").description).toBe("What is left.");
    const schema = z.toJSONSchema(params, { io: "input" });
    expect(schema.properties).toMatchObject({ more: { type: "string", description: "What is left." } });
    expect(schema.required).toBeUndefined();
  });
});
