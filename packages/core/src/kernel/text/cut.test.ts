import { describe, expect, it } from "vitest";
import { cutText } from "./cut.js";

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u;

describe("cutText", () => {
  it("keeps text that fits, and cuts longer text to max units with the mark", () => {
    expect(cutText("abc", 3)).toBe("abc");
    expect(cutText("abcd", 3)).toBe("ab…");
    expect(cutText("abcd", 3)).toHaveLength(3);
    expect(cutText("", 0)).toBe("");
  });

  it("keeps only the mark when nothing else fits", () => {
    expect(cutText("abc", 1)).toBe("…");
    expect(cutText("abc", 0)).toBe("…");
  });

  it("never splits a surrogate pair", () => {
    // Room for 4 units: "ab" and one emoji (2 units) fit, the next emoji does not.
    expect(cutText("ab\u{1F600}\u{1F600}\u{1F600}", 5)).toBe("ab\u{1F600}…");
    // Room for 3 units: the emoji would need units 3 and 4, so it goes.
    expect(cutText("ab\u{1F600}\u{1F600}", 4)).toBe("ab…");
  });

  it("never splits a combining sequence", () => {
    // The cut falls between the base letter and its accent: the whole cluster goes.
    expect(cutText(`aaébbbb`, 4)).toBe("aa…");
    expect(cutText(`aaébbbb`, 5)).toBe(`aaé…`);
  });

  it("keeps a joined emoji whole or leaves it out", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}";
    expect(cutText(`a${family}b`, 5)).toBe("a…");
    expect(cutText(`a${family}bc`, family.length + 2)).toBe(`a${family}…`);
  });

  it("keeps the end with keep: tail", () => {
    expect(cutText("abcdef", 4, { keep: "tail" })).toBe("…def");
    expect(cutText("abc", 3, { keep: "tail" })).toBe("abc");
    expect(cutText("abc", 1, { keep: "tail" })).toBe("…");
    // The cut falls inside the emoji: it goes.
    expect(cutText("\u{1F600}\u{1F600}cd", 4, { keep: "tail" })).toBe("…cd");
    expect(cutText("ab\u{1F600}cd", 5, { keep: "tail" })).toBe("…\u{1F600}cd");
    // A combining accent stays with its letter.
    expect(cutText("abécd", 4, { keep: "tail" })).toBe("…cd");
    expect(cutText("abécd", 5, { keep: "tail" })).toBe("…écd");
  });

  it("never leaves a lone surrogate, at either end", () => {
    const text = "x\u{1F600}y\u{1F601}z\u{1F602}".repeat(7);
    for (let max = 1; max <= text.length; max++) {
      for (const keep of ["head", "tail"] as const) {
        const out = cutText(text, max, { keep });
        expect(out.length).toBeLessThanOrEqual(max);
        expect(out).not.toMatch(LONE_SURROGATE);
      }
    }
  });
});
