// What Tokama measured about a finished item, as short facts: the checks that passed, where a
// failed item stopped and why. The list rows and kanban cards show the facts as parts, with a
// symbol for what is not normal; the notifier says the same in words only. Type imports only: the
// renderer and the main process both use this file.
import type { ItemRecord } from "@tokama/core";

type FactItem = Pick<ItemRecord, "kind" | "steps" | "outcome">;

/** A symbol for a fact that is not normal, with its word for screen readers. */
export interface FactMark {
  readonly symbol: "✕" | "!";
  readonly tone: "fail" | "warn";
  readonly word: string;
}

/** One part of a facts line. The text is always words; a fact that is not normal also has a mark. */
export interface Fact {
  readonly text: string;
  readonly mark?: FactMark;
}

const FAILED_MARK: FactMark = { symbol: "✕", tone: "fail", word: "failed" };

export interface Checks {
  readonly passed: number;
  readonly total: number;
}

/**
 * The checks of an item: for each step the latest attempt that ran checks, added up. An earlier
 * attempt of a step is not counted again. Undefined when no step recorded a check, as for an item
 * from before checks were recorded.
 */
export function checksOf(item: Pick<ItemRecord, "steps">): Checks | undefined {
  let passed = 0;
  let total = 0;
  for (const step of item.steps) {
    const latest = step.attempts?.findLast((attempt) => attempt.checks.length > 0);
    if (latest === undefined) continue;
    total += latest.checks.length;
    passed += latest.checks.filter((check) => check.passed).length;
  }
  return total === 0 ? undefined : { passed, total };
}

const checksText = (checks: Checks): string => `checks ${checks.passed}/${checks.total}`;

/** "checks 3/3 passed", or undefined when there were none. */
export function checksWords(item: Pick<ItemRecord, "steps">): string | undefined {
  const checks = checksOf(item);
  return checks === undefined ? undefined : `${checksText(checks)} passed`;
}

/** The part for the checks: plain when all passed, with a ✕ when some did not. */
function checksFact(checks: Checks): Fact {
  return checks.passed === checks.total ? { text: checksText(checks) } : { text: checksText(checks), mark: FAILED_MARK };
}

/** The facts of a done item: its checks, or that it had none. An investigation has no checks to name. */
export function doneFacts(item: FactItem): Fact[] {
  const checks = checksOf(item);
  if (checks !== undefined) return [checksFact(checks)];
  return item.kind === "task" ? [{ text: "no checks" }] : [];
}

interface Failure {
  /** Where the item stopped, e.g. "Build, step 2 of 3"; undefined when it has no step. */
  readonly at: string | undefined;
  /** Why, e.g. "pnpm test failed 3 times"; undefined when nothing says. */
  readonly cause: string | undefined;
}

/** The step a failed item stopped at: the one that failed, else the one it was in. */
function stoppedStep(item: Pick<ItemRecord, "steps">): number {
  const failed = item.steps.findIndex((step) => step.state === "failed");
  return failed === -1 ? item.steps.findIndex((step) => step.state !== "passed") : failed;
}

function failureOf(item: FactItem): Failure {
  const index = stoppedStep(item);
  const step = item.steps[index];
  if (step === undefined) return { at: undefined, cause: item.outcome?.detail };
  const at = `${step.name}, step ${index + 1} of ${item.steps.length}`;
  const check = step.attempts?.at(-1)?.checks.find((candidate) => !candidate.passed)?.command;
  if (check === undefined) return { at, cause: step.detail ?? item.outcome?.detail };
  const runs = step.runs ?? step.attempts?.filter((attempt) => attempt.result !== "run_failed").length ?? 0;
  return { at, cause: `${check} failed${runs > 1 ? ` ${runs} times` : ""}` };
}

/** The facts of a failed item: why, where it stopped, and its checks when one did not pass. */
export function failedFacts(item: FactItem): Fact[] {
  const { at, cause } = failureOf(item);
  const checks = checksOf(item);
  return [
    ...(cause === undefined ? [] : [{ text: cause }]),
    ...(at === undefined ? [] : [{ text: `stopped at ${at}` }]),
    ...(checks === undefined || checks.passed === checks.total ? [] : [checksFact(checks)]),
  ];
}

/** The facts a row or card shows for an item: those of a done or failed one, none for any other. */
export function factsOf(item: FactItem & Pick<ItemRecord, "state">): Fact[] {
  if (item.state === "done") return doneFacts(item);
  return item.state === "failed" ? failedFacts(item) : [];
}

/** A failed item in one sentence of words, for a banner: "Stopped at Build, step 2 of 3: pnpm test failed 3 times". */
export function failureLine(item: FactItem): string {
  const { at, cause } = failureOf(item);
  if (at === undefined) return cause ?? "Stopped.";
  return cause === undefined ? `Stopped at ${at}` : `Stopped at ${at}: ${cause}`;
}
