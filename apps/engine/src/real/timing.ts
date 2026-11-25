// How long an item's work took, from the attempt and decision times its log records: each ended
// attempt, each ended step and the ended item, without the time spent waiting for the engineer or
// while the engine was down, and that waiting time per step apart. A pure function of the stored item, so the figures are the
// same after an engine restart.
import type { AttemptRecord, StoredItem, StoredStep } from "@tokama/core";

/** From, to (UTC epoch ms). */
type Span = readonly [number, number];

/** The length of the part of `spans` (which may overlap) that falls within `from` to `to`. */
export function overlapMs(spans: readonly Span[], from: number, to: number): number {
  const clipped = spans.map(([a, b]): Span => [Math.max(a, from), Math.min(b, to)]).filter(([a, b]) => b > a);
  clipped.sort((x, y) => x[0] - y[0]);
  let total = 0;
  let end = -Infinity;
  for (const [a, b] of clipped) {
    if (b <= end) continue;
    total += b - Math.max(a, end);
    end = b;
  }
  return total;
}

/**
 * The time each question waited for the engineer: from asking to the answer. A question still
 * open when the item ended stops at the end; one still open on a live item has no end yet.
 */
const waitSpans = (item: StoredItem, stepId?: string): Span[] =>
  item.decisions
    .filter((decision) => stepId === undefined || decision.stepId === stepId)
    .map((decision): Span => [decision.askedAt, decision.resolved?.at ?? item.outcome?.at ?? Infinity]);

/**
 * An attempt that an engine restart ended: its end is when the engine came back, maybe the next
 * day, so its span is not working time.
 */
const cutByRestart = (attempt: AttemptRecord): boolean => attempt.failure === "engine_restart";

/** An ended attempt's working time: start to end, without the time it waited for you. None for one a restart ended. */
export function attemptMs(item: StoredItem, attempt: AttemptRecord): number | undefined {
  if (attempt.endedAt === undefined || cutByRestart(attempt)) return undefined;
  return Math.max(0, attempt.endedAt - attempt.startedAt - overlapMs(waitSpans(item), attempt.startedAt, attempt.endedAt));
}

const ENDED_STEP = new Set<StoredStep["state"]>(["passed", "failed", "stopped"]);

/** An ended step's working time (its attempts added up) and, for any step, the time it waited for you. */
export function stepTimes(item: StoredItem, step: StoredStep): { durationMs?: number; waitedMs?: number } {
  const worked = step.attempts.flatMap((attempt) => attemptMs(item, attempt) ?? []);
  const waits = waitSpans(item, step.id).filter(([, end]) => end !== Infinity);
  const waited = overlapMs(waits, -Infinity, Infinity);
  return {
    ...(ENDED_STEP.has(step.state) && worked.length > 0 && { durationMs: worked.reduce((sum, ms) => sum + ms, 0) }),
    ...(waited > 0 && { waitedMs: waited }),
  };
}

/**
 * An ended item's agent and check time: its first attempt's start to its end, without the time it
 * waited for you or spent in attempts a restart ended.
 */
export function itemMs(item: StoredItem): number | undefined {
  const end = item.outcome?.at;
  const attempts = item.steps.flatMap((step) => step.attempts);
  if (end === undefined || attempts.length === 0) return undefined;
  const from = Math.min(...attempts.map((attempt) => attempt.startedAt));
  const restarts = attempts.filter(cutByRestart).map((attempt): Span => [attempt.startedAt, attempt.endedAt ?? end]);
  return Math.max(0, end - from - overlapMs([...waitSpans(item), ...restarts], from, end));
}
