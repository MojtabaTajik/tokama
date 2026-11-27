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

  it("is no verdict when other text follows it, or the block labels are not written as exact lines", () => {
    expect(parseVerdict("VERDICT: approve\nOne more thing.")).toBeUndefined();
    expect(parseVerdict("VERDICT: approve\n**HEADLINE:** Ready.")).toBeUndefined();
    expect(parseVerdict("VERDICT: approve\nHeadline: Ready.")).toBeUndefined();
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
