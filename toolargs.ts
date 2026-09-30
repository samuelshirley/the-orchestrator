// Boolean parameters for agent tools. A bb thread keeps the tool schemas it
// started with, so a boolean added by a later land is unknown to it and the
// model sends `true` as the string "true", which z.boolean() refuses. flag()
// also takes exactly "true" / "false"; anything else is still refused. Fresh
// threads still see a plain boolean in the JSON Schema. text() is the same for
// free text a stale thread may send as a list.
import { z } from "zod";

export function flag() {
  return z.preprocess((value) => (value === "true" ? true : value === "false" ? false : value), z.boolean());
}

/**
 * Free text, for an optional param: a string, or an array of strings (joined
 * with newlines). null and "" are absent; anything else is refused. Fresh
 * threads see a plain string in the JSON Schema.
 */
export function text(max = 4000) {
  return z.preprocess(
    (value) => {
      const joined = Array.isArray(value) && value.every((item) => typeof item === "string") ? value.join("\n") : value;
      return joined === null || (typeof joined === "string" && joined.trim() === "") ? undefined : joined;
    },
    z.string().max(max).optional(),
  );
}
