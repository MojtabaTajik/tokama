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
  // A call that a stop ended reports its usage after the item ended; finish actions follow a done item.
  const finishEvent = FINISH_EVENTS.has(event.type);
  if (item.outcome !== undefined && event.type !== "tombstone" && event.type !== "usage_recorded" && !finishEvent) return fail(`the item has ended; ${event.type} is not allowed`);
  if (finishEvent && item.outcome?.kind !== "done") return fail(`${event.type} is allowed only once the item is done`);

  const next = structuredClone(item);
  next.lastSeq = event.seq;
  // Usage is accounting, not a change of the item's state: the board order stays.
  if (event.type !== "usage_recorded") next.updatedAt = Math.max(item.updatedAt, event.at);
  const step = "stepId" in event && event.stepId !== undefined ? next.steps.find((s) => s.id === event.stepId) : undefined;
  if ("stepId" in event && event.stepId !== undefined && step === undefined) return fail(`no step ${event.stepId}`);

  switch (event.type) {
    case "item_created":
      return fail("item_created may only be the first event");

    case "worktree_added":
      if (next.worktrees.some((w) => w.repoId === event.repoId)) return fail(`the item already has a worktree for ${event.repoId}`);
      next.worktrees.push({
        repoId: event.repoId,
        branch: event.branch,
        dir: event.dir,
        ...(event.baseCommit !== undefined && { baseCommit: event.baseCommit }),
        ...(event.pushUrl !== undefined && { pushUrl: event.pushUrl }),
      });
      break;

    case "baseline_recorded": {
      const worktree = next.worktrees.find((w) => w.repoId === event.repoId);
      if (worktree === undefined) return fail(`the item has no worktree for ${event.repoId}`);
      if (worktree.protectedDigest !== undefined) return fail(`the worktree for ${event.repoId} already has a baseline`);
      worktree.protectedDigest = event.protectedDigest;
      break;
    }

    case "step_started":
      if (openAttempt(next) !== undefined) return fail("an attempt is still running");
      if (next.currentStepId !== undefined && next.currentStepId !== event.stepId) return fail(`the item is still in step ${next.currentStepId}`);
      if (next.decisions.some((d) => d.stepId === event.stepId && d.resolved === undefined)) return fail(`step ${event.stepId} waits on a decision`);
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
      running.processes.push({
        role: event.role,
        pid: event.pid,
        startedAt: event.at,
        bootTime: event.bootTime,
        ...(event.pgid !== undefined && { pgid: event.pgid }),
        hostId: event.hostId,
      });
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
      if (event.tree !== undefined) {
        if (event.result !== "passed") return fail("tree is given only on a passed attempt");
        running.tree = event.tree;
      }
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
        ...(event.covers !== undefined && { covers: event.covers }),
        ...(event.tree !== undefined && { tree: event.tree }),
      });
      if (step !== undefined && step.state === "running") step.state = "needs_you";
      break;

    case "decision_resolved": {
      const decision = next.decisions.find((d) => d.id === event.decisionId);
      if (decision === undefined) return fail(`no decision ${event.decisionId}`);
      if (decision.resolved !== undefined) return fail(`decision ${event.decisionId} is already resolved`);
      if (!decision.choices.some((c) => c.id === event.choice)) return fail(`"${event.choice}" is not a choice of ${event.decisionId}`);
      decision.resolved = { choice: event.choice, ...(event.note !== undefined && { note: event.note }), at: event.at };
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
      if (event.commits !== undefined && event.outcome !== "done") return fail("commits are given only when the item is done");
      next.outcome = {
        kind: event.outcome,
        ...(event.detail !== undefined && { detail: event.detail }),
        ...(event.commits !== undefined && { commits: event.commits }),
        at: event.at,
      };
      break;
    }

    case "usage_recorded": {
      const { usage } = event;
      const target = next.steps.find((s) => s.id === usage.stepId);
      if (target === undefined) return fail(`no step ${usage.stepId}`);
      if (target.attempts.find((a) => a.attempt === usage.attempt) === undefined) return fail(`attempt ${usage.attempt} of ${usage.stepId} never started`);
      if (next.calls?.some((call) => call.callId === usage.callId)) return fail(`call ${usage.callId} is already recorded`);
      next.calls = [...(next.calls ?? []), usage];
      // The state is the item's own; usage does not change it.
      return ok(next);
    }

    case "finish_started": {
      if (next.worktrees.length === 0) return fail("the item has no worktree");
      const finish = next.finish ?? { worktreeRemoved: false };
      if (finish.running !== undefined) return fail(`${finish.running} is still running`);
      if (finish.worktreeRemoved) return fail("the worktree is gone");
      if (event.action !== "discard") {
        if ((next.outcome?.commits?.length ?? 0) === 0) return fail("the item has no commit");
        if (finish.merged !== undefined || finish.pullRequest !== undefined) return fail("the branch is merged or has a pull request");
      }
      delete finish.failed;
      delete finish.detail;
      next.finish = { ...finish, running: event.action };
      break;
    }

    case "merged":
    case "pr_opened":
    case "discarded":
    case "finish_failed": {
      const action = event.type === "finish_failed" ? event.action : RESULT_OF[event.type];
      const finish = next.finish;
      if (finish?.running !== action) return fail(`${event.type} without a running ${action}`);
      delete finish.running;
      finish.at = event.at;
      if (event.type === "merged") {
        finish.merged = { baseBranch: event.baseBranch, commit: event.commit, at: event.at };
        finish.worktreeRemoved = event.worktreeRemoved;
        if (event.detail !== undefined) finish.detail = event.detail;
      } else if (event.type === "pr_opened") {
        finish.pullRequest = { url: event.url, at: event.at };
      } else if (event.type === "discarded") {
        finish.worktreeRemoved = true;
      } else {
        finish.failed = {
          action,
          detail: event.detail,
          ...(event.reason !== undefined && { reason: event.reason }),
          ...(event.changes !== undefined && { changes: event.changes }),
          ...(event.gitDigest !== undefined && { gitDigest: event.gitDigest }),
          at: event.at,
        };
      }
      break;
    }

    case "git_changes_accepted": {
      const worktree = next.worktrees.find((w) => w.repoId === event.repoId);
      if (worktree === undefined) return fail(`the item has no worktree for ${event.repoId}`);
      if (next.finish?.running !== undefined) return fail(`${next.finish.running} is still running`);
      if (next.finish?.failed?.reason !== "steering_changed") return fail("no Finish action was refused for changed git config or hooks");
      worktree.protectedDigest = event.protectedDigest;
      delete next.finish.failed;
      break;
    }

    case "tombstone":
      if (next.finish?.running !== undefined) return fail(`${next.finish.running} is still running`);
      if (openAttempt(next) !== undefined) return fail("an attempt is still running");
      next.deleted = true;
      break;
  }

  next.state = itemState(next);
  return ok(next);
}

const FINISH_EVENTS: ReadonlySet<string> = new Set(["finish_started", "merged", "pr_opened", "discarded", "finish_failed", "git_changes_accepted"]);
const RESULT_OF = { merged: "merge", pr_opened: "pull_request", discarded: "discard" } as const;

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
