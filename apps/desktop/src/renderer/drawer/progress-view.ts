// What a running item shows to say it is working: the step track, the live activity line (who
// works, the latest action, the time in the attempt, "quiet for 2 m"), and how long finished work
// took. Pure functions that take the clock as an argument, tested without React. Every state comes
// as a symbol and a word, so colour is never the only signal. There is no percent: Tokama cannot
// know how long an agent will take.
import type { AgentSummary, AttemptSummary, ItemActivity, ItemRecord, StepRecord } from "@tokama/core";
import { formatDuration } from "../format/duration.js";
import { stepAgent, stepMark } from "./describe.js";
import { markOf, type Tone } from "../ui/status.js";

/** No agent event for this long, with no tool running, reads as quiet. */
export const QUIET_AFTER_MS = 120_000;

/**
 * How long the agent has been quiet: core's `quietForMs`, restated because the renderer may import
 * only types from core. Undefined while a tool runs, however long: a long test run is work.
 */
export function quietForMs(activity: Pick<ItemActivity, "lastEventAt" | "toolRunning">, now: number): number | undefined {
  if (activity.toolRunning !== null) return undefined;
  const quiet = now - activity.lastEventAt;
  return quiet >= QUIET_AFTER_MS ? quiet : undefined;
}

export interface TrackStep {
  readonly name: string;
  readonly symbol: string;
  readonly word: string;
  readonly tone: Tone;
  /** Working right now: the mark breathes, and the line into it carries a slow light. */
  readonly live: boolean;
  /** The step the item is at: shown in full, the other names give way first. */
  readonly current: boolean;
  /** Needs you and failed steps say so in words next to the name. */
  readonly says?: string;
}

/** The template's steps in order, each with its mark: ✓ done, ● running, ◐ checking, ⏸ needs you, ✕ failed, ○ not started, – not run. */
export function trackOf(item: Pick<ItemRecord, "state" | "steps">): { readonly steps: readonly TrackStep[]; readonly label: string } {
  const current = item.steps.findIndex((step) => step.state === "running" || step.state === "needs_you" || step.state === "failed" || step.state === "stopped");
  const stoppedAt = item.steps.findIndex((step) => step.state === "failed" || step.state === "stopped");
  const ended = item.state === "done" || item.state === "failed" || item.state === "stopped";
  const steps = item.steps.map((step, index): TrackStep => {
    const base = { name: step.name, current: index === current, live: false };
    const mark = stepMark(step.state);
    switch (step.state) {
      case "passed":
        return { ...base, symbol: mark.symbol, word: "done", tone: mark.tone };
      case "running":
        // Checking is Tokama running the checks: its own mark, still live.
        return step.stage === "verifying"
          ? { ...base, symbol: markOf("checking").symbol, word: markOf("checking").word, tone: mark.tone, live: item.state === "running" }
          : { ...base, symbol: mark.symbol, word: mark.word, tone: mark.tone, live: item.state === "running" };
      case "needs_you":
      case "failed":
      case "stopped":
        return { ...base, symbol: mark.symbol, word: mark.word, tone: mark.tone, says: mark.word };
      case "pending":
        // Steps after a failure, or left when the item ended, did not run.
        return (stoppedAt >= 0 && index > stoppedAt) || ended ? { ...base, symbol: "–", word: "not run", tone: mark.tone } : { ...base, symbol: mark.symbol, word: "not started", tone: mark.tone };
    }
  });
  return { steps, label: `Steps: ${steps.map((step) => `${step.name} ${step.word}`).join(", ")}` };
}

/** The attempt of a step that runs now: the last one, while it has no result. */
export const runningAttempt = (step: Pick<StepRecord, "attempts"> | undefined): AttemptSummary | undefined => {
  const last = step?.attempts?.at(-1);
  return last !== undefined && last.result === undefined ? last : undefined;
};

export interface ActivityView {
  /** The step's agent, or Tokama while it runs the checks. Never cut. */
  readonly who: string;
  /** The latest action, in words; `head` gives way first when space runs out, `tail` (the file name, the end of a command) stays. */
  readonly action: { readonly full: string; readonly head: string; readonly tail: string };
  /** Time in the current attempt, or the running command's own time; undefined when the engine sent no start. */
  readonly elapsed?: string;
  /** "quiet for 3 m": no event for 2 minutes or more while no tool runs. */
  readonly quiet?: string;
}

/** The last 16 characters of a command stay whole when its line is cut. */
const COMMAND_TAIL = 16;

/**
 * Splits an action where it may be cut: after the last `/` or ` · ` (the file name stays), else at
 * the word that starts its last 16 characters (the end of a command stays).
 */
export function splitAction(label: string): { readonly head: string; readonly tail: string } {
  const at = Math.max(label.lastIndexOf("/") + 1, label.lastIndexOf(" · ") >= 0 ? label.lastIndexOf(" · ") + 3 : 0);
  if (at > 0 && at < label.length) return { head: label.slice(0, at), tail: label.slice(at) };
  const space = label.lastIndexOf(" ", Math.max(0, label.length - COMMAND_TAIL));
  const cut = space > 0 ? space : label.indexOf(" ");
  return cut > 0 ? { head: label.slice(0, cut + 1), tail: label.slice(cut + 1) } : { head: "", tail: label };
}

/**
 * The activity line of a running item at `now`; undefined when the item does not run a step now
 * (it waits, or ended). Activity for another step or attempt is old and is not shown.
 */
export function activityView(item: Pick<ItemRecord, "state" | "steps">, activity: ItemActivity | null | undefined, agents: readonly AgentSummary[], now: number): ActivityView | undefined {
  if (item.state !== "running") return undefined;
  const index = item.steps.findIndex((step) => step.state === "running");
  const step = item.steps[index];
  if (step === undefined) return undefined;
  const attempt = runningAttempt(step);
  const fresh = activity !== null && activity !== undefined && activity.stepIndex === index && (attempt === undefined || activity.attempt === attempt.attempt) ? activity : undefined;
  const tokama = fresh?.by === "tokama" || (fresh === undefined && step.stage === "verifying") || step.agentId === undefined;
  const who = tokama ? "Tokama" : stepAgent(step, agents).name;
  const label = fresh?.toolRunning?.label ?? fresh?.lastAction.label ?? (step.stage === "verifying" ? "running the checks" : "working");
  const since = fresh?.toolRunning?.startedAt ?? attempt?.startedAt;
  const quiet = fresh === undefined ? undefined : quietForMs(fresh, now);
  return {
    who,
    action: { full: label, ...splitAction(label) },
    ...(since !== undefined && { elapsed: formatDuration(now - since) }),
    ...(quiet !== undefined && { quiet: `quiet for ${Math.floor(quiet / 60_000)} m` }),
  };
}

/** "4 m 12 s" after a finished attempt's line; nothing while it runs. */
export const attemptTime = (attempt: Pick<AttemptSummary, "durationMs">): string | undefined => (attempt.durationMs === undefined ? undefined : formatDuration(attempt.durationMs));

/** A finished step's working time, and the time it waited for you apart: ["4 m 12 s", "waited 6 m for you"]. */
export function stepTimes(step: Pick<StepRecord, "durationMs" | "waitedMs">): string[] {
  return [...(step.durationMs === undefined ? [] : [formatDuration(step.durationMs)]), ...(step.waitedMs === undefined ? [] : [`waited ${formatDuration(step.waitedMs, "coarse")} for you`])];
}

/** An ended item's total next to its clock time: "12 m". */
export const itemTotal = (item: Pick<ItemRecord, "durationMs">): string | undefined => (item.durationMs === undefined ? undefined : formatDuration(item.durationMs, "coarse"));
