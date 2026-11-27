// Runs and retries of an item, from its attempts and the agent calls recorded for them.
//
// An attempt is one agent session plus its checks. It counts when it passed or failed; one whose run
// failed (quota, crash, timeout) or was stopped is not the work's attempt, but its tokens still count.
// A run is one step done once on an item: it closes at each passed attempt and holds the counted
// attempts since the last pass, with the attempts that did not count. A retry is a counted attempt
// that is not the first one of its step on the item.
import type { AgentCallUsage, AgentId, AttemptResult, DoneWhen, ItemId, RepoId, StepId } from "../../kernel/schemas/index.js";

export interface RunAttempt {
  readonly attempt: number;
  readonly result?: AttemptResult;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly checks: readonly { readonly command: string; readonly passed: boolean }[];
}

export interface RunStep {
  readonly id: StepId;
  readonly name: string;
  /** Unknown when the item's template record could not be read. */
  readonly agentId?: AgentId;
  readonly doneWhen?: DoneWhen;
  readonly attempts: readonly RunAttempt[];
}

/** An item as the usage report reads it: its steps with their attempts, and the calls recorded for them. */
export interface RunItem {
  readonly itemId: ItemId;
  readonly title: string;
  /** The workflow key exactly as the item record carries it. */
  readonly templateId: string;
  readonly repoIds: readonly RepoId[];
  readonly steps: readonly RunStep[];
  readonly calls: readonly AgentCallUsage[];
}

export interface Run {
  readonly item: RunItem;
  readonly step: RunStep;
  readonly agentId: AgentId;
  readonly cliId: AgentCallUsage["cliId"];
  /** The model of the passing attempt. */
  readonly model: string;
  /** When the passing attempt ended: the window the run belongs to. */
  readonly endedAt: number;
  /** The counted attempts of the run, the passing one last. */
  readonly attempts: readonly number[];
  /** Every call of the run's attempts, counted or not. */
  readonly calls: readonly AgentCallUsage[];
  readonly durationMs: number;
  /** On a step whose checks decide: the run is one counted attempt, the step's first on the item. */
  readonly firstTry: boolean | undefined;
}

/** Why an attempt was needed again. */
export type RetryCause = { readonly kind: "check"; readonly command: string } | { readonly kind: "review" };

export interface Retry {
  readonly item: RunItem;
  readonly step: RunStep;
  readonly attempt: number;
  readonly agentId: AgentId;
  readonly cliId: AgentCallUsage["cliId"];
  readonly calls: readonly AgentCallUsage[];
  /** When the attempt's last call ended. */
  readonly endedAt: number;
  /** Absent when no failed check or review asked for it. */
  readonly cause: RetryCause | undefined;
}

const counted = (attempt: RunAttempt): boolean => attempt.result === "passed" || attempt.result === "failed";
const total = (call: AgentCallUsage): number => call.tokens.input + call.tokens.output + call.tokens.cacheRead + call.tokens.cacheWrite;
const endOf = (attempt: RunAttempt, calls: readonly AgentCallUsage[]): number => attempt.endedAt ?? Math.max(attempt.startedAt, ...calls.map((call) => call.endedAt));

/** The calls of each attempt of the step, by attempt number. */
function callsOf(item: RunItem, step: RunStep): Map<number, AgentCallUsage[]> {
  const byAttempt = new Map<number, AgentCallUsage[]>();
  for (const call of item.calls) {
    if (call.stepId !== step.id) continue;
    const list = byAttempt.get(call.attempt) ?? [];
    list.push(call);
    byAttempt.set(call.attempt, list);
  }
  return byAttempt;
}

/** The call that carries a set of calls: the one with most tokens. */
const mainCall = (calls: readonly AgentCallUsage[]): AgentCallUsage | undefined => calls.reduce<AgentCallUsage | undefined>((best, call) => (best === undefined || total(call) > total(best) ? call : best), undefined);

export function runsOf(item: RunItem): Run[] {
  const runs: Run[] = [];
  for (const step of item.steps) {
    const calls = callsOf(item, step);
    let pending: RunAttempt[] = [];
    for (const attempt of [...step.attempts].sort((a, b) => a.attempt - b.attempt)) {
      pending.push(attempt);
      if (attempt.result !== "passed") continue;
      const own = pending.flatMap((a) => calls.get(a.attempt) ?? []);
      const main = mainCall(calls.get(attempt.attempt) ?? own);
      if (main !== undefined) {
        const countedAttempts = pending.filter(counted).map((a) => a.attempt);
        runs.push({
          item,
          step,
          agentId: main.agentId,
          cliId: main.cliId,
          model: main.model,
          endedAt: endOf(attempt, calls.get(attempt.attempt) ?? []),
          attempts: countedAttempts,
          calls: own,
          durationMs: pending.reduce((sum, a) => sum + Math.max(0, endOf(a, calls.get(a.attempt) ?? []) - a.startedAt), 0),
          firstTry: step.doneWhen === "checks pass" ? countedAttempts.length === 1 && countedAttempts[0] === 1 : undefined,
        });
      }
      pending = [];
    }
  }
  return runs;
}

/** Why a failed attempt of a step needs another: the reviewer's verdict, or the first check that failed. */
function failureCause(step: RunStep, attempt: RunAttempt): RetryCause | undefined {
  if (step.doneWhen === "reviewer approves") return { kind: "review" };
  if (step.doneWhen === "checks pass") {
    const failed = attempt.checks.find((check) => !check.passed);
    if (failed !== undefined) return { kind: "check", command: failed.command };
  }
  return undefined;
}

export function retriesOf(item: RunItem): Retry[] {
  const retries: Retry[] = [];
  for (const step of item.steps) {
    const calls = callsOf(item, step);
    const attempts = [...step.attempts].sort((a, b) => a.attempt - b.attempt).filter(counted);
    for (const [n, attempt] of attempts.entries()) {
      const previous = attempts[n - 1];
      // The first counted attempt of a step is the work, not a retry.
      if (previous === undefined) continue;
      const own = calls.get(attempt.attempt) ?? [];
      const main = mainCall(own);
      if (main === undefined) continue;
      let cause: RetryCause | undefined;
      if (previous.result === "failed") cause = failureCause(step, previous);
      else {
        // The step passed and was sent back: what failed in another step in between sent it.
        const from = endOf(previous, calls.get(previous.attempt) ?? []);
        const sender = item.steps
          .filter((other) => other !== step)
          .flatMap((other) => other.attempts.filter((a) => a.result === "failed" && a.endedAt !== undefined && a.endedAt >= from && a.endedAt <= attempt.startedAt).map((a) => ({ step: other, attempt: a })))
          .sort((a, b) => b.attempt.endedAt! - a.attempt.endedAt!)[0];
        if (sender !== undefined) cause = failureCause(sender.step, sender.attempt);
      }
      retries.push({ item, step, attempt: attempt.attempt, agentId: main.agentId, cliId: main.cliId, calls: own, endedAt: endOf(attempt, own), cause });
    }
  }
  return retries;
}
