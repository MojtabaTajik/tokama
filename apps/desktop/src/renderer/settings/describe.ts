// The words the Agents page uses for an agent: its CLI monogram, its one-line summary, its tool
// limits and its owner. Backends show as text monograms, never as logos.
import type { AgentDetail, AgentOwner, BrokenAgentDetail } from "@tokama/core";
import { cliName } from "../model.js";

type CliId = AgentDetail["cliId"];

const MONOGRAMS: Readonly<Record<CliId, string>> = { "claude-code": "CC", "codex-cli": "CX", ollama: "OL" };

export const monogram = (cliId: CliId): string => MONOGRAMS[cliId];

/** "CC · opus · cloud", or "OL · qwen3-coder:30b · this machine · via CC" for a local model. */
export function summaryLine(agent: AgentDetail): string {
  const parts = [monogram(agent.cliId), agent.model, agent.runsOn === "local" ? "this machine" : "cloud"];
  if (agent.drivenBy !== undefined) parts.push(`via ${monogram(agent.drivenBy)}`);
  return parts.join(" · ");
}

/** "Claude Code", or "Ollama, driven by Claude Code". */
export const runsOnName = (agent: AgentDetail): string => (agent.drivenBy === undefined ? cliName(agent.cliId) : `${cliName(agent.cliId)}, driven by ${cliName(agent.drivenBy)}`);

export const limitsTitle = (agent: AgentDetail): string => (agent.limits.edit ? "Edits in the worktree" : "Read-only");

/** What the limits allow beyond the title, one sentence each. */
export function limitsNotes(agent: AgentDetail): string[] {
  const { commands, web, edit } = agent.limits;
  return [
    edit ? "Can edit files inside the item's worktree only. Never the base checkout." : "Reads files. Cannot edit or write anywhere.",
    commands.length > 0 ? `May run: ${commands.join(", ")}` : "Runs no shell commands of its own; each template step lists the commands it allows.",
    web ? "May search and fetch from the web." : "No web access.",
  ];
}

export const ownerLabel = (owner: AgentOwner, replacesBuiltin = false): string => {
  const label = owner.kind === "builtin" ? "Built-in" : owner.kind === "personal" ? "Personal" : `Shared in ${owner.repoId}`;
  return replacesBuiltin ? `${label}, replaces the built-in` : label;
};

/** The second line of a list row: the summary, or the file of a broken agent; a note when the agent hides a built-in. */
export function rowLine(row: AgentRow): string {
  const line = row.broken ? row.entry.source : summaryLine(row.agent);
  return (row.broken ? row.entry.replacesBuiltin : row.agent.replacesBuiltin) ? `${line} · replaces built-in` : line;
}

/** A row in the list: a loaded agent or a file that does not load. The key keeps the same id in two places apart. */
export type AgentRow = { readonly key: string; readonly broken: false; readonly agent: AgentDetail } | { readonly key: string; readonly broken: true; readonly entry: BrokenAgentDetail };

const keyOf = (owner: AgentOwner, id: string): string => `${owner.kind}:${owner.kind === "repo" ? owner.repoId : ""}:${id}`;

/** Loaded agents first, then the broken files, each group in the engine's order. */
export const agentRows = (agents: readonly AgentDetail[], broken: readonly BrokenAgentDetail[]): AgentRow[] => [
  ...agents.map((agent): AgentRow => ({ key: keyOf(agent.owner, agent.id), broken: false, agent })),
  ...broken.map((entry): AgentRow => ({ key: keyOf(entry.owner, entry.id), broken: true, entry })),
];

export const rowName = (row: AgentRow): string => (row.broken ? row.entry.id : row.agent.name);

/** Rows whose name, id, model or source contain every word of `query`, ignoring case. */
export function filterRows(rows: readonly AgentRow[], query: string): AgentRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...rows];
  return rows.filter((row) => {
    const haystack = (row.broken ? [row.entry.id, row.entry.source] : [row.agent.name, row.agent.id, row.agent.model, row.agent.source, monogram(row.agent.cliId)]).join(" ").toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
