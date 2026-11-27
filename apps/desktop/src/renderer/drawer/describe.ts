// What the item drawer says about an item and its steps. Pure functions, tested without React.
// Every state comes as a symbol and a word, so colour is never the only signal.
import type { AgentSummary, AiCliId, AttemptSummary, ConnectionSummary, ItemKind, ItemRecord, ItemState, Privacy, StepRecord, StepState, Setup } from "@tokama/core";
import { type Mark, markOf } from "../ui/status.js";
import { type AgentHue, agentHue } from "../ui/agent.js";


// Item and step states share their names with the status table.
export const itemMark = (state: ItemState): Mark => markOf(state);
export const stepMark = (state: StepState): Mark => markOf(state);

export const KIND: Record<ItemKind, { readonly symbol: string; readonly word: string }> = {
  investigation: { symbol: "◎", word: "Investigation" },
  task: { symbol: "▣", word: "Task" },
};

export const PRIVACY: Record<Privacy, string> = { local_only: "local only", local_and_cloud: "local + cloud" };

/**
 * "Run 2 of 3": the run Request changes would start, as the engine counts it; at the limit, that
 * the engine asks first. Undefined when the engine sent no counts.
 */
export function nextRunLine(step: Pick<StepRecord, "runs" | "maxAttempts"> | undefined): string | undefined {
  if (step?.maxAttempts === undefined || step.runs === undefined) return undefined;
  const next = step.runs + 1;
  return next > step.maxAttempts ? `The step has used its ${step.maxAttempts} runs, so Tokama asks you before it runs again` : `Run ${next} of ${step.maxAttempts}`;
}

/** "run 2 of 3": the run in progress, as the engine counts it. */
export function runLine(step: Pick<StepRecord, "runs" | "maxAttempts">): string | undefined {
  return step.maxAttempts === undefined || step.runs === undefined ? undefined : `run ${step.runs} of ${step.maxAttempts}`;
}

const RUNNING_ATTEMPT: Mark = markOf("running");

/** How an attempt ended, as a symbol and a word. */
export const attemptMark = (result: NonNullable<AttemptSummary["result"]>): Mark => markOf(result);

/** An attempt as one line: "attempt 2 · failed · sh check.sh exit 1", with its mark. */
export function attemptLine(attempt: AttemptSummary): { readonly mark: Mark; readonly text: string } {
  const mark = attempt.result === undefined ? RUNNING_ATTEMPT : markOf(attempt.result);
  const failedCheck = attempt.checks.find((check) => !check.passed);
  const why =
    failedCheck !== undefined
      ? `${failedCheck.command} ${failedCheck.exitCode === null ? "stopped by a signal" : `exit ${failedCheck.exitCode}`}`
      : attempt.result === "run_failed"
        ? (attempt.detail ?? attempt.failure)
        : attempt.checks.length > 0 && attempt.result === "passed"
          ? `${attempt.checks.length} ${attempt.checks.length === 1 ? "check" : "checks"} passed`
          : undefined;
  return { mark, text: [`attempt ${attempt.attempt}`, mark.word, ...(why === undefined ? [] : [why])].join(" · ") };
}

/** How the item ended, with its commit: "commit 3f2a9c1 on tokama/0b9f3c1e". */
export function outcomeLine(item: Pick<ItemRecord, "outcome">): string | undefined {
  const commit = item.outcome?.commits?.[0];
  if (commit !== undefined) return `commit ${commit.commit.slice(0, 7)}${commit.branch === undefined ? "" : ` on ${commit.branch}`}`;
  return item.outcome?.detail;
}

/** Item states after which nothing runs any more. */
export const hasEnded = (item: Pick<ItemRecord, "state">): boolean => item.state === "done" || item.state === "failed" || item.state === "stopped";

/** The item's position in its template, e.g. "step 2 of 4 · Query logs", or undefined once it has ended or has no steps. */
export function stepPosition(item: Pick<ItemRecord, "state" | "steps">): string | undefined {
  if (hasEnded(item)) return undefined;
  const index = item.steps.findIndex((step) => step.state !== "passed");
  const step = item.steps[index];
  return step ? `step ${index + 1} of ${item.steps.length} · ${step.name}` : undefined;
}

/** Who runs a step: its agent, with a colour for its name by join order (1 to 3, then neutral). */
export interface StepAgent {
  readonly name: string;
  readonly hue: AgentHue;
  readonly runsOn: "local" | "cloud";
  /** The tool that runs the agent; absent for Tokama and for an agent the setup no longer lists. */
  readonly cliId?: AiCliId;
  /** The agent's icon name; absent for Tokama and for an agent the setup no longer lists. */
  readonly icon?: string;
}

/** Steps without an agent are run by Tokama itself, such as checks. */
const TOKAMA: StepAgent = { name: "Tokama", hue: "neutral", runsOn: "local" };

export function stepAgent(step: Pick<StepRecord, "agentId" | "data">, agents: readonly AgentSummary[]): StepAgent {
  if (step.agentId === undefined) return TOKAMA;
  const agent = agents.find((candidate) => candidate.id === step.agentId);
  // An agent the setup no longer lists: its id is all there is, and only the data rule tells where it runs.
  if (!agent) return { name: step.agentId, hue: "neutral", runsOn: step.data === "none" ? "local" : "cloud" };
  return { name: agent.name, hue: agentHue(agent.id, agents), runsOn: agent.runsOn, cliId: agent.cliId, ...(agent.icon !== undefined && { icon: agent.icon }) };
}

/**
 * Where a step runs and what it sees: "local", "local · App Insights (query), Postgres (read-only)"
 * (each connection by its connector type), or, for a cloud step, what its data rule lets leave the
 * machine.
 */
export function whereLine(step: Pick<StepRecord, "agentId" | "data" | "uses">, agents: readonly AgentSummary[], connections: readonly ConnectionSummary[]): string {
  if (stepAgent(step, agents).runsOn === "cloud") {
    if (step.data === "summary-after-approval") return "cloud · sees your approved summary only";
    if (step.data === "repo-and-diff") return "cloud · sees the repo and the diff";
    return "cloud";
  }
  const uses = (step.uses ?? []).map((use) => `${connections.find((c) => c.id === use.connectionId)?.type ?? use.connectionId} (${use.access})`);
  return uses.length > 0 ? `local · ${uses.join(", ")}` : "local";
}

/** The setup's summary of the item's template; undefined when the setup does not list it. */
export const templateOf = (item: Pick<ItemRecord, "templateId">, setup: Setup | undefined) => setup?.templates.find((template) => template.id === item.templateId);

/** The template's name, or its id when the setup does not list it. */
export const templateName = (item: Pick<ItemRecord, "templateId">, setup: Setup | undefined): string => templateOf(item, setup)?.name ?? item.templateId;
