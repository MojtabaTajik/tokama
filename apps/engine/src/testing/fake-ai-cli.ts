// A second AI CLI adapter for tests, so the engine can be shown to loop over its adapter list
// instead of knowing Claude Code. It runs nothing: its runtime ends every call at once.
import type { AgentRuntime, AiCliAdapter, AiCliId, AiCliLaunch, CliHealth } from "@tokama/core";

export interface FakeAiCliOptions {
  readonly id?: AiCliId;
  readonly name?: string;
  /** Fields of the health check this adapter answers with. Default: installed and logged in. */
  readonly health?: Partial<Omit<CliHealth, "cliId">>;
  readonly runtime?: AgentRuntime;
  readonly plan?: AiCliAdapter["plan"];
  readonly localUsage?: AiCliAdapter["localUsage"];
}

const EMPTY_RUNTIME: AgentRuntime = {
  launch: async function* () {
    yield { type: "end", outcome: "completed", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  },
};

export function fakeAiCli(options: FakeAiCliOptions = {}): AiCliAdapter {
  const id = options.id ?? "codex-cli";
  const launch: AiCliLaunch = { command: "fake-cli", headlessArgs: ["exec"], modelArgs: ["--model={model}"], permissionArgs: ["--read-only"], promptVia: "argument", roleArgs: [], envNames: ["PATH"] };
  return {
    kind: "ai-cli",
    id,
    name: options.name ?? "Fake CLI",
    description: "A CLI that exists for tests.",
    loginCommand: "fake-cli login",
    updateCommand: "fake-cli update",
    minimumVersion: "0.1.0",
    createRuntime: () => options.runtime ?? EMPTY_RUNTIME,
    status: async () => ({ cliId: id, installed: true, loggedIn: true, version: "0.1.0", ...options.health }),
    launch: () => launch,
    ...(options.plan !== undefined && { plan: options.plan }),
    ...(options.localUsage !== undefined && { localUsage: options.localUsage }),
  };
}
