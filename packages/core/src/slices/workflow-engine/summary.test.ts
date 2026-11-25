import { describe, expect, it } from "vitest";
import { OutputSummarySchema } from "../../kernel/schemas/index.js";
import { summarizeOutput } from "./summary.js";

// The shape a real reviewer wrote: a bold lead per item, a long paragraph after it, sections that
// are not must-fix with file:line items of their own, and the verdict last.
const REVIEW = [
  "**Needs changes.** The change follows the plan, but one visual bug needs fixing first. No check output was provided.",
  "",
  "**Must change**",
  "",
  '1. **`src/start-card.css:31`: the "Start" card changes layout while it fades out.** The rule `#start[hidden] { display: block; }` beats `#start { display: flex; }` at `src/start-card.css:44`, so the two lines jump onto one. Fix: drop `display: block`.',
  "",
  "**Checked and fine**",
  "- **Timing:** the fade still takes 250 ms (`src/start-card.css:12`).",
  "",
  "**Minor (optional)**",
  "- **`src/start-card.ts:40`:** the timer is not cleared when the card is removed.",
  "",
  "VERDICT: changes",
].join("\n");

describe("summarizeOutput", () => {
  it("reads the verdict and the Must change items of a real review, not the other sections", () => {
    expect(summarizeOutput(REVIEW, true)).toEqual({
      kind: "verdict",
      verdict: "changes",
      mustFix: [{ ref: "src/start-card.css:31", text: 'the "Start" card changes layout while it fades out' }],
      more: 0,
      lines: [],
    });
  });

  it("reads a plain Must change list with bare file:line items up to the next heading", () => {
    const text = ["Must change", "- index.html:31 the start card shifts while it fades: transform", "  and opacity run on different timings.", "", "Should change", "- No evidence for the manual checks.", "", "VERDICT: changes"].join("\n");
    expect(summarizeOutput(text, true)).toMatchObject({ kind: "verdict", mustFix: [{ ref: "index.html:31", text: "the start card shifts while it fades" }], more: 0 });
  });

  it("keeps the first 3 items in the agent's order and counts the rest", () => {
    const items = ["## Must fix", "1. `src/a.ts:1` one", "2. src/b.ts:2-4 — two", "3) three, with no file", "4. `src/d.ts:4` four", "5. five", "VERDICT: changes"];
    const summary = summarizeOutput(items.join("\r\n"), true);
    expect(summary).toEqual({
      kind: "verdict",
      verdict: "changes",
      mustFix: [{ ref: "src/a.ts:1", text: "one" }, { ref: "src/b.ts:2-4", text: "two" }, { text: "three, with no file" }],
      more: 2,
      lines: [],
    });
  });

  it("shows the first lines of a verdict without a must-fix list", () => {
    expect(summarizeOutput("Please add a test.\n\nVERDICT: changes", true)).toEqual({ kind: "verdict", verdict: "changes", mustFix: [], more: 0, lines: ["Please add a test."] });
  });

  it("shows the first 3 lines as written when a verdict step's output has no verdict", () => {
    const text = "Looks mostly fine. Two things:\n1) the fade timing in index.html feels off\n2) please attach a screenshot\n3) and one more";
    expect(summarizeOutput(text, true)).toEqual({
      kind: "lines",
      format: "no_verdict",
      lines: ["Looks mostly fine. Two things:", "1) the fade timing in index.html feels off", "2) please attach a screenshot"],
    });
  });

  it("shows the first 2 lines of a step without a verdict format, even one that writes VERDICT", () => {
    expect(summarizeOutput("Done. GET /orders now takes ?cursor=\nand returns { items, nextCursor }.\nMore.", false)).toEqual({
      kind: "lines",
      format: "none",
      lines: ["Done. GET /orders now takes ?cursor=", "and returns { items, nextCursor }."],
    });
    expect(summarizeOutput("Must change\n- a.ts:1 x\nVERDICT: changes", false)).toMatchObject({ kind: "lines", format: "none" });
  });

  it("says an empty or blank output is empty", () => {
    expect(summarizeOutput("", true)).toEqual({ kind: "empty" });
    expect(summarizeOutput(" \n\t\n", false)).toEqual({ kind: "empty" });
  });

  it("fits any output into the summary schema: long lines, many items, no trailing newline", () => {
    const long = "x".repeat(10_000);
    const many = ["**Must change**", ...Array.from({ length: 200 }, (_, i) => `- \`${"d/".repeat(150)}f${i}.ts:${i}\` ${long}`), "VERDICT: changes"].join("\n");
    const outputs = [long, many, `${long}\nVERDICT: changes`, "**Must change**\n- `a.ts:1`\n-  \nVERDICT: changes", "\u0000\u001b[31m\n**Must change**\n1. ****\nVERDICT: approve"];
    for (const text of outputs) {
      for (const verdictFormat of [true, false]) {
        const parsed = OutputSummarySchema.safeParse(summarizeOutput(text, verdictFormat));
        expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      }
    }
    expect(summarizeOutput(many, true)).toMatchObject({ kind: "verdict", more: 197 });
  });
});
