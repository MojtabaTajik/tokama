import type { Setup } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { ITEMS, setup } from "../testing/sample.js";
import { type AgentAccess, agentInfo, extraPower } from "./agent-info.js";

const access = { name: "Resolved name", owner: "repo", repoId: "orders-api", cliId: "codex-cli", model: "gpt-5", role: "You build.", edit: true, commands: ["pnpm test"], web: true };

/** The sample setup where the "Plan and build" template's Plan step carries what the engine resolved for it. */
const withAccess = (over: Record<string, unknown> = access): Setup =>
  ({ ...setup, templates: setup.templates.map((t) => (t.id === "builtin/plan-and-build" ? { ...t, steps: t.steps.map((s, i) => (i === 0 ? { ...s, agentAccess: over } : s)) } : t)) }) as unknown as Setup;

describe("agentInfo", () => {
  it("is undefined for a step Tokama runs itself", () => {
    expect(agentInfo(ITEMS.queued, 2, setup)).toBeUndefined();
  });

  it("is undefined when the item has no such step", () => {
    expect(agentInfo(ITEMS.queued, 9, setup)).toBeUndefined();
  });

  it("names the agent and its model from the setup's agent list when the engine resolved nothing for the step", () => {
    expect(agentInfo(ITEMS.queued, 0, setup)).toEqual({ id: "architect", name: "Architect", dot: 1, model: "opus", cliId: "claude-code", access: undefined });
  });

  it("falls back to the id alone for an agent the setup does not list, and to nothing before the first load", () => {
    expect(agentInfo(ITEMS.queued, 0, { ...setup, agents: [] } as Setup)).toMatchObject({ id: "architect", name: "architect", model: undefined, cliId: undefined });
    expect(agentInfo(ITEMS.queued, 0, undefined)).toMatchObject({ id: "architect", model: undefined, access: undefined });
  });

  it("takes the engine's resolved agent for the step over a same-id agent in the list", () => {
    expect(agentInfo(ITEMS.queued, 0, withAccess())).toEqual({
      id: "architect",
      name: "Resolved name",
      dot: 1,
      model: "gpt-5",
      cliId: "codex-cli",
      access: { owner: "repo", repoId: "orders-api", role: "You build.", edit: true, commands: ["pnpm test"], web: true },
    });
  });

  it("ignores a template step whose agent is not the item's step agent", () => {
    const moved = { ...setup, templates: setup.templates.map((t) => (t.id === "builtin/plan-and-build" ? { ...t, steps: t.steps.map((s, i) => (i === 0 ? { ...s, agentId: "reviewer", agentAccess: access } : s)) } : t)) } as unknown as Setup;
    expect(agentInfo(ITEMS.queued, 0, moved)?.access).toBeUndefined();
  });

  it("takes the model from the list when the resolved agent has none", () => {
    expect(agentInfo(ITEMS.queued, 0, withAccess({ ...access, model: undefined, cliId: undefined }))).toMatchObject({ name: "Resolved name", model: "opus", cliId: "claude-code" });
  });
});

describe("extraPower", () => {
  const base: AgentAccess = { owner: "repo", repoId: "orders-api", role: undefined, edit: true, commands: ["pnpm test"], web: true };

  it("marks a repo agent's commands and web access", () => {
    expect(extraPower(base)).toEqual({ commands: true, web: true });
  });

  it("marks only what the repo agent has", () => {
    expect(extraPower({ ...base, commands: [], web: true })).toEqual({ commands: false, web: true });
    expect(extraPower({ ...base, commands: ["x"], web: false })).toEqual({ commands: true, web: false });
  });

  it("marks nothing for a built-in or a personal agent", () => {
    expect(extraPower({ ...base, owner: "builtin" })).toEqual({ commands: false, web: false });
    expect(extraPower({ ...base, owner: "personal" })).toEqual({ commands: false, web: false });
  });
});
