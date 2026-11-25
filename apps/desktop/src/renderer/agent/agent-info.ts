// What the agent label and its tooltip show about the agent of one step of an item: its names, who
// owns it and what it may do. The template step carries what the engine resolved for it (the same
// agent the step runs); the setup's agent list fills in what that lacks.
import type { AiCliId, ItemRecord, Setup } from "@tokama/core";
import { type StepAgent, stepAgent } from "../drawer/describe.js";

export interface AgentInfo {
  readonly id: string;
  readonly name: string;
  readonly dot: StepAgent["dot"];
  readonly model: string | undefined;
  readonly cliId: AiCliId | undefined;
  /** Absent when the engine could not resolve the agent for this step. */
  readonly access: AgentAccess | undefined;
}

export interface AgentAccess {
  readonly owner: "builtin" | "personal" | "repo";
  readonly repoId: string | undefined;
  readonly role: string | undefined;
  readonly edit: boolean;
  readonly commands: readonly string[];
  readonly web: boolean;
}

/** The agent of the item's step at `index`; undefined for a step Tokama runs itself (checks). */
export function agentInfo(item: Pick<ItemRecord, "templateId" | "steps">, index: number, setup: Setup | undefined): AgentInfo | undefined {
  const step = item.steps[index];
  if (step?.agentId === undefined) return undefined;
  const agents = setup?.agents ?? [];
  const listed = agents.find((agent) => agent.id === step.agentId);
  const templateStep = setup?.templates.find((template) => template.id === item.templateId)?.steps[index];
  const resolved = templateStep?.agentId === step.agentId ? templateStep.agentAccess : undefined;
  return {
    id: step.agentId,
    name: resolved?.name ?? stepAgent(step, agents).name,
    dot: stepAgent(step, agents).dot,
    model: resolved?.model ?? listed?.model,
    cliId: resolved?.cliId ?? listed?.cliId,
    access:
      resolved === undefined
        ? undefined
        : { owner: resolved.owner, repoId: resolved.repoId, role: resolved.role, edit: resolved.edit, commands: resolved.commands, web: resolved.web },
  };
}

/** A repo's agent that may run commands or use the web: what the engineer did not pick, so it shows in amber. */
export const extraPower = (access: AgentAccess): { readonly commands: boolean; readonly web: boolean } => ({
  commands: access.owner === "repo" && access.commands.length > 0,
  web: access.owner === "repo" && access.web,
});
