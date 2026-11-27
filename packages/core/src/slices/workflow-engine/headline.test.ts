import { describe, expect, it } from "vitest";
import { SaidSchema } from "../../kernel/schemas/index.js";
import { HEADLINE_RULE, NO_CHANGE_RULE, readMinutesOf, saidOf } from "./headline.js";
import { parseHeadline } from "./summary.js";

const words = (count: number) => Array.from({ length: count }, (_, i) => `w${i}`).join(" ");
const none = { approvesText: false, lastOfDocument: false };

describe("HEADLINE_RULE", () => {
  it("asks for the block with the caps of the schema", () => {
    expect(HEADLINE_RULE).toContain("HEADLINE: <one line, at most 140 characters");
    expect(HEADLINE_RULE).toContain("up to 3 such lines, each at most 160 characters");
    expect(HEADLINE_RULE).toContain("READ: yes");
  });
});

describe("NO_CHANGE_RULE", () => {
  it("asks for one line, only for an answer that changes nothing", () => {
    expect(NO_CHANGE_RULE).toContain("NO_CHANGE: yes");
    expect(NO_CHANGE_RULE).toContain("changed no files");
    expect(HEADLINE_RULE).not.toContain("NO_CHANGE");
  });
});

describe("saidOf: no change needed", () => {
  const reply = "The answer.\nHEADLINE: Half a day.\nNO_CHANGE: yes";
  it("records the line only when it was asked for", () => {
    expect(saidOf(parseHeadline(reply), { ...none, noChangeOffered: true })).toMatchObject({ headline: "Half a day.", noChange: true });
    expect(saidOf(parseHeadline(reply), none)).not.toHaveProperty("noChange");
    expect(saidOf(parseHeadline("Text.\nHEADLINE: Half a day."), { ...none, noChangeOffered: true })).not.toHaveProperty("noChange");
    expect(SaidSchema.safeParse(saidOf(parseHeadline(reply), { ...none, noChangeOffered: true })).success).toBe(true);
  });
});

describe("readMinutesOf", () => {
  it.each([
    [0, 1],
    [1, 1],
    [200, 1],
    [201, 2],
    [1_200, 6],
    [12_000, 60],
    [1_000_000, 60],
  ])("%i words read in %i min", (count, minutes) => {
    expect(readMinutesOf(count)).toBe(minutes);
  });
});

describe("saidOf", () => {
  it("is none for a reply that said nothing", () => {
    expect(saidOf(parseHeadline(""), none)).toBeUndefined();
  });

  it("has no read time for a small reply, with or without the agent's flag", () => {
    expect(saidOf(parseHeadline("Done.\nHEADLINE: Fixed it."), none)).toEqual({ source: "headline", headline: "Fixed it.", points: [], morePoints: 0, bodyBytes: 5 });
    expect(saidOf(parseHeadline(`${words(149)}\nHEADLINE: Fixed it.\nREAD: yes`), none)).not.toHaveProperty("readMinutes");
  });

  it("is a must-read when the agent flagged it and the reply has 150 words", () => {
    expect(saidOf(parseHeadline(`${words(150)}\nHEADLINE: A design.\nREAD: yes`), none)).toMatchObject({ readMinutes: 1 });
    expect(saidOf(parseHeadline(`${words(450)}\nHEADLINE: A design.\nREAD: yes`), none)).toMatchObject({ readMinutes: 3 });
    // The flag alone is not enough, and a long reply alone is not either.
    expect(saidOf(parseHeadline(`${words(450)}\nHEADLINE: A design.`), none)).not.toHaveProperty("readMinutes");
  });

  it("is a must-read when you approve text that changed nothing, or it is the document the template ends with", () => {
    expect(saidOf(parseHeadline(`${words(10)}\nHEADLINE: The plan.`), { approvesText: true, lastOfDocument: false })).toMatchObject({ readMinutes: 1 });
    expect(saidOf(parseHeadline(`${words(10)}\nHEADLINE: The findings.`), { approvesText: false, lastOfDocument: true })).toMatchObject({ readMinutes: 1 });
  });

  it("gives a record the schema accepts, also for first lines and the most the caps allow", () => {
    for (const reply of ["No block here.\nSecond.", `${words(20_000)}\nHEADLINE: ${"h".repeat(500)}\nPOINT: ${"p".repeat(500)}\nREAD: yes`]) {
      const said = saidOf(parseHeadline(reply), none);
      expect(SaidSchema.safeParse(said).success).toBe(true);
    }
    expect(saidOf(parseHeadline(`${words(20_000)}\nHEADLINE: x\nREAD: yes`), none)?.readMinutes).toBe(60);
  });
});
