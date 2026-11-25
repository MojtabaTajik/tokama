// The Usage tab: whose usage it counts (Tokama's own calls, or every Claude Code call on this
// machine read from its local logs), the accounts and their limits, the estimated cost and token
// summary, tokens or estimated cost by day stacked by Tokama workflow, usage by model and by repo,
// and the top items. A workflow picked in the chart or legend filters the chart's totals and the
// table. Costs are always marked as estimates with the price table's date. Engine text (titles,
// names, notes) renders as React text only.
import type { ItemRecord, Setup, UsageRange, UsageReport, UsageScope } from "@tokama/core";
import { useState } from "react";
import type { CliIssue } from "../model.js";
import { TemplateIcon } from "../shell/TemplateIcon.js";
import { AccountCards } from "./AccountCards.js";
import { CostSummary } from "./CostSummary.js";
import { TopItems } from "./TopItems.js";
import { Legend, UsageChart } from "./UsageChart.js";
import { UsageTables } from "./UsageTables.js";
import { formatClock, formatCost, formatTokens, type Metric, scanText, templateFor, tokamaTotals, workflowName } from "./usage-model.js";

const RANGES: readonly UsageRange[] = [14, 30, 90];
const SCOPES: readonly (readonly [UsageScope, string])[] = [
  ["tokama", "Tokama work"],
  ["all", "All on this Mac"],
];

const TEXT = {
  scope: "Whose usage",
  scopeNote: {
    tokama: "Only calls Tokama made for its items, from each call's own output.",
    all: "Everything Claude Code did on this Mac, read from its local logs in ~/.claude, including sessions you ran yourself. Read-only; nothing leaves this machine.",
  },
  loading: "Loading usage",
  range: "Range",
  days: (n: number) => `${n} days`,
  metric: "Measure",
  tokens: "Tokens",
  cost: "≈ Cost",
  tokensTitle: "Tokens by day",
  costTitle: "Estimated cost by day",
  byWorkflow: (n: number) => `by workflow · last ${n} days · Tokama work only`,
  workflow: "workflow",
  clearFilter: "Clear the workflow filter",
  hint: "Click a slice or a legend entry to filter the table. Tokens come from each call's own output: Claude Code result events.",
  allWorkflows: "all workflows",
  only: (name: string) => `${name} only`,
  unpriced: (n: number) => `${n} ${n === 1 ? "call" : "calls"} without a price`,
  tableNote: (filter: string | undefined, n: number) => `${filter === undefined ? "" : `${filter} · `}last ${n} days · by tokens`,
  estimate: (date: string) =>
    `≈ estimate · prices as of ${date} · Claude Code's own list-price figure where it reports one, else the list price for the model each call used; on a subscription plan it is notional, not a bill. Local calls cost nothing.`,
} as const;

export interface UsageTabProps {
  readonly report: UsageReport;
  readonly range: UsageRange;
  readonly onRange: (range: UsageRange) => void;
  readonly scope: UsageScope;
  readonly onScope: (scope: UsageScope) => void;
  readonly onRefresh: () => void;
  readonly setup: Setup | undefined;
  readonly items: readonly ItemRecord[];
  readonly issues: readonly CliIssue[];
  readonly now: number;
  readonly onSelectItem: (itemId: string) => void;
}

export function UsageTab({ report, range, onRange, scope, onScope, onRefresh, setup, items, issues, now, onSelectItem }: UsageTabProps) {
  const [metric, setMetric] = useState<Metric>("tokens");
  const [filter, setFilter] = useState<string | undefined>(undefined);
  // After a switch the last report stays until the new one comes: its scoped numbers are not shown under the new label.
  const current = (report.scope ?? "tokama") === scope;
  const scan = current && scope === "all" ? scanText(report.scan) : undefined;
  return (
    <>
      <div className="ins-scope-row">
        <div className="segments" role="group" aria-label={TEXT.scope}>
          {SCOPES.map(([id, name]) => (
            <button key={id} type="button" className="segment" aria-pressed={scope === id} onClick={() => onScope(id)}>
              {name}
            </button>
          ))}
        </div>
        <span className="ins-scope-note">{TEXT.scopeNote[scope]}</span>
        {scan !== undefined && (
          <span className="ins-scan" role="status">
            {scan}
          </span>
        )}
        <div className="segments ins-range" role="group" aria-label={TEXT.range}>
          {RANGES.map((days) => (
            <button key={days} type="button" className="segment" aria-pressed={range === days} onClick={() => onRange(days)}>
              {TEXT.days(days)}
            </button>
          ))}
        </div>
      </div>
      <AccountCards report={report} setup={setup} issues={issues} now={now} onRefresh={onRefresh} />
      {current ? <CostSummary report={report} /> : <p className="placeholder ins-section">{TEXT.loading}</p>}
      <section className="ins-section" aria-labelledby="ins-chart-title">
        <header className="ins-section-head">
          <h2 id="ins-chart-title" className="ins-h2">
            {metric === "tokens" ? TEXT.tokensTitle : TEXT.costTitle}
          </h2>
          <span className="muted">{TEXT.byWorkflow(report.range)}</span>
          {filter !== undefined && (
            <span className="ins-filter">
              <span className="muted">{TEXT.workflow}</span>
              <TemplateIcon icon={templateFor(filter, setup)?.icon} color={templateFor(filter, setup)?.color} />
              <span>{workflowName(filter, setup)}</span>
              <button type="button" className="ins-filter-clear" aria-label={TEXT.clearFilter} onClick={() => setFilter(undefined)}>
                ✕
              </button>
            </span>
          )}
          <div className="segments ins-metric" role="group" aria-label={TEXT.metric}>
            {(["tokens", "cost"] as const).map((m) => (
              <button key={m} type="button" className="segment" aria-pressed={metric === m} onClick={() => setMetric(m)}>
                {m === "tokens" ? TEXT.tokens : TEXT.cost}
              </button>
            ))}
          </div>
        </header>
        <Headline report={report} filter={filter} metric={metric} setup={setup} now={now} />
        <Legend report={report} setup={setup} metric={metric} filter={filter} onFilter={setFilter} />
        <UsageChart report={report} setup={setup} metric={metric} filter={filter} onFilter={setFilter} />
        <p className="muted ins-hint">{TEXT.hint}</p>
      </section>
      {current ? <UsageTables report={report} /> : <p className="placeholder ins-section">{TEXT.loading}</p>}
      <TopItems
        report={report}
        setup={setup}
        filter={filter}
        note={TEXT.tableNote(filter === undefined ? undefined : workflowName(filter, setup), report.range)}
        openable={new Set(items.map((item) => item.id))}
        onOpen={onSelectItem}
      />
      <p className="muted ins-estimate">{TEXT.estimate(report.pricesAsOf)}</p>
    </>
  );
}

/** The chart's total for the measure shown, with the other measure beside it: Tokama's workflows only, whatever the scope. */
function Headline({ report, filter, metric, setup, now }: { readonly report: UsageReport; readonly filter: string | undefined; readonly metric: Metric; readonly setup: Setup | undefined; readonly now: number }) {
  const all = tokamaTotals(report);
  const workflow = filter === undefined ? undefined : report.workflows.find((w) => w.templateId === filter);
  const tokens = filter === undefined ? all.tokens : (workflow?.tokens ?? 0);
  const cost = filter === undefined ? all.costUsd : (workflow?.costUsd ?? null);
  const tokenText = `${formatTokens(tokens)} tokens`;
  const costText = `${formatCost(cost)} estimated`;
  const scope = filter === undefined ? TEXT.allWorkflows : TEXT.only(workflowName(filter, setup));
  const unpriced = filter === undefined && all.unpricedCalls > 0 ? TEXT.unpriced(all.unpricedCalls) : undefined;
  return (
    <p className="ins-headline">
      <strong className="ins-hero">{metric === "tokens" ? tokenText : formatCost(cost)}</strong>
      <span className="muted">{[metric === "tokens" ? costText : tokenText, scope, unpriced, `as of ${formatClock(report.asOf, now)}`].filter(Boolean).join(" · ")}</span>
    </p>
  );
}
