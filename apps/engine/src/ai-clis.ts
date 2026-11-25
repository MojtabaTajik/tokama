// The `ai_clis` query: each AI CLI, found or not, logged in or not, and exactly what Tokama runs.
// The arguments and environment names come from the adapter's own description of a call, and the
// state from the same health checks as the setup. Environment variable names only, never values.
import { adapters, type AgentSummary, type AiCli, type AiClisResult, type AiCliState, type CliHealth, findOnPath } from "@tokama/core";

/** The slice of the adapter this query reads. The adapter may have been removed. */
interface LaunchInfo {
  readonly command: string;
  readonly headlessArgs: readonly string[];
  readonly modelArgs: readonly string[];
  readonly permissionArgs: readonly string[];
  readonly promptVia: "stdin";
  readonly roleArgs: readonly string[];
  readonly envNames: readonly string[];
  readonly loginCommand: string;
}

const NOT_SUPPORTED: readonly { readonly cliId: "codex-cli"; readonly name: string; readonly description: string }[] = [
  { cliId: "codex-cli", name: "Codex CLI", description: "Coding agent CLI from OpenAI." },
];

/** The schema's limit on names listed under one CLI. */
const MAX_USED_BY = 200;

const CLAUDE = { name: "Claude Code", description: "Coding agent CLI from Anthropic. Reads code, edits files, runs commands." } as const;

function stateOf(health: CliHealth | undefined): AiCliState {
  if (health === undefined) return "not_checked";
  if (health.timedOut === true) return "no_answer";
  if (!health.installed) return "not_installed";
  return health.loggedIn ? "ready" : "not_logged_in";
}

export interface AiClisInput {
  readonly clis: readonly CliHealth[];
  /** The agents Tokama knows; each is listed under the CLI it runs on. */
  readonly agents: readonly Pick<AgentSummary, "name" | "cliId">[];
  /** Where the CLI is looked up: the PATH of this environment, as the runner reduces it. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

function claudeCode(launch: LaunchInfo, input: AiClisInput): AiCli {
  const health = input.clis.find((cli) => cli.cliId === "claude-code");
  const path = findOnPath(launch.command, input.env);
  return {
    supported: true,
    cliId: "claude-code",
    ...CLAUDE,
    state: stateOf(health),
    ...(health?.version === undefined ? {} : { version: health.version }),
    ...(path === undefined ? {} : { path }),
    ...(health?.message === undefined ? {} : { message: health.message }),
    loginCommand: launch.loginCommand,
    command: launch.command,
    headlessArgs: [...launch.headlessArgs],
    modelArgs: [...launch.modelArgs],
    permissionArgs: [...launch.permissionArgs],
    promptVia: launch.promptVia,
    roleArgs: [...launch.roleArgs],
    envNames: [...launch.envNames],
    usedBy: input.agents.filter((agent) => agent.cliId === "claude-code").map((agent) => agent.name).slice(0, MAX_USED_BY),
  };
}

export function aiClis(input: AiClisInput): AiClisResult {
  const factories: Record<string, unknown> = { ...adapters };
  return aiClisWith(factories["claudeCodeLaunch"] as (() => LaunchInfo) | undefined, input);
}

/** `describe` is the adapter's description of a call; undefined when the adapter was removed. */
export function aiClisWith(describe: (() => LaunchInfo) | undefined, input: AiClisInput): AiClisResult {
  const claude: AiCli = describe === undefined ? { supported: false, cliId: "claude-code", ...CLAUDE } : claudeCode(describe(), input);
  return { clis: [claude, ...NOT_SUPPORTED.map((cli) => ({ supported: false as const, ...cli }))] };
}
