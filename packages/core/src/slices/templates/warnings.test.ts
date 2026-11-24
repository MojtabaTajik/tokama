import { describe, expect, it } from "vitest";
import { TemplateRecordSchema, type TemplateRecord } from "../../kernel/schemas/index.js";
import { templateWarnings } from "./warnings.js";

const step = (id: string, doneWhen: string) => ({
  id,
  name: id,
  agentId: doneWhen === "reviewer approves" ? "reviewer" : "builder",
  instructions: { text: `Do ${id}.` },
  doneWhen,
  ...(doneWhen === "checks pass" && { checks: { from: "repo" } }),
  ifFailed: { action: "ask" },
  maxAttempts: 1,
  data: "none",
  sees: [],
  connections: [],
  commands: [],
});
const template = (...steps: Array<[string, string]>): TemplateRecord =>
  TemplateRecordSchema.parse({
    schemaVersion: 1,
    ref: "builtin/t",
    id: "t",
    source: { kind: "builtin" },
    name: "T",
    uses: { repos: { picked: "edit", named: [] }, connections: [], commands: [] },
    start: { needs: ["text", "repo"], askBeforeCloud: false, notify: false },
    finish: ["commit"],
    steps: steps.map(([id, doneWhen]) => step(id, doneWhen)),
  });

describe("templateWarnings", () => {
  it("warns about a non-reviewer step after the last checks step", () => {
    expect(templateWarnings(template(["build", "checks pass"], ["polish", "agent finishes"]))).toEqual([expect.stringContaining("Step polish comes after the last checks")]);
  });

  it("has nothing to say about a reviewer after the checks, a plan before them, or a template without checks", () => {
    expect(templateWarnings(template(["plan", "you approve"], ["build", "checks pass"], ["review", "reviewer approves"]))).toEqual([]);
    expect(templateWarnings(template(["build", "agent finishes"]))).toEqual([]);
  });
});
