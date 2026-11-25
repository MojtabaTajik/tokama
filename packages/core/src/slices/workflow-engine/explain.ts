// Why the engine stopped at a step and asks: for the card of a step that failed or reached a
// limit. Worked out from the item record alone, so an old log explains its open question too. The
// question's kind and choices tell the cases apart: Retry once more is the attempt limit, Run one
// more round the round-trip cap, Retry step after a work failure the same failure twice or a
// template that asks, and a run failure inside an attempt names its failure.
import type { AttemptRecord, Decision, StopThen, StoredDecision, StoredItem, StoredStep, TemplateRecord, TemplateStepDef } from "../../kernel/schemas/index.js";
import { cutText } from "../../kernel/text/index.js";
import { roundAttempts } from "../items/index.js";
import { attemptLimit, ONE_MORE_ID, ONE_MORE_ROUND_ID, RETRY_ID, sameFailureTwice } from "./counters.js";

export type Stopped = NonNullable<Decision["stopped"]>;

const WHY_MAX = 500;

/** The step's latest ended attempt: the one the card is about. */
export const lastEnded = (step: StoredStep): AttemptRecord | undefined => step.attempts.filter((a) => a.endedAt !== undefined).at(-1);

/** The card for an open question about a step that stopped; undefined for other questions. */
export function explainStop(item: StoredItem, decision: StoredDecision, template: TemplateRecord | undefined): Stopped | undefined {
  if (decision.stepId === undefined) return undefined;
  const step = item.steps.find((s) => s.id === decision.stepId);
  const def = template?.steps.find((s) => s.id === decision.stepId);
  if (step === undefined) return undefined;
  const last = lastEnded(step);
  const choices = new Set(decision.choices.map((c) => c.id));
  const name = def?.name ?? step.id;

  if (decision.kind === "run_failure") {
    // Only a run failure of an attempt, written with the question (events written together share
    // a time): setup, the review tree and a crash between attempts have no attempt to explain.
    if (last?.result !== "run_failed" || last.endedAt !== decision.askedAt) return undefined;
    return { limit: false, then: thenOf(item, step, last), why: cut(runFailureWhy(last)) };
  }
  if (decision.kind !== "after_failure" || last === undefined) return undefined;
  const then = thenOf(item, step, last);
  if (choices.has(ONE_MORE_ID)) return { limit: true, then, why: cut(limitWhy(item, step, def, name, then)) };
  if (choices.has(ONE_MORE_ROUND_ID)) {
    const target = backTarget(def);
    const targetName = template?.steps.find((s) => s.id === target)?.name ?? target ?? "the earlier step";
    const trips = step.sentBack ?? 0;
    return { limit: true, then, why: cut(`${name} sent the work back to ${targetName} ${times(trips)}, so Tokama asks before another round.`) };
  }
  if (choices.has(RETRY_ID)) {
    const same = sameFailureTwice(step);
    return { limit: false, then, why: cut(same ?? `The template asks you when ${name} fails.`) };
  }
  return undefined;
}

/** "Review may run once per round, so it has not checked the fix." */
function limitWhy(item: StoredItem, step: StoredStep, def: TemplateStepDef | undefined, name: string, then: StopThen): string {
  if (def === undefined) return `${name} reached its limit of attempts.`;
  const limit = attemptLimit(item, step, def.maxAttempts);
  const head = `${name} may run ${times(limit)} per round`;
  if (then.kind === "later" && then.result === "passed") return `${head}, so it has not checked the fix.`;
  const counted = roundAttempts(step).filter((a) => a.result !== "run_failed");
  if (counted.length > 0 && counted.every((a) => a.result === "failed" && a.checks.some((c) => !c.passed))) {
    return `${head}, and ${counted.length === 1 ? "its attempt" : `all ${counted.length} attempts`} ended with failed checks.`;
  }
  return `${head}.`;
}

function runFailureWhy(attempt: AttemptRecord): string {
  switch (attempt.failure) {
    case "timeout":
      return attempt.endedAt === undefined ? "The agent call ran too long." : `The agent call ran for ${minutes(attempt.endedAt - attempt.startedAt)} (the limit).`;
    case "quota":
      return "The agent's plan has no quota left.";
    case "rate_limit":
      return "The agent's CLI hit a rate limit.";
    case "auth":
      return "The agent's CLI is not logged in.";
    case "engine_restart":
      return "The engine stopped while the step ran.";
    default:
      return attempt.detail?.trim() || "The agent call failed.";
  }
}

/**
 * What ran after the attempt: its own failed checks, else the latest attempt of another step that
 * started after it ended, else nothing.
 */
function thenOf(item: StoredItem, step: StoredStep, last: AttemptRecord): StopThen {
  const failed = last.checks.filter((c) => !c.passed);
  if (failed.length > 0) return { kind: "checks_failed", failed: failed.slice(0, 20).map((c) => c.command), total: Math.max(failed.length, last.checks.length) };
  let latest: { index: number; attempt: AttemptRecord } | undefined;
  item.steps.forEach((other, index) => {
    if (other.id === step.id) return;
    for (const attempt of other.attempts) {
      // Started once it ended. Separate writes can share a millisecond, so the same time counts as
      // after, unless the attempt also started no later than this one (a log written at one time).
      if (attempt.endedAt === undefined || attempt.result === undefined || attempt.startedAt < last.endedAt! || attempt.startedAt <= last.startedAt) continue;
      if (latest === undefined || attempt.endedAt >= latest.attempt.endedAt!) latest = { index, attempt };
    }
  });
  if (latest === undefined) return { kind: "none" };
  const { index, attempt } = latest;
  return {
    kind: "later",
    stepIndex: index,
    attempt: attempt.attempt,
    result: attempt.result!,
    ...(attempt.checks.length > 0 && { checks: { passed: attempt.checks.filter((c) => c.passed).length, total: attempt.checks.length } }),
  };
}

/** The step a step's rule sends the work back to. */
const backTarget = (def: TemplateStepDef | undefined): string | undefined => {
  const rule = def === undefined ? undefined : def.doneWhen === "reviewer approves" ? def.ifChangesRequested : def.ifFailed;
  return rule?.action === "back" ? rule.stepId : undefined;
};

/** A duration in whole minutes, at least 1: `90 m`. */
export const minutes = (ms: number): string => `${Math.max(1, Math.round(ms / 60_000))} m`;

const times = (n: number): string => (n === 1 ? "once" : `${n} times`);
const cut = (text: string): string => cutText(text, WHY_MAX);
