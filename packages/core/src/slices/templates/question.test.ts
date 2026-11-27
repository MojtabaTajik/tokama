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
    "What's the retry limit",
    "What’s the retry limit",
    "When does the nightly job run",
    "Where is the refund rule",
    "Do we keep the old export",
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
    ["a bug report that starts with when", "When I click Export the app crashes"],
    ["a bug report with a clause", "When the cache is cold, the export fails with a 502"],
    ["an order that starts with do", "Do not retry on 4xx in the payment client"],
    ["an order that starts with do and a noun", "Do a refactor of the payment client"],
    ["an order that starts with where", "Where the docs say v1, write v2"],
    ["a bug report that starts with does not", "Does not compile on Linux"],
    ["a bug report that starts with does not and has a comma", "Does not start after the update, logs show EACCES"],
    ["a bug report that starts with is", "Is broken on Linux since 0.4"],
    ["a bug report that starts with are", "Are failing in CI since yesterday"],
    ["a pasted alert field", "What: 502 from gateway\nWhere: orders-api\nWhen: 22:40"],
    ["401 characters", `${"a".repeat(400)}?`],
    ["two paragraphs", "Why is the export slow?\n\nIt takes a minute."],
  ])("no: %s", (_name, text) => expect(looksLikeQuestion(text)).toBe(false));

  it("accepts exactly 400 characters", () => {
    expect(looksLikeQuestion(`${"a".repeat(399)}?`)).toBe(true);
  });
});
