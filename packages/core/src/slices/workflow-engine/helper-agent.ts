// Which agent answers a helper. The built-in Helper agent runs on the first AI CLI in
// `HELPER_TARGETS` that is ready, so a helper works on whatever CLI the person has. An agent file of
// the person's own (`~/.tokama/agents/helper.md`, or any other agent a helper names) is used exactly
// as written: when it cannot run, the helper says why and nothing falls back to another CLI. A
// repo's agent files are never used: a cloned repo must not choose where its own files are sent.
import type { AgentRuntime } from "../../kernel/ports/index.js";
import type { AiCliId, HelperAgent } from "../../kernel/schemas/index.js";
import { type Agent, formatProblem, type LoadedAgents } from "../config/index.js";
import type { HelperDefinition } from "../helpers/index.js";
import { runsInCloud } from "../prompting/index.js";

/**
 * Where the built-in Helper agent runs, best first. A newly supported CLI adds one row. The row
 * for Claude Code holds the same model as the built-in agent file (a test keeps them equal).
 */
export const HELPER_TARGETS: readonly { readonly cliId: AiCliId; readonly model: string }[] = [{ cliId: "claude-code", model: "haiku" }];

export const HELPER_NO_CLI = "No AI CLI is ready. Set up an AI CLI: install Claude Code and log in, then try again.";
export const HELPER_LOCAL_ONLY = "Local-only mode is on. Helpers need a local model, which Tokama cannot run yet.";

/** How far a CLI can run an agent now. `problem` says why not, in plain words. */
export interface CliStatus {
  readonly ready: boolean;
  readonly problem?: string;
}

export interface HelperAgentDeps {
  /** Personal and built-in agents; never a repo's. */
  readonly agents: LoadedAgents;
  readonly cliStatus: (cliId: AiCliId) => Promise<CliStatus>;
  /** The runtime of the adapter for the agent's CLI, if this build has one. */
  readonly runtime: (agent: Agent) => AgentRuntime | undefined;
  readonly cliName: (cliId: AiCliId) => string;
  readonly localOnly: boolean;
}

export type HelperAgentChoice =
  | { readonly ok: true; readonly agent: Agent; readonly summary: HelperAgent; readonly runtime: AgentRuntime }
  /** `summary` is absent when no agent could be named: a broken file, or no CLI ready. */
  | { readonly ok: false; readonly problem: string; readonly summary?: HelperAgent };

const summaryOf = (agent: Agent): HelperAgent => ({ agentId: agent.id, name: agent.name, cliId: agent.cliId, model: agent.model, runsOn: runsInCloud(agent.cliId) ? "cloud" : "local" });

/** The first reason `agent` cannot answer, or its runtime. */
async function refusal(agent: Agent, deps: HelperAgentDeps): Promise<string | AgentRuntime> {
  if (agent.cliId === "ollama") return `${agent.id} runs on ollama, and Tokama does not run local models yet. Use an agent that runs on claude-code.`;
  if (runsInCloud(agent.cliId) && deps.localOnly) return HELPER_LOCAL_ONLY;
  const runtime = deps.runtime(agent);
  if (runtime === undefined) return `Tokama cannot run ${deps.cliName(agent.cliId)} agents yet.`;
  const status = await deps.cliStatus(agent.cliId);
  if (!status.ready) return status.problem ?? `${deps.cliName(agent.cliId)} is not ready.`;
  return runtime;
}

/** The agent that answers `definition` now, or why none can. Reads nothing but what `deps` hold. */
export async function chooseHelperAgent(definition: Pick<HelperDefinition, "agentId">, deps: HelperAgentDeps): Promise<HelperAgentChoice> {
  const { agents } = deps;
  const broken = agents.broken.find((entry) => entry.id === definition.agentId);
  if (broken !== undefined) return { ok: false, problem: `The agent ${broken.id} does not load: ${broken.problems.map(formatProblem).join(" ")}`.trim() };
  const agent = agents.agents.find((entry) => entry.id === definition.agentId);
  if (agent === undefined) return { ok: false, problem: `The agent ${definition.agentId} is not set up.` };

  if (agent.owner.kind === "builtin" && agent.id === "helper") {
    for (const target of HELPER_TARGETS) {
      const candidate: Agent = { ...agent, cliId: target.cliId, model: target.model };
      const result = await refusal(candidate, deps);
      if (typeof result !== "string") return { ok: true, agent: candidate, summary: summaryOf(candidate), runtime: result };
    }
    // With local-only on and no local target, saying "set up an AI CLI" would send the person the wrong way.
    return { ok: false, problem: deps.localOnly && HELPER_TARGETS.every((target) => runsInCloud(target.cliId)) ? HELPER_LOCAL_ONLY : HELPER_NO_CLI };
  }

  const result = await refusal(agent, deps);
  return typeof result === "string" ? { ok: false, problem: result, summary: summaryOf(agent) } : { ok: true, agent, summary: summaryOf(agent), runtime: result };
}
