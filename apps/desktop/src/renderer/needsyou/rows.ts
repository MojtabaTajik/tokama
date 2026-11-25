// What the Needs you page lists: every item that waits for the engineer, oldest first, with what
// its row says about the decision. Pure functions that take the clock as an argument.
import type { Decision, ItemRecord, Setup, StepRecord } from "@tokama/core";
import { DECISION_KIND, stepAgent, type StepAgent, templateOf } from "../drawer/describe.js";
import { cliName, timeOf } from "../model.js";

export interface NeedsYouRow {
  readonly item: ItemRecord;
  /** Undefined while the engine has sent no question for the waiting item. */
  readonly decision: Decision | undefined;
  /** What kind of decision it is, in a word: the engine's kind, or, from an engine that sends none, a guess from the record. */
  readonly kind: string;
  /** "step 4 of 4 · Propose a fix"; undefined when the item has no step that waits. */
  readonly stepLine: string | undefined;
  readonly agent: StepAgent | undefined;
  /** The AI CLI of the step's agent, when the setup lists the agent. */
  readonly cli: string | undefined;
  readonly workflow: { readonly name: string; readonly icon: string | undefined; readonly color: string | undefined };
  /** How long ago the item started. The engine records no time for the question, so this is the best known lower bound of the wait. */
  readonly since: string;
  readonly sinceTitle: string;
}

export const KIND_CLOUD = "Cloud-step approval";
export const KIND_OTHER = "Decision";

/** The step the decision is about: its own index, or the first step that waits when the index points nowhere. */
function waitingStep(item: ItemRecord, decision: Decision | undefined): { readonly step: StepRecord; readonly index: number } | undefined {
  const own = decision === undefined ? undefined : item.steps[decision.stepIndex];
  if (own !== undefined && decision !== undefined) return { step: own, index: decision.stepIndex };
  const index = item.steps.findIndex((step) => step.state === "needs_you");
  const step = item.steps[index];
  return step === undefined ? undefined : { step, index };
}

/**
 * Items waiting for the engineer, oldest first (ties by id, so the order never flips between
 * renders). The test is the rail badge's: state `needs_you`, with or without a decision.
 */
export function needsYouRows(items: readonly ItemRecord[], setup: Setup | undefined, now: number): NeedsYouRow[] {
  const agents = setup?.agents ?? [];
  return items
    .filter((item) => item.state === "needs_you")
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((item) => {
      const decision = item.decision;
      const at = waitingStep(item, decision);
      const agent = at === undefined ? undefined : stepAgent(at.step, agents);
      const template = templateOf(item, setup);
      const time = timeOf(item, now);
      const cloud = decision?.summaryText !== undefined || (agent?.runsOn === "cloud" && at?.step.data !== "none");
      const cliId = at?.step.agentId === undefined ? undefined : agents.find((candidate) => candidate.id === at.step.agentId)?.cliId;
      return {
        item,
        decision,
        kind: decision?.kind !== undefined ? DECISION_KIND[decision.kind] : cloud ? KIND_CLOUD : KIND_OTHER,
        stepLine: at === undefined ? undefined : `step ${at.index + 1} of ${item.steps.length} · ${at.step.name}`,
        agent,
        cli: cliId === undefined ? undefined : cliName(cliId),
        workflow: { name: template?.name ?? item.templateId, icon: template?.icon, color: template?.color },
        since: time.text,
        sinceTitle: time.title,
      };
    });
}
