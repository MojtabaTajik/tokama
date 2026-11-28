import { describe, expect, it } from "vitest";
import { FindingsSaidSchema, ReviewSaidSchema } from "../../kernel/schemas/index.js";
import { parseHeadline } from "./summary.js";

const REVIEW = [
  "The fetch works, but a slow reply leaks a timer.",
  "",
  "HEADLINE: The fetch works, but a slow reply leaks a timer and the fallback has no test.",
  "MUST: src/weather.js:41 | the 5 s timeout is never cleared, so every slow reply leaves a timer running",
  "MUST: test/weather.test.js | no test for the fall back to a clear sky when the request fails",
  "VERDICT: changes",
].join("\n");
const FINDINGS = [
  "Long write-up.",
  "",
  "HEADLINE: The nightly export drops refunded orders: a filter was added to ExportQuery.build on 12 March.",
  "POINT: Unsure: whether finance relied on the old numbers since then",
  "EVIDENCE: src/export/query.ts:88 | the filter status != refunded, added in commit 4f1c2aa",
  "EVIDENCE: export log, 25 Nov 02:00 | 1,204 rows written; the orders table has 1,251 for that day",
  "EVIDENCE: test/export/ | no test has a refunded order",
  "NEXT: Remove the filter and add a test with one refunded order.",
].join("\n");
const review = (text: string) => parseHeadline(text, false, "review")!.review;
const findings = (text: string) => parseHeadline(text, false, "findings")!.findings;

describe("parseHeadline: a step that was not asked for these lines", () => {
  it("reads its reply as it always did: the lines stay in the body and nothing is stored", () => {
    for (const reply of ["Body text.\nHEADLINE: Fixed x.\nPOINT: y\nNext: deploy to staging", "Body text.\nHEADLINE: Fixed x.\nMUST: a.ts | b\nVERDICT: changes", "Body text.\nHEADLINE: Fixed x.\nEVIDENCE: a | b"]) {
      const parsed = parseHeadline(reply)!;
      expect(parsed.review).toEqual({ mustFix: [], moreMustFix: 0 });
      expect(parsed.findings).toEqual({ evidence: [], moreEvidence: 0 });
      expect(parsed.bodyBytes, reply).toBeGreaterThan("Body text.".length);
    }
  });

  it("a reviewer's run steps over VERDICT, and the findings step's run does not", () => {
    expect(parseHeadline("HEADLINE: H.\nMUST: a | b\nVERDICT: changes", false, "review")!.review.mustFix).toHaveLength(1);
    expect(parseHeadline("HEADLINE: H.\nMUST: a | b\nVERDICT: changes", false, "findings")!.review.mustFix).toHaveLength(0);
    expect(parseHeadline("HEADLINE: H.\nEVIDENCE: a | b", false, "review")!.findings.evidence).toHaveLength(0);
    expect(parseHeadline("HEADLINE: H.\nMUST: a | b", false, "findings")!.review.mustFix).toHaveLength(0);
  });
});

describe("parseHeadline: MUST lines", () => {
  it("reads the examples, with the VERDICT line stepped over", () => {
    const parsed = parseHeadline(REVIEW, false, "review")!;
    expect(parsed).toMatchObject({ source: "headline", headline: "The fetch works, but a slow reply leaks a timer and the fallback has no test." });
    expect(parsed.review).toEqual({
      mustFix: [
        { where: "src/weather.js:41", what: "the 5 s timeout is never cleared, so every slow reply leaves a timer running" },
        { where: "test/weather.test.js", what: "no test for the fall back to a clear sky when the request fails" },
      ],
      moreMustFix: 0,
    });
    expect(ReviewSaidSchema.safeParse(parsed.review).success).toBe(true);
  });

  it("reads MUST lines written below the VERDICT line, and the headline below it too", () => {
    expect(review("Notes.\nHEADLINE: Needs work.\nVERDICT: changes\nMUST: a.ts:3 | leak").mustFix).toEqual([{ where: "a.ts:3", what: "leak" }]);
    expect(review("Notes.\nVERDICT: changes\nHEADLINE: Needs work.\nMUST: a.ts:3 | leak\nPOINT: x").mustFix).toEqual([{ where: "a.ts:3", what: "leak" }]);
  });

  it("does not read lines above an empty line, or a second VERDICT line", () => {
    expect(review("MUST: a | b\n\nHEADLINE: H.\nVERDICT: changes").mustFix).toEqual([]);
    expect(review("HEADLINE: H.\nMUST: a | b\nVERDICT: changes\nVERDICT: changes").mustFix).toEqual([]);
  });

  it("reads any letter case, list marks, quote marks and bold marks", () => {
    expect(review("HEADLINE: H.\n- **must**: a.ts | one\n> Must: b.ts | two\n* __MUST__: c.ts | three\nVERDICT: changes").mustFix.map((n) => n.where)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("takes a line without | as the what alone, and joins parts past the second into the what", () => {
    expect(review("HEADLINE: H.\nMUST: the timer leaks").mustFix).toEqual([{ what: "the timer leaks" }]);
    expect(review("HEADLINE: H.\nMUST: a.ts | a | b | c").mustFix).toEqual([{ where: "a.ts", what: "a | b | c" }]);
    expect(review("HEADLINE: H.\nMUST: | a.ts | leak |").mustFix).toEqual([{ where: "a.ts", what: "leak" }]);
  });

  it("cuts a part past 160 characters", () => {
    const [note] = review(`HEADLINE: H.\nMUST: ${"w".repeat(300)} | ${"x ".repeat(200)}`).mustFix;
    expect(note!.where!.length).toBeLessThanOrEqual(160);
    expect(note!.what.length).toBeLessThanOrEqual(160);
    expect(ReviewSaidSchema.safeParse(review(`HEADLINE: H.\nMUST: ${"w".repeat(300)} | ${"x ".repeat(200)}`)).success).toBe(true);
  });

  it("carries 5 lines and counts the rest", () => {
    const lines = Array.from({ length: 7 }, (_, i) => `MUST: f${i}.ts | n${i}`);
    const got = review(["HEADLINE: H.", ...lines, "VERDICT: changes"].join("\n"));
    expect(got.mustFix.map((n) => n.where)).toEqual(["f0.ts", "f1.ts", "f2.ts", "f3.ts", "f4.ts"]);
    expect(got.moreMustFix).toBe(2);
  });

  it("skips none, a dash and n/a, but keeps a finding that starts with No", () => {
    expect(review("HEADLINE: H.\nMUST: none\nMUST: -\nMUST: N/A.\nMUST: |\nVERDICT: approve")).toEqual({ mustFix: [], moreMustFix: 0 });
    expect(review("HEADLINE: H.\nMUST: a.ts | No timeout is cleared").mustFix).toEqual([{ where: "a.ts", what: "No timeout is cleared" }]);
  });

  it("does not read a MUST line that is prose in the reply", () => {
    expect(review("- Must: do it\nMore prose.\nHEADLINE: H.\nVERDICT: changes").mustFix).toEqual([]);
    // The run counts only from the headline to the end: prose between them ends it.
    expect(review("HEADLINE: H.\nSome prose.\nMUST: a | b\nVERDICT: changes").mustFix).toEqual([]);
    expect(review("MUST: a | b\nprose after.\nHEADLINE: H.\nVERDICT: changes").mustFix).toEqual([]);
  });

  it("does not read lines in a reply without the headline", () => {
    expect(review("Prose.\nMUST: a | b\nVERDICT: changes")).toEqual({ mustFix: [], moreMustFix: 0 });
  });

  it("reads the block through a code fence", () => {
    expect(review(["Notes.", "```", "HEADLINE: H.", "MUST: a.ts:1 | bad", "VERDICT: changes", "```"].join("\n")).mustFix).toEqual([{ where: "a.ts:1", what: "bad" }]);
  });

  it("keeps the lines out of the reply's size", () => {
    const parsed = parseHeadline("Prose here.\nHEADLINE: H.\nMUST: a.ts | b\nVERDICT: changes", false, "review")!;
    expect(parsed.bodyBytes).toBe("Prose here.\nVERDICT: changes".length);
  });
});

describe("parseHeadline: EVIDENCE and NEXT lines", () => {
  it("reads the example", () => {
    const parsed = parseHeadline(FINDINGS, false, "findings")!;
    expect(parsed.points).toEqual(["Unsure: whether finance relied on the old numbers since then"]);
    expect(parsed.findings).toEqual({
      evidence: [
        { where: "src/export/query.ts:88", what: "the filter status != refunded, added in commit 4f1c2aa" },
        { where: "export log, 25 Nov 02:00", what: "1,204 rows written; the orders table has 1,251 for that day" },
        { where: "test/export/", what: "no test has a refunded order" },
      ],
      moreEvidence: 0,
      next: "Remove the filter and add a test with one refunded order.",
    });
    expect(FindingsSaidSchema.safeParse(parsed.findings).success).toBe(true);
    expect(parsed.bodyBytes).toBe("Long write-up.".length);
  });

  it("has no next step when the agent wrote none, and the Ask example reads", () => {
    const got = findings("HEADLINE: About half a day.\nEVIDENCE: src/orders/query.ts:30 | the list query already returns a cursor\nEVIDENCE: src/orders/routes.ts | 4 routes, none writes a file yet");
    expect(got).toEqual({
      evidence: [
        { where: "src/orders/query.ts:30", what: "the list query already returns a cursor" },
        { where: "src/orders/routes.ts", what: "4 routes, none writes a file yet" },
      ],
      moreEvidence: 0,
    });
  });

  it("takes the first NEXT line that says something, and does not split it on |", () => {
    expect(findings("HEADLINE: H.\nNEXT: none\nNEXT:\nNEXT: Do a | then b\nNEXT: Other").next).toBe("Do a | then b");
    expect(findings("HEADLINE: H.\nNEXT: n/a").next).toBeUndefined();
  });

  it("carries 5 lines and counts the rest", () => {
    const lines = Array.from({ length: 8 }, (_, i) => `EVIDENCE: f${i} | n${i}`);
    const got = findings(["HEADLINE: H.", ...lines].join("\n"));
    expect(got.evidence).toHaveLength(5);
    expect(got.moreEvidence).toBe(3);
  });

  it("reads a line without | as what alone, and skips none", () => {
    expect(findings("HEADLINE: H.\nEVIDENCE: it streams\nEVIDENCE: none").evidence).toEqual([{ what: "it streams" }]);
  });

  it("does not read prose, and gives empty records for a reply with no lines", () => {
    expect(findings("- Evidence: it is in the log\nMore prose.\nHEADLINE: H.")).toEqual({ evidence: [], moreEvidence: 0 });
    expect(findings("Next: run it.\n\nmore prose")).toEqual({ evidence: [], moreEvidence: 0 });
  });

  it("reads plan lines next to the findings lines in the same block", () => {
    const got = parseHeadline("HEADLINE: H.\nCHOICE: a | b\nEVIDENCE: p | q\nNEXT: n", true, "findings")!;
    expect(got.plan.choices).toHaveLength(1);
    expect(got.findings.evidence).toHaveLength(1);
    expect(got.findings.next).toBe("n");
  });

  it("never throws on junk", () => {
    for (const text of ["", "\n\n", "MUST:", "EVIDENCE: |||", "HEADLINE: H.\nMUST: ||| |\nEVIDENCE:\nNEXT:", "\u0000HEADLINE: H.\nMUST: ‮ | \u0007"]) for (const asked of [undefined, "review", "findings"] as const) expect(() => parseHeadline(text, true, asked)).not.toThrow();
  });

  it("renders an HTML payload as the text it is", () => {
    const got = findings("HEADLINE: H.\nEVIDENCE: <img src=x onerror=alert(1)> | <b>bold</b>");
    expect(got.evidence).toEqual([{ where: "<img src=x onerror=alert(1)>", what: "<b>bold</b>" }]);
  });
});
