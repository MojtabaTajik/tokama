import { describe, expect, it } from "vitest";
import { TemplateRecordSchema } from "../../kernel/schemas/index.js";
import { BUILTIN_TEMPLATES, loadBuiltins, templateWarnings, validateTemplate, type AgentLocation } from "./index.js";

const AGENT_IDS = ["architect", "builder", "reviewer"];
const agents = (cloud: boolean): ReadonlyMap<string, AgentLocation> => new Map(AGENT_IDS.map((id) => [id, { cloud }]));

async function load(id: string, cloud: boolean) {
  const loads = await loadBuiltins(agents(cloud));
  const found = loads.find((candidate) => (candidate.ok ? candidate.template.id : candidate.ref?.split("/")[1]) === id);
  if (!found?.ok) throw new Error(JSON.stringify(found));
  return found;
}

describe.each([true, false])("built-in templates, every agent in the cloud: %s", (cloud) => {
  it("all load without problems or warnings and match the record schema", async () => {
    const loads = await loadBuiltins(agents(cloud));
    expect(loads.map((load) => (load.ok ? load.template.id : "failed"))).toEqual([...BUILTIN_TEMPLATES.keys()]);
    for (const load of loads) {
      if (!load.ok) throw new Error(JSON.stringify(load));
      expect(TemplateRecordSchema.parse(load.template)).toEqual(load.template);
      expect(load.warnings).toEqual([]);
      expect(templateWarnings(load.template)).toEqual([]);
    }
  });

  it("Plan and build: Plan (you approve), Build (checks from the repo), Review by a different agent, then commit", async () => {
    const { template } = await load("plan-and-build", cloud);
    expect(template).toMatchObject({ ref: "builtin/plan-and-build", name: "Plan and build", icon: expect.any(String), color: expect.any(String), start: { needs: ["text", "repo"] }, uses: { repos: { picked: "edit", named: [] } }, finish: ["commit"] });
    expect(template.steps.map((step) => [step.id, step.agentId, step.doneWhen])).toEqual([
      ["plan", "architect", "you approve"],
      ["build", "builder", "checks pass"],
      ["review", "reviewer", "reviewer approves"],
    ]);
    const [, build, review] = template.steps;
    expect(build).toMatchObject({ checks: { from: "repo" }, ifFailed: { action: "retry" }, sees: ["plan"] });
    expect(review).toMatchObject({ ifChangesRequested: { action: "back", stepId: "build" } });
  });

  it("Quick change: one builder step you approve, with no checks, up to 3 attempts, then commit", async () => {
    const { template } = await load("quick-change", cloud);
    expect(template).toMatchObject({ ref: "builtin/quick-change", name: "Quick change", icon: expect.any(String), color: expect.any(String), start: { needs: ["text", "repo"] }, uses: { repos: { picked: "edit", named: [] } }, finish: ["commit"] });
    expect(template.steps.map((step) => [step.id, step.agentId, step.doneWhen, step.checks, step.maxAttempts])).toEqual([["change", "builder", "you approve", undefined, 3]]);
  });

  it("Review only: one reviewer step that reads the repo and leaves findings", async () => {
    const { template } = await load("review-only", cloud);
    expect(template).toMatchObject({ ref: "builtin/review-only", name: "Review only", start: { needs: ["text", "repo"] }, uses: { repos: { picked: "read", named: [] } }, finish: ["findings"] });
    expect(template.steps.map((step) => [step.id, step.agentId, step.doneWhen])).toEqual([["review", "reviewer", "agent finishes"]]);
  });
});

describe("the reviewer rule on the built-in Plan and build", () => {
  const text = BUILTIN_TEMPLATES.get("plan-and-build")!;
  const validate = (source: string) => validateTemplate(source, { ref: "builtin/plan-and-build" as never, source: { kind: "builtin" }, agents: agents(true) });

  it("refuses a Review step that uses the agent of the step it reviews", async () => {
    const result = await validate(text.replace("agent: reviewer", "agent: builder"));
    if (result.ok) throw new Error("expected problems");
    expect(result.error.map((problem) => problem.message)).toEqual([expect.stringContaining("it needs a different agent; both use \"builder\"")]);
  });

  it("refuses a Review step that has no step to review", async () => {
    const [head, , , review] = text.split(/^ {2}- id: /m);
    const result = await validate(`${head}  - id: ${review}`.replace("    if_changes_requested:\n      back: build\n", "").replace("    sees: [plan]\n", ""));
    if (result.ok) throw new Error("expected problems");
    expect(result.error.map((problem) => problem.message)).toEqual([expect.stringContaining("no earlier step for it to review")]);
  });
});
