// The item record is a pure fold over its events. `applyEvent` also guards the log: a writer
// folds each new event before appending it, so an event that does not fit the item's history
// (an attempt for a step the item is not in, a second answer to a decision) is never written.
import { err, ok, type Result } from "../../kernel/result/index.js";
import {
  STORED_ITEM_SCHEMA_VERSION,
  type AttemptRecord,
  type ItemEvent,
  type ItemState,
  type StoredDecision,
  type StoredItem,
  type StoredStep,
} from "../../kernel/schemas/index.js";

export interface FoldError {
  readonly seq: number;
  readonly message: string;
}

/** Folds a whole log. An empty log, or one that does not start with `item_created`, is an error. */
export function foldItem(events: readonly ItemEvent[]): Result<StoredItem, FoldError> {
  let item: StoredItem | undefined;
  for (const event of events) {
    const next = applyEvent(item, event);
    if (!next.ok) return next;
    item = next.value;
  }
  return item ? ok(item) : err({ seq: 0, message: "the log is empty" });
}

/** The item after one more event. Never changes `item`. */
export function applyEvent(item: StoredItem | undefined, event: ItemEvent): Result<StoredItem, FoldError> {
  const fail = (message: string) => err({ seq: event.seq, message });
  if (item === undefined) {
    if (event.type !== "item_created") return fail("the log must start with item_created");
    if (event.seq !== 0) return fail(`the first event must have seq 0, not ${event.seq}`);
    const ids = event.steps.map((step) => step.id);
    if (new Set(ids).size !== ids.length) return fail("step ids repeat");
    return ok({
      schemaVersion: STORED_ITEM_SCHEMA_VERSION,
      id: event.itemId,
      hostId: event.hostId,
      templateRef: event.templateRef,
      template: event.template,
      title: event.title,
      text: event.text,
      repoIds: event.repoIds,
      worktrees: [],
      state: "queued",
      steps: event.steps.map((step) => ({ id: step.id, state: "pending", attempts: [] })),
      decisions: [],
      deleted: false,
      createdAt: event.at,
      updatedAt: event.at,
      lastSeq: 0,
    });
  }

  if (event.itemId !== item.id) return fail(`event for ${event.itemId} in the log of ${item.id}`);
  if (event.seq !== item.lastSeq + 1) return fail(`expected seq ${item.lastSeq + 1}, got ${event.seq}`);
  if (item.deleted) return fail("nothing may follow a tombstone");
  if (item.outcome !== undefined && event.type !== "tombstone") return fail(`the item has ended; ${event.type} is not allowed`);

  const next = structuredClone(item);
  next.lastSeq = event.seq;
  next.updatedAt = Math.max(item.updatedAt, event.at);
  const step = "stepId" in event && event.stepId !== undefined ? next.steps.find((s) => s.id === event.stepId) : undefined;
  if ("stepId" in event && event.stepId !== undefined && step === undefined) return fail(`no step ${event.stepId}`);

  switch (event.type) {
    case "item_created":
      return fail("item_created may only be the first event");

    case "worktree_added":
      if (next.worktrees.some((w) => w.repoId === event.repoId)) return fail(`the item already has a worktree for ${event.repoId}`);
      next.worktrees.push({ repoId: event.repoId, branch: event.branch, dir: event.dir });
      break;

    case "step_started":
      if (openAttempt(next) !== undefined) return fail("an attempt is still running");
      next.currentStepId = event.stepId;
      must(step).state = "running";
      break;

    case "attempt_started": {
      const target = must(step);
      if (next.currentStepId !== target.id || target.state !== "running") return fail(`step ${target.id} is not running`);
      if (openAttempt(next) !== undefined) return fail("an attempt is still running");
      if (event.attempt !== target.attempts.length + 1) return fail(`expected attempt ${target.attempts.length + 1}, got ${event.attempt}`);
      target.attempts.push({ attempt: event.attempt, startedAt: event.at, processes: [], checks: [] });
      break;
    }

    case "process_started": {
      const running = runningAttempt(must(step), event.attempt);
      if (running === undefined) return fail(`attempt ${event.attempt} of ${event.stepId} is not running`);
      running.processes.push({ role: event.role, pid: event.pid, startedAt: event.at, bootTime: event.bootTime, hostId: event.hostId });
      break;
    }

    case "check_result": {
      const running = runningAttempt(must(step), event.attempt);
      if (running === undefined) return fail(`attempt ${event.attempt} of ${event.stepId} is not running`);
      running.checks.push({
        command: event.command,
        exitCode: event.exitCode,
        passed: event.passed,
        ...(event.outputFile !== undefined && { outputFile: event.outputFile }),
        at: event.at,
      });
      break;
    }

    case "attempt_ended": {
      const running = runningAttempt(must(step), event.attempt);
      if (running === undefined) return fail(`attempt ${event.attempt} of ${event.stepId} is not running`);
      if ((event.result === "run_failed") !== (event.failure !== undefined)) return fail("failure is given exactly when result is run_failed");
      running.endedAt = event.at;
      running.result = event.result;
      if (event.failure !== undefined) running.failure = event.failure;
      if (event.detail !== undefined) running.detail = event.detail;
      break;
    }

    case "step_ended": {
      const target = must(step);
      if (next.currentStepId !== target.id) return fail(`step ${target.id} is not the current step`);
      if (openAttempt(next) !== undefined) return fail("an attempt is still running");
      target.state = event.result;
      delete next.currentStepId;
      break;
    }

    case "decision_opened":
      if (next.decisions.some((d) => d.id === event.decisionId)) return fail(`decision ${event.decisionId} exists`);
      next.decisions.push({
        id: event.decisionId,
        kind: event.kind,
        ...(event.stepId !== undefined && { stepId: event.stepId }),
        askedAt: event.at,
        choices: event.choices,
        ...(event.detail !== undefined && { detail: event.detail }),
      });
      if (step !== undefined && step.state === "running") step.state = "needs_you";
      break;

    case "decision_resolved": {
      const decision = next.decisions.find((d) => d.id === event.decisionId);
      if (decision === undefined) return fail(`no decision ${event.decisionId}`);
      if (decision.resolved !== undefined) return fail(`decision ${event.decisionId} is already resolved`);
      if (!decision.choices.some((c) => c.id === event.choice)) return fail(`"${event.choice}" is not a choice of ${event.decisionId}`);
      decision.resolved = { choice: event.choice, at: event.at };
      const asked = next.steps.find((s) => s.id === decision.stepId);
      const stillOpen = next.decisions.some((d) => d.stepId === decision.stepId && d.resolved === undefined);
      if (asked !== undefined && asked.state === "needs_you" && !stillOpen) asked.state = "running";
      break;
    }

    case "item_ended": {
      if (openAttempt(next) !== undefined) return fail("an attempt is still running");
      const current = next.steps.find((s) => s.id === next.currentStepId);
      if (current !== undefined && (current.state === "running" || current.state === "needs_you")) current.state = "stopped";
      delete next.currentStepId;
      next.outcome = { kind: event.outcome, ...(event.detail !== undefined && { detail: event.detail }), at: event.at };
      break;
    }

    case "tombstone":
      if (openAttempt(next) !== undefined) return fail("an attempt is still running");
      next.deleted = true;
      break;
  }

  next.state = itemState(next);
  return ok(next);
}

/** The attempt of the current step that has started and not ended, if any. */
export function openAttempt(item: StoredItem): { step: StoredStep; attempt: AttemptRecord } | undefined {
  for (const step of item.steps) {
    const last = step.attempts.at(-1);
    if (last !== undefined && last.endedAt === undefined) return { step, attempt: last };
  }
  return undefined;
}

/** Decisions still waiting for the engineer. None once the item has ended. */
export function openDecisions(item: StoredItem): StoredDecision[] {
  if (item.outcome !== undefined) return [];
  return item.decisions.filter((d) => d.resolved === undefined);
}

/** Attempts that count toward `max_attempts`: run failures do not. */
export function countedAttempts(step: StoredStep): number {
  return step.attempts.filter((a) => a.result !== "run_failed").length;
}

function itemState(item: StoredItem): ItemState {
  if (item.outcome !== undefined) {
    if (item.outcome.kind === "failed") return "failed";
    if (item.outcome.kind === "stopped") return "stopped";
    return "done";
  }
  if (openDecisions(item).length > 0) return "needs_you";
  return item.steps.some((s) => s.state !== "pending") ? "running" : "queued";
}

function runningAttempt(step: StoredStep, attempt: number): AttemptRecord | undefined {
  const last = step.attempts.at(-1);
  return last !== undefined && last.attempt === attempt && last.endedAt === undefined ? last : undefined;
}

/** The step lookup above has already failed the event when the step is missing. */
function must(step: StoredStep | undefined): StoredStep {
  if (step === undefined) throw new Error("unreachable: step checked above");
  return step;
}
