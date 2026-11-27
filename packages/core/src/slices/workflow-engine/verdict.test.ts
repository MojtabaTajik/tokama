import { describe, expect, it } from "vitest";
import { HEADLINE_RULE, REVIEWER_HEADLINE_RULE } from "./headline.js";
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

  it("is no verdict when other text follows it, or the reply holds only a block", () => {
    expect(parseVerdict("VERDICT: approve\nOne more thing.")).toBeUndefined();
    expect(parseVerdict("VERDICT: approve\nHeadlines are fine.")).toBeUndefined();
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
});
