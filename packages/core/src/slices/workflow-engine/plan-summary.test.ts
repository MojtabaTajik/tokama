import { describe, expect, it } from "vitest";
import { PlanSummarySchema, SaidSchema } from "../../kernel/schemas/index.js";
import { parseHeadline, summarizeOutput } from "./summary.js";

const EXAMPLE = [
  "The plan, in prose.",
  "",
  "HEADLINE: Fetch the weather from Open-Meteo and draw it on the sky.",
  "CHOICE: Weather source | Open-Meteo, no API key | the page calls api.open-meteo.com itself",
  "CHOICE: Day or night | the local clock, day is 6:00 to 18:00 | not the real sunrise and sunset",
  "REACH: files | src/main.js, src/weather.js (new), test/weather.test.js (new)",
  "REACH: deps | none",
  "REACH: services | api.open-meteo.com | called by the page when it runs",
  "REACH: secrets | none | the service needs no key",
  "RISK: Each visitor's browser sends its IP address to Open-Meteo.",
].join("\n");
const EMPTY = { choices: [], moreChoices: 0, reach: [], risks: [], moreRisks: 0 };
const plan = (text: string) => parseHeadline(text)!.plan;

describe("parseHeadline: the plan lines", () => {
  it("reads the design example", () => {
    const parsed = parseHeadline(EXAMPLE)!;
    expect(parsed.headline).toBe("Fetch the weather from Open-Meteo and draw it on the sky.");
    expect(parsed.plan).toEqual({
      choices: [
        { open: "Weather source", picked: "Open-Meteo, no API key", means: "the page calls api.open-meteo.com itself" },
        { open: "Day or night", picked: "the local clock, day is 6:00 to 18:00", means: "not the real sunrise and sunset" },
      ],
      moreChoices: 0,
      reach: [
        { kind: "files", value: "src/main.js, src/weather.js (new), test/weather.test.js (new)" },
        { kind: "deps", none: true },
        { kind: "services", value: "api.open-meteo.com", note: "called by the page when it runs" },
        { kind: "secrets", none: true, note: "the service needs no key" },
      ],
      risks: ["Each visitor's browser sends its IP address to Open-Meteo."],
      moreRisks: 0,
    });
    expect(PlanSummarySchema.safeParse(parsed.plan).success).toBe(true);
    expect(parsed.bodyBytes).toBe("The plan, in prose.".length);
  });

  it("reads the lines before the headline too, and leaves them out of the reply's size", () => {
    const text = ["Prose.", "CHOICE: Port | 8080", "RISK: It binds a port.", "HEADLINE: Serve it.", "POINT: x"].join("\n");
    const parsed = parseHeadline(text)!;
    expect(parsed).toMatchObject({ source: "headline", headline: "Serve it.", points: ["x"], bodyBytes: "Prose.".length, words: 1 });
    expect(parsed.plan).toMatchObject({ choices: [{ open: "Port", picked: "8080" }], risks: ["It binds a port."] });
  });

  it("reads any letter case, list marks, quote marks and bold marks", () => {
    const text = ["HEADLINE: A.", "- **choice**: Port | 8080", "> Reach: Files | a.ts", "* __RISK__: slow"].join("\n");
    expect(plan(text)).toMatchObject({ choices: [{ open: "Port", picked: "8080" }], reach: [{ kind: "files", value: "a.ts" }], risks: ["slow"] });
  });

  it("takes a line without | whole as the answer, and joins parts past the third into the last", () => {
    expect(plan("HEADLINE: A.\nCHOICE: Use SQLite for the cache").choices).toEqual([{ picked: "Use SQLite for the cache" }]);
    expect(plan("HEADLINE: A.\nCHOICE: Cache | SQLite | fast | maybe").choices).toEqual([{ open: "Cache", picked: "SQLite", means: "fast | maybe" }]);
  });

  it("reads a table row, and drops a choice with no answer", () => {
    expect(plan("HEADLINE: A.\nCHOICE: | Cache | SQLite | fast |").choices).toEqual([{ open: "Cache", picked: "SQLite", means: "fast" }]);
    expect(plan("HEADLINE: A.\nCHOICE: Cache | | fast").choices).toEqual([]);
    expect(plan("HEADLINE: A.\nCHOICE:").choices).toEqual([]);
  });

  it("cuts each part to 160 characters", () => {
    const long = "x".repeat(300);
    const read = plan(`HEADLINE: A.\nCHOICE: ${long} | ${long} | ${long}\nRISK: ${long}\nREACH: files | ${long}`);
    expect(read.choices[0]!.open).toHaveLength(160);
    expect(read.choices[0]!.picked).toHaveLength(160);
    expect(read.choices[0]!.means).toHaveLength(160);
    expect(read.risks[0]).toHaveLength(160);
    expect(read.reach[0]!.value).toHaveLength(160);
    expect(PlanSummarySchema.safeParse(read).success).toBe(true);
  });

  it("keeps 7 choices and 3 risks and counts the rest", () => {
    const lines = [...Array.from({ length: 9 }, (_, i) => `CHOICE: Q${i} | A${i}`), ...Array.from({ length: 5 }, (_, i) => `RISK: r${i}`)];
    const read = plan(["HEADLINE: A.", ...lines].join("\n"));
    expect(read.choices).toHaveLength(7);
    expect(read.choices[6]).toEqual({ open: "Q6", picked: "A6" });
    expect(read).toMatchObject({ moreChoices: 2, moreRisks: 2, risks: ["r0", "r1", "r2"] });
  });

  it("reads reach kind aliases and the first line of a kind, and ignores an unknown kind", () => {
    const text = ["HEADLINE: A.", "REACH: File | a.ts", "REACH: files | b.ts", "REACH: new dependencies | left-pad", "REACH: Outside services | api.example", "REACH: keys | API_KEY", "REACH: network | everything"].join("\n");
    expect(plan(text).reach).toEqual([
      { kind: "files", value: "a.ts" },
      { kind: "deps", value: "left-pad" },
      { kind: "services", value: "api.example" },
      { kind: "secrets", value: "API_KEY" },
    ]);
  });

  it.each(["none", "None", "no", "-", "n/a", "–"])("reads %s as none", (value) => {
    expect(plan(`HEADLINE: A.\nREACH: deps | ${value}`).reach).toEqual([{ kind: "deps", none: true }]);
  });

  it("leaves a reach line with no value out, so it reads as not said", () => {
    expect(plan("HEADLINE: A.\nREACH: deps").reach).toEqual([]);
    expect(plan("HEADLINE: A.\nREACH: deps |").reach).toEqual([]);
  });

  it("takes Unsure: on the first or second part as a flag and removes it", () => {
    expect(plan("HEADLINE: A.\nCHOICE: Cache | Unsure: SQLite | maybe").choices).toEqual([{ open: "Cache", picked: "SQLite", means: "maybe", unsure: true }]);
    expect(plan("HEADLINE: A.\nCHOICE: Unsure: Cache | SQLite").choices).toEqual([{ open: "Cache", picked: "SQLite", unsure: true }]);
    expect(plan("HEADLINE: A.\nCHOICE: unsure: SQLite").choices).toEqual([{ picked: "SQLite", unsure: true }]);
    expect(plan("HEADLINE: A.\nCHOICE: Cache | SQLite | Unsure: why").choices).toEqual([{ open: "Cache", picked: "SQLite", means: "Unsure: why" }]);
  });

  it("does not read a plan label inside the body, and keeps it in the first lines", () => {
    const body = ["The risks:", "- Risk: the cache can go stale", "- Choice: SQLite", "", "More prose."].join("\n");
    const parsed = parseHeadline(`${body}\nHEADLINE: A plan.\nCHOICE: Cache | SQLite`)!;
    expect(parsed.plan.risks).toEqual([]);
    expect(parsed.plan.choices).toEqual([{ open: "Cache", picked: "SQLite" }]);
    expect(parsed.bodyBytes).toBe(body.length);
    expect(summarizeOutput("- Risk: the cache can go stale\nHEADLINE: A plan.", false)).toMatchObject({ lines: ["- Risk: the cache can go stale"] });
  });

  it("steps over code fence lines around the block", () => {
    for (const [open, close] of [["```", "```"], ["```text", "```"], ["~~~", "~~~"]]) {
      const text = ["The plan.", open, "HEADLINE: A.", "CHOICE: Cache | SQLite", "REACH: deps | none", "RISK: slow", close].join("\n");
      expect(parseHeadline(text)!.plan, open).toMatchObject({ choices: [{ open: "Cache", picked: "SQLite" }], reach: [{ kind: "deps", none: true }], risks: ["slow"] });
    }
    // A fence in the middle of the run does not cut it either.
    expect(plan("HEADLINE: A.\nCHOICE: a | b\n```\nRISK: r\n```").risks).toEqual(["r"]);
  });

  it("reads a reply that ends in prose as having no plan lines", () => {
    expect(plan("Text.\nHEADLINE: A.\nCHOICE: Cache | SQLite\nThat is all.")).toEqual(EMPTY);
  });

  it("gives an empty plan for a reply without the lines, and never throws on junk", () => {
    expect(plan("Text.\nHEADLINE: A.")).toEqual(EMPTY);
    for (const junk of ["CHOICE:", "REACH: |||", "RISK: \u0000​", "|||\nCHOICE: |||", `${"CHOICE: a | b\n".repeat(5_000)}HEADLINE: x`]) {
      expect(() => parseHeadline(`Text.\n${junk}`), junk).not.toThrow();
    }
  });

  it("reads a 20,000-word reply by its end", () => {
    const text = `${Array.from({ length: 20_000 }, (_, i) => `w${i}`).join(" ")}\n${EXAMPLE}`;
    expect(parseHeadline(text)!.plan.choices).toHaveLength(2);
  });

  it("leaves the verdict reader as it was on a reply with Risk: and Choice: lines", () => {
    const text = ["- Risk: slow", "Choice: x", "**Must change**", "1. `a.ts:3` add the test.", "VERDICT: changes"].join("\n");
    expect(summarizeOutput(text, true)).toMatchObject({ kind: "verdict", verdict: "changes", mustFix: [{ ref: "a.ts:3", text: "add the test" }] });
  });

  it("keeps a plan record inside the stored shape", () => {
    const said = { source: "headline", headline: "x", points: [], morePoints: 0, bodyBytes: 0, plan: parseHeadline(EXAMPLE)!.plan };
    expect(SaidSchema.safeParse(said).success).toBe(true);
    expect(SaidSchema.safeParse({ ...said, plan: { ...said.plan, extra: 1 } }).success).toBe(false);
    expect(SaidSchema.safeParse({ ...said, plan: undefined }).success).toBe(true);
  });
});
