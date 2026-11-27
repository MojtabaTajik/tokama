// How a model did on a step or for an agent, as the Usage tab's model table and the agent's record
// in Settings show it. Facts only: runs, how often the checks passed first time, attempts, and what a
// run took (of the limit, in money for pay per use, else in tokens).
import type { UsageReport } from "@tokama/core";
import { formatCost, formatTokens, limitShare } from "./usage-model.js";

export type ModelRecord = NonNullable<UsageReport["stepModels"]>[number]["models"][number];

/** "78%" and "36 of 46"; absent for a step with no checks. */
export function firstTry(record: Pick<ModelRecord, "runs" | "firstTryPassed">): { readonly percent: string; readonly of: string } | undefined {
  if (record.firstTryPassed === undefined || record.runs === 0) return undefined;
  return { percent: `${Math.round((record.firstTryPassed / record.runs) * 100)}%`, of: `${record.firstTryPassed} of ${record.runs}` };
}

/**
 * What one run took, in the best unit every row can tell: a part of the limit, else money, else
 * tokens. The rows of one table share a unit, so the column compares.
 */
export function perRunOf(records: readonly Pick<ModelRecord, "sharePerRun" | "costPerRun" | "tokensPerRun">[]): { readonly header: string; readonly sentence: string; readonly text: (record: Pick<ModelRecord, "sharePerRun" | "costPerRun" | "tokensPerRun">) => string } {
  if (records.every((record) => record.sharePerRun !== undefined)) return { header: "Limit per run", sentence: "of weekly limit per run", text: (record) => limitShare(record.sharePerRun!) };
  if (records.every((record) => record.costPerRun !== undefined)) return { header: "Cost per run", sentence: "per run", text: (record) => formatCost(record.costPerRun!) };
  return { header: "Tokens per run", sentence: "tokens per run", text: (record) => formatTokens(record.tokensPerRun) };
}
