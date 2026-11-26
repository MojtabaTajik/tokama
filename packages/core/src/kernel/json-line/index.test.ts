import { describe, expect, it } from "vitest";
import { parseJsonLine } from "./index.js";

describe("parseJsonLine", () => {
  it("returns the value of a JSON line", () => {
    expect(parseJsonLine('{"a":1,"b":[true,null]}')).toEqual({ ok: true, value: { a: 1, b: [true, null] } });
    expect(parseJsonLine("3")).toEqual({ ok: true, value: 3 });
    expect(parseJsonLine("null")).toEqual({ ok: true, value: null });
  });

  it("returns an error for a line that is not JSON, and never throws", () => {
    for (const line of ["", "{", '{"a":1', "not json", "{'a':1}"]) {
      const parsed = parseJsonLine(line);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).not.toBe("");
    }
  });
});
