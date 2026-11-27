// The `ai_clis` query: each AI CLI, found or not, logged in or not, and exactly what Tokama runs.
// The arguments and environment names come from the adapter's own description of a call, and the
// state from the same health checks as the setup. Environment variable names only, never values.
import { type AgentSummary, type AiCli, type AiCliAdapter, aiCliAdapters, type AiClisResult, type CliHealth, findOnPath } from "@tokama/core";
import { cliState, KNOWN } from "./real/clis.js";

/** The schema's limit on names listed under one CLI. */
const MAX_USED_BY = 200;

export interface AiClisInput {
  readonly clis: readonly CliHealth[];
  /** The agents Tokama knows; each is listed under the CLI it runs on. */
  readonly agents: readonly Pick<AgentSummary, "name" | "cliId">[];
  /** Where the CLI is looked up: the PATH of this environment, as the runner reduces it. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

function supportedRow(adapter: AiCliAdapter, input: AiClisInput): AiCli {
  const launch = adapter.launch();
  const health = input.clis.find((cli) => cli.cliId === adapter.id);
  const path = findOnPath(launch.command, input.env);
  return {
    supported: true,
    cliId: adapter.id,
    name: adapter.name,
    description: adapter.description,
    state: cliState(health),
    ...(health?.version === undefined ? {} : { version: health.version }),
    ...(path === undefined ? {} : { path }),
    ...(health?.message === undefined ? {} : { message: health.message }),
    loginCommand: adapter.loginCommand,
    command: launch.command,
    headlessArgs: [...launch.headlessArgs],
    modelArgs: [...launch.modelArgs],
    permissionArgs: [...launch.permissionArgs],
    promptVia: launch.promptVia,
    roleArgs: [...launch.roleArgs],
    envNames: [...launch.envNames],
    usedBy: input.agents.filter((agent) => agent.cliId === adapter.id).map((agent) => agent.name).slice(0, MAX_USED_BY),
  };
}

/** One supported row per adapter, then the CLIs Tokama knows that this build has no adapter for. */
export function aiClis(input: AiClisInput, list: readonly AiCliAdapter[] = aiCliAdapters): AiClisResult {
  const supported = list.map((adapter) => supportedRow(adapter, input));
  const missing = (Object.entries(KNOWN) as [keyof typeof KNOWN, (typeof KNOWN)[keyof typeof KNOWN]][])
    .filter(([cliId]) => !list.some((adapter) => adapter.id === cliId))
    .map(([cliId, known]): AiCli => ({ supported: false, cliId, ...known }));
  return { clis: [...supported, ...missing] };
}
