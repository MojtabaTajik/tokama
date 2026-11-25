// What the card of a step that stopped says: the title, what its agent said, what ran after, and
// where its link goes. Pure functions over the engine's decision and the step's output, tested
// without React. Every line comes as words, with a symbol where it has a tone.
import type { Decision, OutputSummary, StepRecord } from "@tokama/core";
import { attemptMark } from "./describe.js";
import type { Mark } from "../ui/status.js";
import type { OutputState } from "./StepOutput.js";

type Stopped = NonNullable<Decision["stopped"]>;

const TEXT = {
  limit: (step: string) => `${step} stopped at its limit`,
  failed: (step: string) => `${step} failed`,
  said: (agent: string) => `${agent} said`,
  changes: (count: number) => (count === 0 ? "Asked for changes" : `Asked for changes · ${count} must fix`),
  approved: "Approved",
  more: (count: number, agent: string) => `${count} more in ${agent}’s notes`,
  plainLines: (step: string) => `First lines of the output. ${step} has no verdict format.`,
  noVerdict: "First lines, as written. Tokama found no verdict in this output.",
  asWritten: "First lines, as written.",
  empty: (agent: string) => `Nothing. The call ended before ${agent} wrote any output.`,
  loading: (agent: string) => `Loading what ${agent} said`,
  loadFailed: (message: string) => `Could not load the output: ${message}`,
  nothing: "Nothing ran after it.",
  checksFailed: (failed: readonly string[], total: number) => `Checks failed: ${failed.length} of ${total} (${failed.join(", ")}).`,
  fixed: (step: string, many: boolean, attempt: number, checks: boolean) => `${step} fixed ${many ? "them" : "it"} in attempt ${attempt}${checks ? " (checks passed)" : ""}.`,
  laterFailed: (step: string, attempt: number, checks: { passed: number; total: number } | undefined) =>
    `${step} failed in attempt ${attempt}${checks === undefined ? "" : ` (checks failed: ${checks.total - checks.passed} of ${checks.total})`}.`,
  laterRunFailed: (step: string, attempt: number) => `The run of ${step} failed in attempt ${attempt}.`,
  laterStopped: (step: string, attempt: number) => `${step} was stopped in attempt ${attempt}.`,
  notes: (agent: string) => `See ${agent}’s notes →`,
  log: "See the log →",
} as const;

export const stoppedTitle = (step: string, stopped: Stopped): string => (stopped.limit ? TEXT.limit(step) : TEXT.failed(step));
export const saidLabel = TEXT.said;

/** What the agent said, as the card shows it. */
export type Said =
  | { readonly kind: "verdict"; readonly head: string; readonly items: readonly { readonly ref?: string | undefined; readonly text: string }[]; readonly more?: string; readonly lines: readonly string[]; readonly note?: string }
  | { readonly kind: "lines"; readonly lines: readonly string[]; readonly note: string }
  | { readonly kind: "note"; readonly text: string };

/**
 * What the step's agent said in the attempt: from the engine's summary of the output. An output
 * without a summary (an older engine) shows its first lines as written.
 */
export function saidOf(state: OutputState, agent: string, step: string): Said {
  switch (state.kind) {
    case "loading":
      return { kind: "note", text: TEXT.loading(agent) };
    case "missing":
      return { kind: "note", text: TEXT.empty(agent) };
    case "failed":
      return { kind: "note", text: TEXT.loadFailed(state.message) };
    case "loaded":
      return fromSummary(state.output.summary ?? plainSummary(state.output.text), agent, step);
  }
}

function fromSummary(summary: OutputSummary, agent: string, step: string): Said {
  switch (summary.kind) {
    case "empty":
      return { kind: "note", text: TEXT.empty(agent) };
    case "lines":
      return { kind: "lines", lines: summary.lines, note: summary.format === "none" ? TEXT.plainLines(step) : TEXT.noVerdict };
    case "verdict": {
      const count = summary.mustFix.length + summary.more;
      return {
        kind: "verdict",
        head: summary.verdict === "approve" ? TEXT.approved : TEXT.changes(count),
        items: summary.mustFix,
        ...(summary.more > 0 && { more: TEXT.more(summary.more, agent) }),
        lines: summary.lines,
        ...(summary.lines.length > 0 && { note: TEXT.asWritten }),
      };
    }
  }
}

function plainSummary(text: string): OutputSummary {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(0, 2);
  return lines.length === 0 ? { kind: "empty" } : { kind: "lines", format: "none", lines };
}

/** The number of must-fix items the agent named, for "fixed it" or "fixed them". */
const mustFixCount = (state: OutputState | undefined): number =>
  state?.kind === "loaded" && state.output.summary?.kind === "verdict" ? state.output.summary.mustFix.length + state.output.summary.more : 0;

/** Nothing ran after the attempt. */
const NOTHING: Mark = { symbol: "–", word: "nothing", tone: "muted" };

/** What ran after the step's attempt, with the mark of how it ended. */
export function thenLine(then: Stopped["then"], steps: readonly Pick<StepRecord, "name">[], said: OutputState | undefined): { readonly mark: Mark; readonly text: string } {
  switch (then.kind) {
    case "none":
      return { mark: NOTHING, text: TEXT.nothing };
    case "checks_failed":
      return { mark: attemptMark("failed"), text: TEXT.checksFailed(then.failed, then.total) };
    case "later": {
      const step = steps[then.stepIndex]?.name ?? `Step ${then.stepIndex + 1}`;
      const mark = attemptMark(then.result);
      switch (then.result) {
        case "passed":
          return { mark, text: TEXT.fixed(step, mustFixCount(said) > 1, then.attempt, then.checks !== undefined) };
        case "failed":
          return { mark, text: TEXT.laterFailed(step, then.attempt, then.checks) };
        case "run_failed":
          return { mark, text: TEXT.laterRunFailed(step, then.attempt) };
        case "stopped":
          return { mark, text: TEXT.laterStopped(step, then.attempt) };
      }
    }
  }
}

/**
 * Where the card's link goes: the agent's notes on the Output tab, or the Log tab when the step
 * has no agent or its agent wrote nothing.
 */
export function stoppedLink(state: OutputState | undefined, agent: string | undefined): { readonly to: "Output" | "Log"; readonly text: string } {
  const empty = state?.kind === "missing" || (state?.kind === "loaded" && (state.output.summary?.kind === "empty" || state.output.text.trim() === ""));
  return agent === undefined || empty ? { to: "Log", text: TEXT.log } : { to: "Output", text: TEXT.notes(agent) };
}
