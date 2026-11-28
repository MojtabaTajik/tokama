import { describe, expect, it } from "vitest";
import { SaidSchema } from "../../kernel/schemas/index.js";
import { HEADLINE_RULE, labelOf, NO_CHANGE_RULE, PLAN_RULE, planCoverage, planLabelOf, readMinutesOf, saidOf } from "./headline.js";
import { parseHeadline } from "./summary.js";

const words = (count: number) => Array.from({ length: count }, (_, i) => `w${i}`).join(" ");
const none = { approvesText: false, lastOfDocument: false };

// The literal texts the agents are told. They are pinned here, not read from the constants, so a
// change to what every agent step is asked fails a test.
describe("the rules as written", () => {
  it("HEADLINE_RULE", () => {
    expect(HEADLINE_RULE).toBe(`

End your reply with this block, exactly in this form:
HEADLINE: <one line, at most 140 characters: the most important thing you did or found>
POINT: <optional; up to 3 such lines, each at most 160 characters: what else the engineer must know, such as what is not done, what you assumed, what you are unsure about>
READ: yes   <only when the engineer must read your full reply to use this work: a design, findings, a plan with choices>`);
  });

  it("NO_CHANGE_RULE", () => {
    expect(NO_CHANGE_RULE).toBe("\nNO_CHANGE: yes   <only when nothing needs to be changed or built and your reply is the answer, and you changed no files; leave the line out otherwise>");
  });
});

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

describe("PLAN_RULE", () => {
  it("asks for the plan lines with the caps of the schema, and no Markdown", () => {
    expect(PLAN_RULE).toContain("CHOICE: <what was open> | <what you picked> | <what that means, optional>");
    expect(PLAN_RULE).toContain("up to 7 lines");
    expect(PLAN_RULE).toContain('start the second part with "Unsure: "');
    for (const kind of ["files", "deps", "services", "secrets"]) expect(PLAN_RULE).toContain(`REACH: ${kind} |`);
    expect(PLAN_RULE).toContain("up to 3 such lines");
    expect(PLAN_RULE).toContain("Each part at most 160 characters");
    expect(PLAN_RULE).not.toMatch(/[*`#]/);
    expect(HEADLINE_RULE).not.toContain("CHOICE");
  });
});

describe("planLabelOf", () => {
  it("reads the three labels in any case, after list, quote and bold marks", () => {
    expect(planLabelOf("CHOICE: a | b")).toEqual({ label: "CHOICE", value: "a | b" });
    expect(planLabelOf("- **reach**: files | a")).toEqual({ label: "REACH", value: "files | a" });
    expect(planLabelOf("> Risk: slow")).toEqual({ label: "RISK", value: "slow" });
  });

  it("does not read the block labels or prose", () => {
    for (const line of ["HEADLINE: x", "POINT: x", "The risk: x", "RISKS: x", "CHOICES: x", "Choice x"]) expect(planLabelOf(line), line).toBeUndefined();
    expect(labelOf("CHOICE: a")).toBeUndefined();
  });
});

describe("saidOf: the plan", () => {
  const reply = "Text.\nHEADLINE: Plan.\nCHOICE: Port | 8080\nRISK: slow";
  const said = (context: Partial<Parameters<typeof saidOf>[1]>) => saidOf(parseHeadline(reply, true), { ...none, ...context });

  it("carries the plan only when it was asked for and the step changed nothing", () => {
    expect(said({ planAsked: true, approvesText: true })).toMatchObject({ plan: { choices: [{ open: "Port", picked: "8080" }], risks: ["slow"] } });
    expect(said({ planAsked: true, approvesText: false })).not.toHaveProperty("plan");
    expect(said({ planAsked: false, approvesText: true })).not.toHaveProperty("plan");
    expect(said({})).not.toHaveProperty("plan");
  });

  it("carries an empty plan when the agent wrote none, in the stored shape", () => {
    const written = saidOf(parseHeadline("Text.\nHEADLINE: Plan.", true), { ...none, planAsked: true, approvesText: true });
    expect(written?.plan).toEqual({ choices: [], moreChoices: 0, reach: [], risks: [], moreRisks: 0 });
    expect(SaidSchema.safeParse(written).success).toBe(true);
  });

  it("does not turn a plan into a must-read by itself", () => {
    expect(said({ planAsked: true })).not.toHaveProperty("readMinutes");
  });
});

describe("planCoverage", () => {
  const ask = { ...none, planAsked: true, approvesText: true };
  const coverage = (reply: string) => {
    const parsed = parseHeadline(reply, true);
    return planCoverage(saidOf(parsed, ask), parsed?.planUnread);
  };

  it("tells a table or a sign-off line (labels not read) from a reply that left the lines out, and a no-change answer from both", () => {
    expect(coverage("HEADLINE: P.\nRISK: slow\nLet me know if you want changes.")).toBe("unread");
    expect(coverage("Text.\nHEADLINE: P.\nNO_CHANGE: yes")).toBe("headline_only");
    const parsed = parseHeadline("Text.\nHEADLINE: P.\nNO_CHANGE: yes", true);
    expect(planCoverage(saidOf(parsed, { ...ask, noChangeOffered: true }))).toBe("no_change");
  });

  it("tells full, partial, headline only and missing apart", () => {
    const full = "HEADLINE: P.\nCHOICE: a | b\nREACH: files | x\nREACH: deps | none\nREACH: services | none\nREACH: secrets | none\nRISK: r";
    expect(coverage(full)).toBe("full");
    expect(coverage("HEADLINE: P.\nCHOICE: a | b")).toBe("partial");
    expect(coverage("HEADLINE: P.\nREACH: files | x\nREACH: deps | none\nREACH: services | none\nREACH: secrets | none\nRISK: r")).toBe("partial");
    expect(coverage("Text.\nHEADLINE: P.")).toBe("headline_only");
    expect(coverage("Only text.")).toBe("missing");
    expect(coverage("")).toBe("missing");
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
