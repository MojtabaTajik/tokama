// Which reading of an AI CLI's plan windows to show. Sources in order: the CLI's answer to a usage
// request, the last rate-limit event of a call Tokama ran, the CLI's own cached copy. The first
// fresh one wins; when none is fresh, the newest. A window whose reset time has passed says
// nothing about now and is dropped. With nothing left, the windows are unknown: never a guess.
import type { AiCliId, CliPlan, PlanReading, PlanSource } from "../../kernel/schemas/index.js";

/** A reading older than this gives way to a fresher source further down the order. */
export const FRESH_MS = 60 * 60_000;

/** What one source gave: a reading, or why it has none. */
export type PlanCandidate = { readonly source: PlanSource } & ({ readonly reading: PlanReading } | { readonly problem: string });

const ORDER: readonly PlanSource[] = ["request", "run", "cache"];
const MAX_WINDOWS = 20;
const WINDOW_CHARS = 64;
const WORD_CHARS = 32;
const MAX_PERCENT = 1000;
// A NaN from a stored sample reads as 0, never as a number past the schema's bounds.
const clamp = (value: number, max: number): number => (Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : 0);

export function choosePlan(cliId: AiCliId, candidates: readonly PlanCandidate[], now: number, version?: string): CliPlan {
  const live = candidates
    .flatMap((candidate) => ("reading" in candidate ? [{ source: candidate.source, reading: { ...candidate.reading, windows: candidate.reading.windows.filter((w) => w.resetsAt === undefined || w.resetsAt > now) } }] : []))
    .filter(({ reading }) => reading.windows.length > 0)
    .sort((a, b) => ORDER.indexOf(a.source) - ORDER.indexOf(b.source));
  const chosen = live.find(({ reading }) => now - reading.asOf <= FRESH_MS) ?? [...live].sort((a, b) => b.reading.asOf - a.reading.asOf)[0];
  const base = { cliId, ...(version !== undefined && { version: version.slice(0, 100) }) };
  if (chosen === undefined) {
    const problem = candidates.flatMap((candidate) => ("problem" in candidate ? [candidate.problem] : []))[0];
    return { ...base, windows: [], note: (problem ?? "No source has reported this CLI's plan windows yet.").slice(0, 500) };
  }
  const { reading, source } = chosen;
  return {
    ...base,
    // A run's rate-limit event is the CLI's data as it came: cut to the report's limits.
    windows: reading.windows.slice(0, MAX_WINDOWS).map((w) => ({
      window: w.window.slice(0, WINDOW_CHARS) || "window",
      usedPercent: clamp(w.usedPercent, MAX_PERCENT),
      ...(w.resetsAt !== undefined && { resetsAt: w.resetsAt }),
      ...(w.scope && { scope: w.scope.slice(0, WINDOW_CHARS) }),
      ...(w.group && { group: w.group.slice(0, WORD_CHARS) }),
      ...(w.severity && { severity: w.severity.slice(0, WORD_CHARS) }),
      ...(w.active !== undefined && { active: w.active }),
      ...(w.sharePercent !== undefined && { sharePercent: clamp(w.sharePercent, 100) }),
    })),
    source,
    asOf: reading.asOf,
    ...(reading.plan !== undefined && { plan: reading.plan.slice(0, 64) }),
    ...(reading.extraUsage !== undefined && { extraUsage: reading.extraUsage }),
  };
}
