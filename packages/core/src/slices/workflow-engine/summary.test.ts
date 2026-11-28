import { describe, expect, it } from "vitest";
import { OutputSummarySchema, SaidSchema } from "../../kernel/schemas/index.js";
import { parseHeadline, parseHeadlineOfTail, summarizeOutput } from "./summary.js";

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

  it("an output that is only a verdict line still shows it, in the schema", () => {
    expect(summarizeOutput("VERDICT: APPROVE", true)).toEqual({ kind: "lines", format: "no_verdict", lines: ["VERDICT: APPROVE"] });
    expect(summarizeOutput("\nVERDICT: approve\n", false)).toEqual({ kind: "lines", format: "none", lines: ["VERDICT: approve"] });
    expect(summarizeOutput("VERDICT: changes", true)).toEqual({ kind: "verdict", verdict: "changes", mustFix: [], more: 0, lines: ["VERDICT: changes"] });
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

  it("a cut output: the verdict comes from its tail, the must-fix items from its head", () => {
    const head = "**Must change**\n1. `a.ts:3` add the missing test.\n\nSome notes that go on and on";
    const mustFix = [{ ref: "a.ts:3", text: "add the missing test" }];
    expect(summarizeOutput(head, true, "more notes\n\nVERDICT: changes\n")).toMatchObject({ kind: "verdict", verdict: "changes", mustFix });
    expect(summarizeOutput(head, true, "more notes\r\n\r\nVERDICT: approve\r\n")).toMatchObject({ kind: "verdict", verdict: "approve", mustFix });
    // Without the tail the same head holds no verdict; a tail that breaks the format is none.
    expect(summarizeOutput(head, true)).toMatchObject({ kind: "lines", format: "no_verdict" });
    expect(summarizeOutput(head, true, "VERDICT: changes\nOne more thing.")).toMatchObject({ kind: "lines", format: "no_verdict" });
  });

  it("keeps the headline block out of the first lines and ends the must-fix list at it", () => {
    const block = ["HEADLINE: Two things to fix.", "POINT: the fade timing", "READ: yes"];
    expect(summarizeOutput(["Work done.", "More.", ...block].join("\n"), false)).toMatchObject({ lines: ["Work done.", "More."] });
    const review = ["**Must change**", "1. `a.ts:3` add the test.", ...block, "- `b.ts:4` not a must-fix item", "VERDICT: changes"].join("\n");
    expect(summarizeOutput(review, true)).toMatchObject({ kind: "verdict", mustFix: [{ ref: "a.ts:3", text: "add the test" }] });
    // A reply of only the block still shows its first lines: it says nothing else.
    expect(summarizeOutput(block.join("\n"), false)).toEqual({ kind: "lines", format: "none", lines: ["HEADLINE: Two things to fix.", "POINT: the fade timing"] });
  });
});

describe("parseHeadline", () => {
  const words = (count: number) => Array.from({ length: count }, (_, i) => `word${i}`).join(" ");

  it("reads the block at the end of a reply: the headline, up to 3 points, and the read flag", () => {
    const text = ["I changed the cart totals.", "", "HEADLINE: Fixed the null check in cart totals.", "POINT: Not run against the staging data.", "POINT: Assumed prices are in cents.", "READ: yes"].join("\n");
    const parsed = parseHeadline(text);
    expect(parsed).toEqual({
      source: "headline",
      headline: "Fixed the null check in cart totals.",
      points: ["Not run against the staging data.", "Assumed prices are in cents."],
      morePoints: 0,
      bodyBytes: "I changed the cart totals.".length,
      words: 5,
      readFlag: true,
      noChange: false,
    });
  });

  it("counts bytes and words on the reply without the block", () => {
    const parsed = parseHeadline(`é ${words(3)}\nHEADLINE: Done.\nPOINT: x`);
    expect(parsed).toMatchObject({ source: "headline", words: 4, bodyBytes: new TextEncoder().encode(`é ${words(3)}`).length });
  });

  it("cuts a long headline to 140 and a long point to 160 with a mark, and keeps 3 points and counts the rest", () => {
    const parsed = parseHeadline(["HEADLINE: " + "h".repeat(300), ...["a", "b", "c", "d", "e"].map((p, i) => `POINT: ${i === 0 ? p.repeat(400) : p}`)].join("\n"))!;
    expect(parsed.headline).toBe(`${"h".repeat(139)}…`);
    expect(parsed.points).toEqual([`${"a".repeat(159)}…`, "b", "c"]);
    expect(parsed.morePoints).toBe(2);
  });

  it("fits the stored shape at the caps, also with characters that take 2 UTF-16 units", () => {
    const emoji = "🙂".repeat(200);
    const parsed = parseHeadline(`HEADLINE: ${emoji}\nPOINT: ${emoji}\nPOINT: ${emoji}\nPOINT: ${emoji}\nPOINT: ${emoji}`)!;
    expect(parsed.headline.length).toBeLessThanOrEqual(140);
    expect(parsed.points.every((point) => point.length <= 160)).toBe(true);
    expect(SaidSchema.safeParse({ source: parsed.source, headline: parsed.headline, points: parsed.points, morePoints: parsed.morePoints, bodyBytes: parsed.bodyBytes }).success).toBe(true);
  });

  it.each([
    ["any letter case", "headline: Fixed it.\npoint: One thing.", "Fixed it.", ["One thing."]],
    ["a list mark", "- HEADLINE: Fixed it.\n* POINT: One thing.", "Fixed it.", ["One thing."]],
    ["a quote mark", "> HEADLINE: Fixed it.\n> POINT: One thing.", "Fixed it.", ["One thing."]],
    ["bold around the label", "**HEADLINE:** Fixed it.\n**POINT**: One thing.", "Fixed it.", ["One thing."]],
    ["bold and code in the value", "HEADLINE: **Fixed** `it`.\nPOINT: ## One   thing.", "Fixed it.", ["One thing."]],
    ["control and invisible characters", "HEADLINE: Fi\u001b[31mxed‮ it.​\nPOINT: One\tthing.", "Fi [31mxed it.", ["One thing."]],
    ["a line separator in the value", "HEADLINE: Fixed it.\nPOINT: One thing.", "Fixed it.", ["One thing."]],
    ["Windows line ends", "HEADLINE: Fixed it.\r\nPOINT: One thing.\r\n", "Fixed it.", ["One thing."]],
  ])("reads a block written with %s", (_label, text, headline, points) => {
    expect(parseHeadline(text)).toMatchObject({ source: "headline", headline, points });
  });

  it("takes the last HEADLINE of the last 30 lines, and only the points after it", () => {
    const text = ["HEADLINE: first", "POINT: of the first", "HEADLINE: second", "POINT: of the second"].join("\n");
    expect(parseHeadline(text)).toMatchObject({ headline: "second", points: ["of the second"] });
    const old = ["HEADLINE: too far up", ...Array.from({ length: 30 }, (_, i) => `line ${i}`)].join("\n");
    expect(parseHeadline(old)).toMatchObject({ source: "first_lines", headline: "line 0" });
  });

  it("skips a VERDICT line before or after the block", () => {
    expect(parseHeadline("Notes.\nHEADLINE: Needs work.\nPOINT: the fade\nVERDICT: changes")).toMatchObject({ source: "headline", headline: "Needs work.", points: ["the fade"] });
    expect(parseHeadline("Notes.\nVERDICT: changes\nHEADLINE: Needs work.\nPOINT: the fade")).toMatchObject({ source: "headline", headline: "Needs work.", points: ["the fade"] });
  });

  it("falls back to the first lines when there is no block or the headline is empty; nothing throws", () => {
    const first = "Added GET /orders/export.\n\nIt streams CSV.\nIt takes ?from and ?to.\nMore.";
    expect(parseHeadline(first)).toMatchObject({ source: "first_lines", headline: "Added GET /orders/export.", points: ["It streams CSV.", "It takes ?from and ?to."], morePoints: 0, readFlag: false });
    expect(parseHeadline("Text.\nHEADLINE:   \nPOINT: orphan\nREAD: yes")).toMatchObject({ source: "first_lines", headline: "Text.", points: [], readFlag: false });
    expect(parseHeadline("## Plan\nVERDICT: approve")).toMatchObject({ source: "first_lines", headline: "Plan", points: [] });
    expect(parseHeadline("Read: the docs first.")).toMatchObject({ source: "first_lines", headline: "Read: the docs first." });
  });

  it("says nothing for an empty reply or one that holds only a verdict", () => {
    expect(parseHeadline("")).toBeUndefined();
    expect(parseHeadline(" \n\t\n")).toBeUndefined();
    expect(parseHeadline("VERDICT: approve")).toBeUndefined();
  });

  it("reads READ: no as no flag", () => {
    expect(parseHeadline("HEADLINE: Done.\nREAD: no")).toMatchObject({ readFlag: false });
  });

  describe("NO_CHANGE", () => {
    it("is a block line after the headline, only for the value yes in any letter case; it is not part of the reply", () => {
      expect(parseHeadline("The answer is no.\nHEADLINE: Done.\nPOINT: x\nNO_CHANGE: yes")).toMatchObject({ source: "headline", points: ["x"], noChange: true, bodyBytes: "The answer is no.".length, words: 4 });
      expect(parseHeadline("Text.\nHEADLINE: Done.\n- **No_Change:** YES")).toMatchObject({ noChange: true });
      for (const value of ["no", "maybe", "yes, but", ""]) expect(parseHeadline(`Text.\nHEADLINE: Done.\nNO_CHANGE: ${value}`), value).toMatchObject({ noChange: false });
    });

    it("counts only below the headline, and never without one", () => {
      expect(parseHeadline("Text.\nNO_CHANGE: yes\nHEADLINE: Done.")).toMatchObject({ source: "headline", noChange: false });
      expect(parseHeadline("Text.\nNO_CHANGE: yes")).toMatchObject({ source: "first_lines", headline: "Text.", noChange: false });
    });

    it("other values are text of the reply, so the line stays in the body and the first lines", () => {
      const parsed = parseHeadline("NO_CHANGE: maybe\nHEADLINE: Done.");
      expect(parsed).toMatchObject({ noChange: false, bodyBytes: "NO_CHANGE: maybe".length });
      expect(summarizeOutput("NO_CHANGE: maybe\nMore.", false)).toMatchObject({ lines: ["NO_CHANGE: maybe", "More."] });
    });

    it("stays out of the first lines, the must-fix list and the verdict", () => {
      expect(summarizeOutput("Work done.\nHEADLINE: Done.\nNO_CHANGE: yes", false)).toMatchObject({ lines: ["Work done."] });
      const review = ["**Must change**", "1. `a.ts:3` add the test.", "NO_CHANGE: yes", "- `b.ts:4` not a must-fix item", "VERDICT: changes"].join("\n");
      expect(summarizeOutput(review, true)).toMatchObject({ kind: "verdict", mustFix: [{ ref: "a.ts:3", text: "add the test" }] });
      expect(summarizeOutput("Fine.\nVERDICT: approve\nHEADLINE: ok\nNO_CHANGE: yes", true)).toMatchObject({ kind: "verdict", verdict: "approve" });
    });
  });
});

describe("parseHeadlineOfTail", () => {
  const tail = "end of the body\nHEADLINE: A long design.\nPOINT: One thing.\nREAD: yes";

  it("reads the block from the end; the body is the file less the block, with words at the tail's rate", () => {
    const own = parseHeadline(tail)!;
    const blockBytes = new TextEncoder().encode(tail).length - own.bodyBytes;
    const long = parseHeadlineOfTail(tail, 400_000)!;
    expect(long).toMatchObject({ source: "headline", headline: "A long design.", points: ["One thing."], readFlag: true });
    expect(long.bodyBytes).toBe(400_000 - blockBytes);
    expect(long.words).toBe(Math.round((own.words * long.bodyBytes) / own.bodyBytes));
  });

  it("gives nothing for a tail without a block: the first lines of a tail are not the start of the reply", () => {
    expect(parseHeadlineOfTail("middle of the reply\nmore of it", 400_000)).toBeUndefined();
    expect(parseHeadlineOfTail("", 400_000)).toBeUndefined();
  });
});
