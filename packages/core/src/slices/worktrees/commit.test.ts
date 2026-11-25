import { describe, expect, it } from "vitest";
import type { ItemId } from "../../kernel/schemas/index.js";
import { commitMessage } from "./commit.js";

const ID = "item_019a1b2c-3d4e-7f00-8a9b-00000b9f12ab" as ItemId;
const trailer = `Tokama-Item: ${ID}\n`;
const subjectOf = (message: string) => message.split("\n")[0]!;

describe("commitMessage", () => {
  it("builds the subject, the request and the trailer, each its own paragraph", () => {
    expect(commitMessage(ID, "Fix the total", "Fix the total.\nIt drops shipping.")).toBe(`tokama: Fix the total\n\nFix the total.\nIt drops shipping.\n\n${trailer}`);
  });

  it("keeps the subject within 72 characters, prefix included, with an ellipsis when cut", () => {
    const subject = subjectOf(commitMessage(ID, "x".repeat(300), "x".repeat(300)));
    expect(subject).toHaveLength(72);
    expect(subject).toBe(`tokama: ${"x".repeat(63)}…`);
    expect(subjectOf(commitMessage(ID, "x".repeat(64), "y"))).toBe(`tokama: ${"x".repeat(64)}`);
    expect(subjectOf(commitMessage(ID, "x".repeat(65), "y"))).toBe(`tokama: ${"x".repeat(63)}…`);
  });

  it("keeps a long request whole, long lines too", () => {
    const text = `${"word ".repeat(400)}\n${"y".repeat(500)}`;
    expect(commitMessage(ID, "Long", text)).toBe(`tokama: Long\n\n${text}\n\n${trailer}`);
  });

  it("folds whitespace and control characters in the subject onto one line", () => {
    expect(subjectOf(commitMessage(ID, "  Fix\tthe\r\n\u0000total \u001b[31m ", "x"))).toBe("tokama: Fix the total [31m");
  });

  it("falls back to the item id for a blank title, and leaves out a blank request", () => {
    expect(commitMessage(ID, " \n\t ", "")).toBe(`tokama: ${ID}\n\n${trailer}`);
    expect(commitMessage(ID, "", "  \n \n")).toBe(`tokama: ${ID}\n\n${trailer}`);
  });

  it("cuts on a character boundary: never inside a surrogate pair or a combining sequence", () => {
    // 62 letters leave room for one more UTF-16 unit before the ellipsis.
    const pair = commitMessage(ID, `${"a".repeat(62)}\u{1F600}\u{1F600}\u{1F600}`, "x");
    expect(subjectOf(pair)).toBe(`tokama: ${"a".repeat(62)}…`);
    // The cut falls between the base letter and its accent: the whole cluster goes.
    const combining = commitMessage(ID, `${"a".repeat(62)}e\u0301${"b".repeat(20)}`, "x");
    expect(subjectOf(combining)).toBe(`tokama: ${"a".repeat(62)}…`);
    // A cluster that fits stays whole.
    const fits = commitMessage(ID, `${"a".repeat(60)}e\u0301${"b".repeat(20)}`, "x");
    expect(subjectOf(fits)).toBe(`tokama: ${"a".repeat(60)}e\u0301b…`);
    // A family emoji (several code points joined) is one character.
    const family = commitMessage(ID, `${"a".repeat(60)}\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}${"b".repeat(20)}`, "x");
    expect(subjectOf(family)).toBe(`tokama: ${"a".repeat(60)}…`);
    for (const message of [pair, combining, fits, family]) expect(subjectOf(message)).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u);
  });

  it("removes control characters from the request and keeps its lines", () => {
    expect(commitMessage(ID, "T", "a\r\nb\rc\u0000d\u001be\tf\n\n\ng")).toBe(`tokama: T\n\na\nb\ncde f\n\n\ng\n\n${trailer}`);
  });

  it("keeps Markdown in the request as it is", () => {
    expect(commitMessage(ID, "T", "# Heading\n**bold** `code`")).toContain("\n\n# Heading\n**bold** `code`\n\n");
  });

  it("puts a space before a request line that starts with a patch separator", () => {
    expect(commitMessage(ID, "T", "a\n---\nTokama-Item: x\n--- b")).toBe(`tokama: T\n\na\n ---\nTokama-Item: x\n --- b\n\n${trailer}`);
  });

  it("ends with its own trailer paragraph when the request looks like trailers", () => {
    const message = commitMessage(ID, "T", "Signed-off-by: x\nTokama-Item: item_forged\n\n\n");
    expect(message.endsWith(`\n\n${trailer}`)).toBe(true);
    expect(message.match(/^Tokama-Item: /gm)).toHaveLength(2);
    expect(message.trimEnd().split("\n\n").at(-1)).toBe(trailer.trimEnd());
  });
});
