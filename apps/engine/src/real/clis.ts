// What the engine decides about AI CLIs from the adapter list and the health checks, in one place.
import { type AiCliAdapter, type AiCliId, aiCliAdapters, type AiCliState, type CliHealth, type CliStatus } from "@tokama/core";

/** The CLIs Tokama names even when this build has no adapter for them: the AI CLIs page lists them as not supported. */
export const KNOWN = {
  "claude-code": { name: "Claude Code", description: "Coding agent CLI from Anthropic. Reads code, edits files, runs commands." },
  "codex-cli": { name: "Codex CLI", description: "Coding agent CLI from OpenAI. Reads code, edits files, runs commands inside its own sandbox." },
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

/**
 * Whether a CLI can run an agent now and, when it cannot, why in plain words: the health check's
 * own message when it has one. It counts an installed, logged-in CLI as ready whatever its
 * version: a helper runs no commands, so it needs none of what a newer version adds.
 */
export function cliReadiness(cliId: AiCliId, clis: readonly CliHealth[], list: readonly AiCliAdapter[] = aiCliAdapters): CliStatus {
  const name = cliName(cliId, list);
  if (!list.some((adapter) => adapter.id === cliId)) return { ready: false, problem: `Tokama cannot run ${name} agents yet.` };
  const health = clis.find((entry) => entry.cliId === cliId);
  const state = cliState(health);
  if (state === "ready") return { ready: true };
  const words = { not_installed: `${name} is not installed.`, not_logged_in: `${name} is installed but not logged in.`, no_answer: `Tokama could not check ${name}. Try again.`, not_checked: `Tokama has not checked ${name} yet. Try again.` } as const;
  return { ready: false, problem: health?.message ?? words[state] };
}

/** The name people see for a CLI. */
export function cliName(cliId: AiCliId, list: readonly AiCliAdapter[] = aiCliAdapters): string {
  return list.find((adapter) => adapter.id === cliId)?.name ?? (cliId in KNOWN ? KNOWN[cliId as keyof typeof KNOWN].name : cliId);
}
