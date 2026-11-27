// The built-in templates, agents and prompts fit together: every step of each built-in template
// has a built-in agent, passes validation, and builds a prompt with nothing dropped.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadAgents, type Agent } from "../config/index.js";
import { buildPrompt } from "../prompting/index.js";
import { loadBuiltins, templateWarnings } from "../templates/index.js";

const home = mkdtempSync(join(tmpdir(), "tokama-builtins-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe("built-in templates with the built-in agents", async () => {
  const { agents, broken } = await loadAgents({ tokamaHome: home });
  const byId = new Map<string, Agent>(agents.map((agent) => [agent.id, agent]));
  const loads = await loadBuiltins(new Map(agents.map((agent) => [agent.id, { cloud: agent.cliId !== "ollama" }])));

  it("has the agents the templates name and none broken", () => {
    expect(broken).toEqual([]);
    expect([...byId.keys()]).toEqual(["architect", "builder", "helper", "reviewer"]);
    expect(agents.filter((agent) => !agent.limits.edit).map((agent) => agent.id)).toEqual(["architect", "helper", "reviewer"]);
  });

  it("loads every built-in template with no problem and no warning", () => {
    expect(loads).toHaveLength(5);
    for (const load of loads) {
      if (!load.ok) throw new Error(JSON.stringify(load));
      expect(load.warnings).toEqual([]);
      expect(templateWarnings(load.template)).toEqual([]);
    }
  });

  it("no step asks an agent that has no commands to run anything", () => {
    for (const load of loads) {
      if (!load.ok) throw new Error(JSON.stringify(load));
      for (const step of load.template.steps) {
        if (byId.get(step.agentId)?.limits.commands.length !== 0) continue;
        expect(step.instructions.text.replace(/\s+/g, " "), `${load.template.id}/${step.id}`).not.toMatch(/\brun\b.*\b(tests?|checks?|commands?)\b/i);
      }
    }
  });

  it.each(["quick-fix", "quick-change", "plan-and-build", "review-only", "ask"])("%s: each step builds a prompt that leaves nothing out", (id) => {
    const load = loads.find((candidate) => candidate.ok && candidate.template.id === id);
    if (!load?.ok) throw new Error(`no ${id}`);
    const { template } = load;
    // The run loop gives a seen step's reply as its `summary`.
    const results = Object.fromEntries(template.steps.map((step) => [step.id, { summary: `SUMMARY-OF-${step.id}` }]));
    for (const step of template.steps) {
      const agent = byId.get(step.agentId);
      if (agent === undefined) throw new Error(`no agent ${step.agentId}`);
      const prompt = buildPrompt({
        template,
        stepId: step.id,
        agent,
        results,
        itemText: "Round the invoice total to cents.",
        repoContext: { diff: "diff --git a/a.ts b/a.ts" },
        approvedSummary: "approved",
      });
      if (!prompt.ok) throw new Error(`${id}/${step.id}: ${prompt.error.message}`);
      expect(prompt.value.record.warnings, `${id}/${step.id}`).toEqual([]);
      for (const seen of step.sees) expect(prompt.value.user).toContain(`SUMMARY-OF-${seen}`);
      for (const other of template.steps.filter((candidate) => !step.sees.includes(candidate.id))) expect(prompt.value.user).not.toContain(`SUMMARY-OF-${other.id}`);
    }
  });
});
