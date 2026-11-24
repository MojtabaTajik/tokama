// What the item drawer says about an item and its steps. Pure functions, tested without React.
// Every state comes as a symbol and a word, so colour is never the only signal.
import type { AgentSummary, ConnectionSummary, ItemKind, ItemRecord, ItemState, Privacy, StepRecord, StepState, WorkspaceSummary } from "@tokama/core";

export type Tone = "warn" | "live" | "pass" | "fail" | "muted";
export interface Mark {
  readonly symbol: string;
  readonly word: string;
  readonly tone: Tone;
}

const ITEM_MARKS: Record<ItemState, Mark> = {
  queued: { symbol: "◌", word: "queued", tone: "muted" },
  running: { symbol: "●", word: "running", tone: "live" },
  needs_you: { symbol: "⏸", word: "needs you", tone: "warn" },
  done: { symbol: "✓", word: "done", tone: "pass" },
  failed: { symbol: "✕", word: "failed", tone: "fail" },
  stopped: { symbol: "■", word: "stopped", tone: "muted" },
};

const STEP_MARKS: Record<StepState, Mark> = {
  pending: { symbol: "○", word: "pending", tone: "muted" },
  running: { symbol: "●", word: "running", tone: "live" },
  needs_you: { symbol: "⏸", word: "needs you", tone: "warn" },
  passed: { symbol: "✓", word: "passed", tone: "pass" },
  failed: { symbol: "✕", word: "failed", tone: "fail" },
  stopped: { symbol: "■", word: "stopped", tone: "muted" },
};

export const itemMark = (state: ItemState): Mark => ITEM_MARKS[state];
export const stepMark = (state: StepState): Mark => STEP_MARKS[state];

export const KIND: Record<ItemKind, { readonly symbol: string; readonly word: string }> = {
  investigation: { symbol: "◎", word: "Investigation" },
  task: { symbol: "▣", word: "Task" },
};

export const PRIVACY: Record<Privacy, string> = { local_only: "local only", local_and_cloud: "local + cloud" };

/** Item states after which nothing runs any more. */
export const hasEnded = (item: Pick<ItemRecord, "state">): boolean => item.state === "done" || item.state === "failed" || item.state === "stopped";

/** The item's position in its template, e.g. "step 2 of 4 · Query logs", or undefined once it has ended or has no steps. */
export function stepPosition(item: Pick<ItemRecord, "state" | "steps">): string | undefined {
  if (hasEnded(item)) return undefined;
  const index = item.steps.findIndex((step) => step.state !== "passed");
  const step = item.steps[index];
  return step ? `step ${index + 1} of ${item.steps.length} · ${step.name}` : undefined;
}

/** Who runs a step: its agent, with an identity dot by join order (1 to 3, then neutral). */
export interface StepAgent {
  readonly name: string;
  /** 1, 2 or 3 for the first three agents of the workspace; "neutral" for later ones and for Tokama itself. */
  readonly dot: 1 | 2 | 3 | "neutral";
  readonly runsOn: "local" | "cloud";
}

/** Steps without an agent are run by Tokama itself, such as checks. */
const TOKAMA: StepAgent = { name: "Tokama", dot: "neutral", runsOn: "local" };

export function stepAgent(step: Pick<StepRecord, "agentId" | "data">, agents: readonly AgentSummary[]): StepAgent {
  if (step.agentId === undefined) return TOKAMA;
  const index = agents.findIndex((agent) => agent.id === step.agentId);
  const agent = agents[index];
  // An agent the workspace no longer lists: its id is all there is, and only the data rule tells where it runs.
  if (!agent) return { name: step.agentId, dot: "neutral", runsOn: step.data === "none" ? "local" : "cloud" };
  return { name: agent.name, dot: index < 3 ? ((index + 1) as 1 | 2 | 3) : "neutral", runsOn: agent.runsOn };
}

/**
 * Where a step runs and what it sees: "local", "local · App Insights (prod) (query), Postgres main
 * (read-only)", or, for a cloud step, what its data rule lets leave the machine.
 */
export function whereLine(step: Pick<StepRecord, "agentId" | "data" | "uses">, agents: readonly AgentSummary[], connections: readonly ConnectionSummary[]): string {
  if (stepAgent(step, agents).runsOn === "cloud") {
    if (step.data === "summary-after-approval") return "cloud · sees your approved summary only";
    if (step.data === "repo-and-diff") return "cloud · sees the repo and the diff";
    return "cloud";
  }
  const uses = (step.uses ?? []).map((use) => `${connections.find((c) => c.id === use.connectionId)?.name ?? use.connectionId} (${use.access})`);
  return uses.length > 0 ? `local · ${uses.join(", ")}` : "local";
}

/** The template's name, or its id when the workspace does not list it. */
export function templateName(item: Pick<ItemRecord, "templateId">, workspace: WorkspaceSummary | undefined): string {
  return workspace?.templates.find((template) => template.id === item.templateId)?.name ?? item.templateId;
}
