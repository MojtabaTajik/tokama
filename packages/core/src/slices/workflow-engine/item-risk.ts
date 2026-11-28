// The change of an item and its risk, worked out from the item's log alone: what a done task
// committed, or what the change waiting for your approval would commit. The facts are stored
// when they happen; the rating is made each time the item is read, so a changed rule needs no
// migration. An investigation, an item that changed nothing and a failed or stopped item have no
// risk.
import type { ChangeSummary, Risk, StoredItem, StoredStep, TemplateRecord, TemplateStepDef } from "../../kernel/schemas/index.js";
import { risk, type RiskFacts } from "../integrity/index.js";
import { countedAttempts, openDecisions } from "../items/index.js";
import { attemptLimit } from "./counters.js";
import { APPROVE_ID } from "./protect.js";

/** The ended attempt that decided the review: the last verdict of a reviewer step, with that step's agent. */
function lastVerdict(steps: readonly { readonly step: StoredStep; readonly def: TemplateStepDef | undefined }[]) {
  const verdicts = steps
    .filter(({ def }) => def?.doneWhen === "reviewer approves")
    .flatMap(({ step, def }) => step.attempts.filter((a) => a.endedAt !== undefined && (a.result === "passed" || a.result === "failed")).map((attempt) => ({ attempt, agentId: def!.agentId })));
  return verdicts.reduce<(typeof verdicts)[number] | undefined>((best, next) => (best === undefined || next.attempt.endedAt! >= best.attempt.endedAt! ? next : best), undefined);
}

function factsOf(item: StoredItem, template: TemplateRecord | undefined, change: ChangeSummary | undefined, tree: string | undefined): RiskFacts {
  const defs = new Map(template?.steps.map((def) => [def.id as string, def]));
  const steps = item.steps.map((step) => ({ step, def: defs.get(step.id) }));
  const verdict = lastVerdict(steps);
  // The agents that wrote the work: any agent step that is not a reviewer. A reviewer that is one of them is no second agent.
  const authors = new Set(steps.filter(({ def }) => def !== undefined && def.doneWhen !== "reviewer approves").map(({ def }) => def!.agentId as string));
  return {
    change,
    checked: tree !== undefined && item.steps.some((step) => step.attempts.some((a) => a.result === "passed" && a.tree === tree && a.checks.length > 0 && a.checks.every((check) => check.passed))),
    lastVerdict: verdict === undefined ? undefined : verdict.attempt.result === "passed" ? "approve" : "changes",
    secondReview: verdict !== undefined && verdict.attempt.result === "passed" && tree !== undefined && verdict.attempt.tree === tree && !authors.has(verdict.agentId as string),
    // The checks passed on the last run the step allowed, after an earlier run failed.
    lastAttempt: steps.some(({ step, def }) => {
      if (def?.doneWhen !== "checks pass" || step.state !== "passed") return false;
      const runs = countedAttempts(step);
      return runs > 1 && runs >= attemptLimit(item, step, def.maxAttempts);
    }),
    protectedApproved: item.decisions.some((d) => d.kind === "tamper" && d.resolved?.choice === APPROVE_ID),
  };
}

/** The change an item is judged by, and its risk; both absent when the item changed nothing or has no change to rate. */
export function itemRisk(item: StoredItem, template: TemplateRecord | undefined): { change?: ChangeSummary; risk?: Risk } {
  const { outcome } = item;
  if (outcome !== undefined) {
    if (outcome.kind !== "done") return {};
    if ((outcome.commits?.length ?? 0) === 0) return outcome.change === undefined ? {} : { change: outcome.change };
    // A done item with a commit and no recorded change is from before changes were recorded: never guessed.
    return { ...(outcome.change !== undefined && { change: outcome.change }), risk: risk(factsOf(item, template, outcome.change, outcome.tree)) };
  }
  const open = openDecisions(item)[0];
  if (open?.kind !== "plan_approval" || open.change === undefined || open.change.files === 0) return {};
  return { change: open.change, risk: risk(factsOf(item, template, open.change, open.tree)) };
}
