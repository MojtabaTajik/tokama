// Restart recovery: a step that was running when the engine stopped becomes a run failure (not
// counted as an attempt), and the item asks Retry step / Stop. Open decisions need no work: they
// are in the log, so the fold restores them.
//
// Leftover processes are killed before the failure is written. If the engine dies in between,
// the next start finds the attempt still open and tries again; written first, a crash would
// leave the attempt closed and its agent running with nothing left to kill it.
import { systemClock, type Clock } from "../../kernel/clock/index.js";
// leftover.js, not the process index, so the public entry does not load the runner.
import { killLeftoverTree, type LeftoverOutcome, type ProcessTable } from "../../kernel/process/leftover.js";
import { DecisionIdSchema, newId, type ItemEventBody, type ItemId, type StepId } from "../../kernel/schemas/index.js";
import { openAttempt, openDecisions } from "./fold.js";
import type { ItemStore, StoreError } from "./store.js";

export const RUN_FAILURE_CHOICES = [
  { id: "retry_step", label: "Retry step" },
  { id: "stop", label: "Stop" },
] as const;

export interface RecoveryOptions {
  readonly table: ProcessTable;
  readonly clock?: Clock;
  /** Time between SIGTERM and SIGKILL for a leftover tree. */
  readonly graceMs?: number;
  /** Stops recovery before the next kill or write; items not reached yet are left for the next start. */
  readonly signal?: AbortSignal;
}

export type KillReport =
  | LeftoverOutcome
  | { readonly kind: "skipped"; readonly reason: "other_host" }
  | { readonly kind: "failed"; readonly message: string };

export interface RecoveredItem {
  readonly itemId: ItemId;
  readonly stepId: StepId;
  readonly kills: ReadonlyArray<{ readonly pid: number; readonly outcome: KillReport }>;
  /** Set when the failure could not be written. */
  readonly error?: StoreError;
}

export async function recoverItems(store: ItemStore, options: RecoveryOptions): Promise<RecoveredItem[]> {
  const clock = options.clock ?? systemClock;
  const recovered: RecoveredItem[] = [];
  for (const item of store.list()) {
    if (options.signal?.aborted) break;
    if (item.deleted || item.outcome !== undefined || item.hostId !== store.hostId) continue;
    // An open attempt was running, even if it had asked a question meanwhile; a running step
    // without one was between attempts.
    const open = openAttempt(item);
    const step = open?.step ?? item.steps.find((s) => s.id === item.currentStepId);
    if (step === undefined || (open === undefined && step.state !== "running")) continue;

    const kills: Array<{ pid: number; outcome: KillReport }> = [];
    for (const proc of open?.attempt.processes ?? []) {
      let outcome: KillReport;
      if (proc.hostId !== store.hostId) outcome = { kind: "skipped", reason: "other_host" };
      else {
        try {
          outcome = await killLeftoverTree(proc, { table: options.table, clock, ...(options.graceMs !== undefined && { graceMs: options.graceMs }) });
        } catch (error) {
          outcome = { kind: "failed", message: String(error) };
        }
      }
      kills.push({ pid: proc.pid, outcome });
    }

    // An attempt that waits on a failed setup has no process running: the open question still
    // holds, and its answers (run again, send the output) work after a restart as before it.
    if (open !== undefined && openDecisions(item).some((d) => d.setupFailed !== undefined && d.stepId === open.step.id)) {
      recovered.push({ itemId: item.id, stepId: step.id, kills });
      continue;
    }
    const events: ItemEventBody[] = [];
    if (open !== undefined) {
      events.push({
        type: "attempt_ended",
        stepId: open.step.id,
        attempt: open.attempt.attempt,
        result: "run_failed",
        failure: "engine_restart",
        detail: "The engine stopped while this attempt ran.",
      });
    }
    events.push({
      type: "decision_opened",
      decisionId: DecisionIdSchema.parse(newId("decision", clock.now())),
      kind: "run_failure",
      stepId: step.id,
      choices: RUN_FAILURE_CHOICES.map((choice) => ({ ...choice })),
      detail: "The engine stopped while this step ran. Retry the step, or stop the item.",
    });
    // Aborted during the kills: write nothing, the attempt stays open for the next start.
    if (options.signal?.aborted) break;
    const appended = store.append(item.id, events);
    recovered.push({ itemId: item.id, stepId: step.id, kills, ...(!appended.ok && { error: appended.error }) });
  }
  return recovered;
}
