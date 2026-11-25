// The scope's estimated cost at API list prices, whether a subscription plan covers it, and where
// the tokens went: processed, cached and uncached input, output, and what the cache saved.
import type { UsageReport } from "@tokama/core";
import { formatCost, formatTokens } from "./usage-model.js";
import { markOf } from "../ui/status.js";

const TEXT = {
  atRates: (days: number) => `at API rates · last ${days} days`,
  covered: "Your plan covers it",
  explain:
    "What the same calls would cost at list API prices. On a subscription such as Claude Code MAX you pay the plan, not this amount; the number shows how much the plan is doing for you.",
  summary: "Token summary",
  processed: "Processed",
  processedSub: "all tokens, in and out",
  cached: "Cached input",
  cachedSub: (percent: number) => `${Math.round(percent)}% of input · cheap to read`,
  uncached: "Uncached input",
  uncachedSub: "full input price",
  output: "Output",
  outputSub: "written by the model",
  savings: "Cache savings",
  savingsSub: (factor: number | null) => (factor === null ? "no cache price known" : `${factor.toFixed(1)}× cheaper than without cache`),
} as const;

/** A subscription plan was reported by a cloud CLI: its calls are paid by the plan, not per call. */
export const planCovers = (report: UsageReport): boolean => report.clis.some((cli) => cli.cliId !== "ollama" && cli.plan !== undefined);

export function CostSummary({ report }: { readonly report: UsageReport }) {
  const summary = report.tokenSummary;
  return (
    <section className="ins-section ins-cost" aria-label="Estimated cost">
      <p className="ins-cost-head">
        <strong className="mono ins-cost-hero">{formatCost(report.totals.costUsd)}</strong>
        <span>{TEXT.atRates(report.range)}</span>
        {planCovers(report) && (
          <span className="ins-covered">
            <span className="ins-check" aria-hidden="true">
              {markOf("passed").symbol}
            </span>
            {TEXT.covered}
          </span>
        )}
      </p>
      <p className="ins-cost-explain">{TEXT.explain}</p>
      {summary !== undefined && (
        <div className="ins-summary" role="list" aria-label={TEXT.summary}>
          <Cell label={TEXT.processed} value={formatTokens(summary.processed)} sub={TEXT.processedSub} />
          <Cell label={TEXT.cached} value={formatTokens(summary.cachedInput)} sub={TEXT.cachedSub(summary.cachedInputPercent)} />
          <Cell label={TEXT.uncached} value={formatTokens(summary.uncachedInput)} sub={TEXT.uncachedSub} />
          <Cell label={TEXT.output} value={formatTokens(summary.output)} sub={TEXT.outputSub} />
          <Cell label={TEXT.savings} value={formatCost(summary.cacheSavingsUsd)} sub={TEXT.savingsSub(summary.cacheSavingsFactor)} />
        </div>
      )}
    </section>
  );
}

function Cell({ label, value, sub }: { readonly label: string; readonly value: string; readonly sub: string }) {
  return (
    <div className="ins-summary-cell" role="listitem">
      <span className="ins-summary-label">{label}</span>
      <span className="mono ins-summary-value">{value}</span>
      <span className="muted ins-summary-sub">{sub}</span>
    </div>
  );
}
