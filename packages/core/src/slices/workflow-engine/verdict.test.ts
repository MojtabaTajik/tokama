import { describe, expect, it } from "vitest";
import { HEADLINE_RULE, MUST_RULE, REVIEWER_HEADLINE_RULE } from "./headline.js";
import { parseVerdict, VERDICT_RULE } from "./verdict.js";

describe("parseVerdict", () => {
  it("reads the verdict from the last non-empty line", () => {
    expect(parseVerdict("Looks fine.\n\nVERDICT: approve\n")).toBe("approve");
    expect(parseVerdict("Fix a.ts.\r\nVERDICT: changes\r\n\r\n")).toBe("changes");
  });

  it("reads the verdict when the headline block is above it, as the rules ask", () => {
    expect(parseVerdict("Notes.\nHEADLINE: Needs work.\nPOINT: the fade\nVERDICT: changes")).toBe("changes");
  });

  it("reads the verdict when a reviewer wrote the headline block below it", () => {
    expect(parseVerdict("Notes.\nVERDICT: approve\nHEADLINE: Ready.\nPOINT: one thing\nREAD: yes")).toBe("approve");
  });

  it("reads the verdict above a block written in the forms the headline reader accepts: bold, any case, list marks", () => {
    expect(parseVerdict("ok\nVERDICT: approve\n**HEADLINE:** Fine.\n**POINT:** x\n- Read: yes")).toBe("approve");
    expect(parseVerdict("ok\nVERDICT: changes\nHeadline: Fix a.ts.\n> point: one")).toBe("changes");
  });

  it("reads the verdict above or below MUST lines, with approve or changes", () => {
    expect(parseVerdict("Notes.\nHEADLINE: Needs work.\nMUST: a.ts:3 | leak\nVERDICT: changes")).toBe("changes");
    expect(parseVerdict("VERDICT: changes\nMUST: a | b")).toBe("changes");
    expect(parseVerdict("Notes.\nVERDICT: approve\nMUST: a | b")).toBe("approve");
    expect(parseVerdict("VERDICT: changes\nHEADLINE: Needs work.\n- **Must**: a.ts | b\n> must: c | d")).toBe("changes");
  });

  it("is no verdict when prose, not a MUST line, follows it", () => {
    expect(parseVerdict("VERDICT: changes\nMUST: a | b\n- Risk: the cache")).toBeUndefined();
    expect(parseVerdict("VERDICT: changes\nThe musty smell.\nMUST: a | b")).toBeUndefined();
    expect(parseVerdict("MUST: a | b")).toBeUndefined();
  });

  it("is no verdict when other text follows it, or the reply holds only a block", () => {
    expect(parseVerdict("VERDICT: approve\nOne more thing.")).toBeUndefined();
    expect(parseVerdict("VERDICT: approve\nHeadlines are fine.")).toBeUndefined();
    // A READ line that is not the yes/no flag is free text, as the headline reader also takes it.
    expect(parseVerdict("VERDICT: approve\nRead: the notes")).toBeUndefined();
    expect(parseVerdict("Must fix.\nVERDICT: approve\n- Read: the diff above again")).toBeUndefined();
    expect(parseVerdict("VERDICT: approve\n- Read: yes")).toBe("approve");
    expect(parseVerdict("HEADLINE: Ready.\nPOINT: x")).toBeUndefined();
    expect(parseVerdict("")).toBeUndefined();
  });

  it("the rules put the headline block above the verdict line, which stays last", () => {
    const prompt = REVIEWER_HEADLINE_RULE + VERDICT_RULE;
    expect(prompt.indexOf("HEADLINE:")).toBeLessThan(prompt.indexOf("VERDICT: approve"));
    expect(prompt).toContain("This block goes above the VERDICT line.");
    expect(prompt.trimEnd().endsWith("above that line.")).toBe(true);
    expect(HEADLINE_RULE).not.toContain("VERDICT");
  });

  it("the MUST lines are asked for above the verdict line, which stays last", () => {
    const prompt = REVIEWER_HEADLINE_RULE + MUST_RULE + VERDICT_RULE;
    expect(prompt.indexOf("MUST:")).toBeLessThan(prompt.indexOf("VERDICT: approve"));
    expect(prompt.trimEnd().endsWith("above that line.")).toBe(true);
  });
});
