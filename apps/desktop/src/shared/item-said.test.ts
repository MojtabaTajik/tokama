import type { ItemRecord, Said } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { readTag, saidOf, saidTag } from "./item-said.js";

const said = (headline: string, more: Partial<Said> = {}): Said => ({ source: "headline", headline, points: [], morePoints: 0, bodyBytes: 100, ...more });
type Step = ItemRecord["steps"][number];
const step = (name: string, state: Step["state"], attempts: { said?: Said; result?: "passed" | "failed" }[], doneWhen?: Step["doneWhen"]): Step =>
  ({ name, stage: "working", state, data: "none", ...(doneWhen !== undefined && { doneWhen }), attempts: attempts.map(({ said: s, result }, index) => ({ attempt: index + 1, result: result ?? "passed", checks: [], ...(s !== undefined && { said: s }) })) }) as Step;

describe("saidOf", () => {
  it("is the words of the last passed step that is not a reviewer's", () => {
    const item = { steps: [step("Plan", "passed", [{ said: said("A plan.") }]), step("Build", "passed", [{ said: said("Built it.") }], "checks pass"), step("Review", "passed", [{ said: said("Looks fine.") }], "reviewer approves")] };
    expect(saidOf(item)).toEqual({ said: said("Built it."), stepIndex: 1, attempt: 1 });
  });

  it("takes the latest attempt of that step that said something", () => {
    const item = { steps: [step("Build", "passed", [{ said: said("First.") }, { said: said("Second.") }, {}])] };
    expect(saidOf(item)).toEqual({ said: said("Second."), stepIndex: 0, attempt: 2 });
  });

  it("skips a passed step that said nothing, then falls back to any step that said something", () => {
    expect(saidOf({ steps: [step("Fix", "passed", [{ said: said("Fixed.") }]), step("Run checks", "passed", [{}])] })?.said.headline).toBe("Fixed.");
    const reviewOnly = { steps: [step("Review", "passed", [{ said: said("Approved.") }], "reviewer approves")] };
    expect(saidOf(reviewOnly)).toEqual({ said: said("Approved."), stepIndex: 0, attempt: 1 });
    expect(saidOf({ steps: [step("Build", "failed", [{ said: said("Tried."), result: "failed" }])] })?.said.headline).toBe("Tried.");
  });

  it("is nothing for an item whose steps said nothing, or that has no attempts", () => {
    expect(saidOf({ steps: [step("Build", "passed", [{}])] })).toBeUndefined();
    expect(saidOf({ steps: [{ name: "Build", stage: "working", state: "passed", data: "none" } as Step] })).toBeUndefined();
    expect(saidOf({ steps: [] })).toBeUndefined();
  });
});

describe("saidTag", () => {
  it("is the read time of a must-read, whatever else it has", () => {
    expect(saidTag(said("A design.", { readMinutes: 6, points: ["a"] }))).toBe("read · 6 min");
    expect(readTag(said("x"))).toBeUndefined();
  });

  it("is the number of points the agent wrote, carried or only counted", () => {
    expect(saidTag(said("x"))).toBeUndefined();
    expect(saidTag(said("x", { points: ["a"] }))).toBe("+1 point");
    expect(saidTag(said("x", { points: ["a", "b", "c"], morePoints: 2 }))).toBe("+5 points");
  });

  it("has no points tag for first lines: they are lines of the reply, not points", () => {
    expect(saidTag(said("First line", { source: "first_lines", points: ["Second", "Third"] }))).toBeUndefined();
    expect(saidTag(said("First line", { source: "first_lines", readMinutes: 2 }))).toBe("read · 2 min");
  });
});
