// The counts the run loop decides by, worked out from the item record alone: a step's attempt
// limit with the extra attempts the engineer granted, the same failure twice in a row, and the
// time budget. Pure functions, so a restart gets the same answers from the same log.
import type { AttemptRecord, StoredDecision, StoredItem, StoredStep } from "../../kernel/schemas/index.js";

export const RETRY_ID = "retry_step";
export const ONE_MORE_ID = "one_more_attempt";
export const CONTINUE_ID = "continue";

const counted = (attempt: AttemptRecord) => attempt.result !== "run_failed";

/**
 * An answer that runs the step again: Retry step or Retry once more after a failure, or Run again
 * after a plan in logs from before Request changes replaced it (Request changes counts as usual).
 */
const runsAgain = (d: StoredDecision) =>
  d.resolved !== undefined &&
  ((d.kind === "after_failure" && (d.resolved.choice === RETRY_ID || d.resolved.choice === ONE_MORE_ID)) ||
    (d.kind === "plan_approval" && d.resolved.choice === RETRY_ID));

/**
 * The step's attempt limit: `max_attempts`, plus one for each answer that ran the step again while
 * it was at its limit. Events written together share a time, so an attempt that ended when the
 * question was asked counts as before it.
 */
export function attemptLimit(item: StoredItem, step: StoredStep, maxAttempts: number): number {
  let limit = maxAttempts;
  const answers = item.decisions.filter((d) => d.stepId === step.id && runsAgain(d)).sort((a, b) => a.askedAt - b.askedAt);
  for (const answer of answers) {
    const before = step.attempts.filter((a) => counted(a) && a.endedAt !== undefined && a.endedAt <= answer.askedAt).length;
    if (before >= limit) limit++;
  }
  return limit;
}

export const countedAttempts = (step: StoredStep): number => step.attempts.filter(counted).length;

/**
 * The words for the same failure twice in a row: the last two counted attempts failed on the same
 * first failing check command with the same exit status. Undefined otherwise.
 */
export function sameFailureTwice(step: StoredStep): string | undefined {
  const [before, last] = step.attempts.filter(counted).slice(-2);
  if (before?.result !== "failed" || last?.result !== "failed") return undefined;
  const a = before.checks.find((check) => !check.passed);
  const b = last.checks.find((check) => !check.passed);
  if (a === undefined || b === undefined || a.command !== b.command || a.exitCode !== b.exitCode) return undefined;
  return `\`${b.command}\` failed with exit status ${b.exitCode ?? "none (signal)"} twice in a row.`;
}

/**
 * When an attempt stopped using time. An attempt the engine's restart ended ran only until its last
 * recorded event (its start, a process start, a check result): the downtime is not work.
 */
function attemptEnd(attempt: AttemptRecord, now: number): number {
  if (attempt.failure !== "engine_restart") return attempt.endedAt ?? now;
  return Math.max(attempt.startedAt, ...attempt.processes.map((p) => p.startedAt), ...attempt.checks.map((c) => c.at));
}

/** Time spent in attempts up to `until`, less the time a question asked during one waited. */
export function budgetUsedMs(item: StoredItem, until: number): number {
  let used = 0;
  for (const step of item.steps) {
    for (const attempt of step.attempts) {
      if (attempt.startedAt >= until) continue;
      const end = Math.min(attemptEnd(attempt, until), until);
      const waited = item.decisions
        .filter((d) => d.stepId === step.id && d.askedAt >= attempt.startedAt && d.askedAt < end)
        .reduce((sum, d) => sum + Math.max(0, Math.min(d.resolved?.at ?? until, end) - d.askedAt), 0);
      used += Math.max(0, end - attempt.startedAt - waited);
    }
  }
  return used;
}

/** The time the item may use: one budget, or one budget on top of what it had used when the engineer last chose Continue. */
export function budgetAllowedMs(item: StoredItem, budgetMs: number): number {
  const last = item.decisions
    .filter((d) => d.kind === "budget" && d.resolved?.choice === CONTINUE_ID)
    .reduce<number | undefined>((at, d) => Math.max(at ?? 0, d.resolved!.at), undefined);
  return last === undefined ? budgetMs : budgetUsedMs(item, last) + budgetMs;
}
