import type { TemplateStepView, TemplateView } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { setup } from "../testing/sample.js";
import { planAndBuild } from "../testing/templates.js";
import { flowOf, NODE_HEIGHT, SLOT } from "./flow.js";

const [plan, build, review] = planAndBuild.steps as [TemplateStepView, TemplateStepView, TemplateStepView];
const withSteps = (...steps: TemplateStepView[]) => ({ steps }) as Pick<TemplateView, "steps">;

describe("flowOf", () => {
  const flow = flowOf(planAndBuild, setup.agents);

  it("puts Start, the steps and Finish in one row, with an arrow between neighbours", () => {
    expect(flow.nodes.map((node) => [node.kind, node.label, node.dot])).toEqual([
      ["start", "Start", undefined],
      ["step", "Plan", 1],
      ["step", "Build", 2],
      ["step", "Review", 3],
      ["finish", "Finish", undefined],
    ]);
    expect(flow.width).toBe(5 * SLOT);
    expect(flow.arrows).toHaveLength(4);
    for (const [i, arrow] of flow.arrows.entries()) {
      expect(arrow.x1).toBe(flow.nodes[i]!.x + flow.nodes[i]!.width);
      expect(arrow.x2).toBe(flow.nodes[i + 1]!.x);
    }
  });

  it("draws a retry over its own step and a review loop back to Build", () => {
    expect(flow.loops.map((loop) => [loop.kind, loop.from, loop.to, loop.label])).toEqual([
      ["self", 2, 2, "checks fail · retry, up to 3"],
      ["back", 3, 2, "changes · back to Build"],
    ]);
    const [self, back] = flow.loops;
    expect(self!.path.startsWith(`M${flow.nodes[2]!.x + flow.nodes[2]!.width / 2 + 16} ${flow.top}`)).toBe(true);
    // The back line leaves Review's bottom and ends on Build's bottom.
    const bottom = flow.top + NODE_HEIGHT;
    expect(back!.path).toMatch(new RegExp(`^M${flow.nodes[3]!.x + flow.nodes[3]!.width / 2} ${bottom} C.* ${flow.nodes[2]!.x + flow.nodes[2]!.width / 2} ${bottom}$`));
    expect(back!.labelY).toBeGreaterThan(bottom);
    expect(flow.height).toBeGreaterThan(back!.labelY);
  });

  it("says the whole flow in words", () => {
    expect(flow.description).toBe(
      "Start → Plan → Build → Review → Finish. Loops: Build tries again when its checks fail, up to 3 attempts; Review sends the work back to Build when it asks for changes and checks again after each fix, up to 3 round trips, then asks you.",
    );
  });

  it("draws a failed step's back: below, deeper for each further loop", () => {
    const twoBacks = flowOf(withSteps(plan, { ...build, ifFailed: { action: "back", stepId: "plan" } } as TemplateStepView, review), setup.agents);
    expect(twoBacks.loops.map((loop) => [loop.kind, loop.from, loop.to, loop.label])).toEqual([
      ["back", 2, 1, "checks fail · back to Plan"],
      ["back", 3, 2, "changes · back to Build"],
    ]);
    expect(twoBacks.loops[1]!.labelY).toBeGreaterThan(twoBacks.loops[0]!.labelY);
    // No self loop: the row starts near the top.
    expect(twoBacks.top).toBeLessThan(flow.top);
    expect(twoBacks.description).toContain("Build sends the work back to Plan when its checks fail and runs again after it, up to 3 round trips, then asks you");
  });

  it("puts a shorter back line above a longer one from the same step, so they do not cross", () => {
    const build2 = { ...build, id: "build-again", name: "Build again", ifFailed: { action: "back", stepId: "plan" } } as TemplateStepView;
    const review2 = { ...review, ifChangesRequested: { action: "back", stepId: "plan" } } as TemplateStepView;
    const crossing = flowOf(withSteps(plan, build, build2, review2), setup.agents);
    const backs = crossing.loops.filter((loop) => loop.kind === "back");
    // Build → Plan (span 1) and Review → Plan (span 3) end on the same step.
    expect(backs.map((loop) => [loop.from, loop.to])).toEqual([
      [3, 1],
      [4, 1],
    ]);
    expect(backs[0]!.labelY).toBeLessThan(backs[1]!.labelY);
  });

  it("draws no failure loop for a reviewer step, only its changes loop", () => {
    const onlyFailed = flowOf(withSteps(plan, { ...review, ifFailed: { action: "back", stepId: "plan" }, ifChangesRequested: { action: "ask" } } as TemplateStepView), setup.agents);
    expect(onlyFailed.loops).toEqual([]);
    expect(onlyFailed.description).not.toContain("when it fails");
    const both = flowOf(withSteps(plan, build, { ...review, ifFailed: { action: "back", stepId: "plan" }, ifChangesRequested: { action: "back", stepId: "build" } } as TemplateStepView), setup.agents);
    expect(both.loops.filter((loop) => loop.from === 3).map((loop) => loop.label)).toEqual(["changes · back to Build"]);
  });

  it("draws a back: to the same step as a self loop", () => {
    const same = flowOf(withSteps({ ...build, ifFailed: { action: "back", stepId: "build" } } as TemplateStepView), setup.agents);
    expect(same.loops.map((loop) => [loop.kind, loop.label])).toEqual([["self", "checks fail · retry, up to 3"]]);
    expect(same.description).toContain("tries again when its checks fail, up to 3 attempts");
  });

  it("draws a review step's changes back to its own step as a retry", () => {
    const same = flowOf(withSteps({ ...review, id: build.id, ifChangesRequested: { action: "back", stepId: build.id }, maxAttempts: 2 } as TemplateStepView), setup.agents);
    expect(same.loops.map((loop) => [loop.kind, loop.from, loop.to, loop.label])).toEqual([["self", 1, 1, "changes · retry, up to 2"]]);
    expect(same.description).toContain("Review tries again when it asks for changes, up to 2 attempts");
  });

  it("says 1 attempt, not 1 attempts", () => {
    const once = flowOf(withSteps({ ...build, ifFailed: { action: "retry" }, maxAttempts: 1 } as TemplateStepView), setup.agents);
    expect(once.description).toContain("up to 1 attempt.");
  });

  it("has no loops for a straight template", () => {
    const straight = flowOf(withSteps(plan), setup.agents);
    expect(straight.loops).toEqual([]);
    expect(straight.description).toBe("Start → Plan → Finish. No loops.");
  });
});
