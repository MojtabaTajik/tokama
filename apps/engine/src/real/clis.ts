// What the engine decides about AI CLIs from the adapter list and the health checks, in one place.
import { type AiCliAdapter, type AiCliId, aiCliAdapters, type AiCliState, type CliHealth } from "@tokama/core";

/** The CLIs Tokama names even when this build has no adapter for them: the AI CLIs page lists them as not supported. */
export const KNOWN = {
  "claude-code": { name: "Claude Code", description: "Coding agent CLI from Anthropic. Reads code, edits files, runs commands." },
  "codex-cli": { name: "Codex CLI", description: "Coding agent CLI from OpenAI." },
} as const satisfies Partial<Record<AiCliId, { readonly name: string; readonly description: string }>>;

/** How far a CLI can run agents, from its last health check. */
export function cliState(health: CliHealth | undefined): AiCliState {
  if (health === undefined) return "not_checked";
  if (health.timedOut === true) return "no_answer";
  if (!health.installed) return "not_installed";
  return health.loggedIn ? "ready" : "not_logged_in";
}

/** The CLI to use when nothing says which: the first in the adapter list that is installed and logged in. */
export function defaultCli(clis: readonly CliHealth[], list: readonly AiCliAdapter[] = aiCliAdapters): AiCliId | undefined {
  return list.find((adapter) => cliState(clis.find((health) => health.cliId === adapter.id)) === "ready")?.id;
}

/** The name people see for a CLI. */
export function cliName(cliId: AiCliId, list: readonly AiCliAdapter[] = aiCliAdapters): string {
  return list.find((adapter) => adapter.id === cliId)?.name ?? (cliId in KNOWN ? KNOWN[cliId as keyof typeof KNOWN].name : cliId);
}
