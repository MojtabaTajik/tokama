// How much of an AI CLI's limit Tokama's calls took, against everything else that used the same
// limit on this machine (the user's own sessions). The CLI reports its use only in whole percent
// per window, so the split is made per window, never per run: the window's use is shared out in
// proportion to a weight. The weight is what a call's tokens cost at the price table's prices, which
// only ranks work (a plan user is never shown a dollar). It is a rough share: use of the same
// account on other machines is not seen.
import type { AgentCallUsage, TokenUsage } from "../../kernel/schemas/index.js";
import { tokenCost } from "./prices.js";

/** A window must have used this much of its limit before a split is told. */
export const SPLIT_FROM_PERCENT = 10;

/** What one AI CLI's session logs hold for a stretch of time, per model. */
export interface LogTotal {
  readonly model: string;
  readonly tokens: TokenUsage;
}

/** One AI CLI's own record of its calls, when it keeps one. */
export interface CallLogs {
  /** The tokens the logs hold between two times, per model. */
  readonly totals: (from: number, to: number) => readonly LogTotal[];
  /** From when the logs hold the CLI's calls; undefined while they hold none. */
  readonly coveredFrom: number | undefined;
  /** The logs were read to their end; false while a first scan runs. */
  readonly ready: boolean;
}

/** What a stretch of time weighed: Tokama's calls, and everything the AI CLI did on this machine. */
export interface Weight {
  readonly tokama: number;
  readonly all: number;
}

export interface Split {
  /** The part of the limit Tokama's calls took. */
  readonly tokamaPercent: number;
  /** The rest: the user's own sessions. */
  readonly outsidePercent: number;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;
const total = (t: TokenUsage): number => t.input + t.output + t.cacheRead + t.cacheWrite;

/**
 * The weight of a Tokama call: its tokens at the price table's prices, per model. A model the table
 * does not know falls back to the CLI's own figure for the call. Undefined when neither is known,
 * and for a local model, which has no limit.
 */
export function callWeight(call: Pick<AgentCallUsage, "cliId" | "model" | "tokens" | "models" | "reportedCostUsd">): number | undefined {
  if (call.cliId === "ollama") return undefined;
  let weight = 0;
  for (const [model, tokens] of Object.entries(call.models ?? { [call.model]: call.tokens })) {
    const cost = tokenCost(model, tokens);
    if (cost === undefined) return call.reportedCostUsd !== undefined && call.reportedCostUsd > 0 ? call.reportedCostUsd : undefined;
    weight += cost;
  }
  return weight;
}

/**
 * What the stretch weighed. `calls` are Tokama's calls of the AI CLI that ended in it; `logs` are
 * the CLI's session logs, which hold everything it did, Tokama's own calls included. Undefined when
 * the CLI keeps no logs, they are not fully read or do not reach back to `from`, or any call or
 * logged model has no price: a split is never guessed.
 */
export function windowWeight(calls: readonly AgentCallUsage[], logs: CallLogs | undefined, from: number, to: number): Weight | undefined {
  if (logs === undefined || !logs.ready || logs.coveredFrom === undefined || logs.coveredFrom > from) return undefined;
  let tokama = 0;
  for (const call of calls) {
    const weight = callWeight(call);
    if (weight === undefined) return undefined;
    tokama += weight;
  }
  let all = 0;
  for (const { model, tokens } of logs.totals(from, to)) {
    const cost = tokenCost(model, tokens);
    if (cost === undefined) return undefined;
    all += cost;
  }
  return { tokama, all };
}

/**
 * Shares a window's use between Tokama and the rest. Undefined below 10 points of use (a whole
 * percent of a few points says too little), without a weight, or when nothing was weighed.
 */
export function splitLimit(usedPercent: number, weight: Weight | undefined): Split | undefined {
  if (weight === undefined || usedPercent < SPLIT_FROM_PERCENT || !Number.isFinite(usedPercent) || !Number.isFinite(weight.tokama) || !Number.isFinite(weight.all) || !(weight.all > 0)) return undefined;
  const tokama = round2((usedPercent * Math.min(Math.max(0, weight.tokama), weight.all)) / weight.all);
  return { tokamaPercent: tokama, outsidePercent: round2(Math.max(0, usedPercent - tokama)) };
}

/**
 * What each call of a set weighs for ranking them against each other: the price-table weight, and
 * when any call has none, tokens for all, so the unit is never mixed.
 */
export function weigher(calls: readonly AgentCallUsage[]): { readonly of: (call: AgentCallUsage) => number; readonly priced: boolean } {
  const priced = calls.every((call) => callWeight(call) !== undefined);
  return { priced, of: (call) => (priced ? (callWeight(call) ?? 0) : total(call.tokens)) };
}
