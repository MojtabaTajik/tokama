import { describe, expect, it } from "vitest";
import { looksLikeQuestion } from "./question.js";

describe("looksLikeQuestion", () => {
  it.each([
    "how hard is it to add cars to street?",
    "Why does the nightly export skip refunds",
    "Can I run this offline?",
    "should we split the orders table",
    "What is the retry limit",
    "Does the export stream its rows",
    "Is the cache cleared on deploy",
    "Fix this？",
    "هل يعمل هذا؟",
    "  Which service owns the refunds table  ",
  ])("yes: %s", (text) => expect(looksLikeQuestion(text)).toBe(true));

  it.each([
    ["a request in question form", "Can you add CSV export?"],
    ["a polite request", "Please explain why the export is slow?"],
    ["could you", "Could you check the retry loop?"],
    ["would you", "Would you look at this?"],
    ["will you", "Will you update the docs?"],
    ["an instruction", "Add CSV export"],
    ["blank", "   "],
    ["can without I or we", "Can the export be faster"],
    ["a word that only starts like a question word", "Whatever the cause, fix the export"],
    ["a 40-line alert with a question mark", `${Array.from({ length: 40 }, (_, i) => `line ${i}: 502 from the gateway upstream`).join("\n")}\nwhy?`],
    ["401 characters", `${"a".repeat(400)}?`],
    ["two paragraphs", "Why is the export slow?\n\nIt takes a minute."],
  ])("no: %s", (_name, text) => expect(looksLikeQuestion(text)).toBe(false));

  it("accepts exactly 400 characters", () => {
    expect(looksLikeQuestion(`${"a".repeat(399)}?`)).toBe(true);
  });
});
