// The Insights page, Usage tab: plan usage per AI CLI, tokens or estimated cost by day stacked by
// workflow, and the top items, all over one range. A workflow picked in the chart or legend
// filters the totals and the table. Costs are always marked as estimates with the price table's
// date. Engine text (titles, names, notes) renders as React text only. The Machine tab is
// MachineTab.
import type { ItemRecord, Setup, UsageRange } from "@tokama/core";
import { useState } from "react";
import type { ConnectionState, TokamaBridge } from "../../shared/bridge.js";
import type { CliIssue } from "../model.js";
import { ConnectionFailure } from "../shell/ConnectionStatus.js";
import { TemplateIcon } from "../shell/TemplateIcon.js";
import { MachineTab } from "./MachineTab.js";
import { PlanMeters } from "./PlanMeters.js";
import { Legend, UsageChart } from "./UsageChart.js";
import { TopItems } from "./TopItems.js";
import { formatClock, formatCost, formatTokens, type Metric, templateFor, totalOf, workflowName } from "./usage-model.js";
import type { UsageView } from "./useUsage.js";

const RANGES: readonly UsageRange[] = [14, 30, 90];

const TEXT = {
  title: "Insights",
  summary: "This machine · history kept 90 days on this machine; nothing leaves it",
  tabs: "Insights views",
  usage: "Usage",
  machine: "Machine",
  loading: "Loading usage",
  failed: "Could not load usage",
  range: "Range",
  days: (n: number) => `${n} days`,
  metric: "Measure",
  tokens: "Tokens",
  cost: "≈ Cost",
  tokensTitle: "Tokens by day",
  costTitle: "Estimated cost by day",
  byWorkflow: (n: number) => `by workflow · last ${n} days`,
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

export interface InsightsProps {
  readonly bridge: TokamaBridge;
  readonly connection: ConnectionState;
  readonly onRetryConnection: () => void;
  readonly usage: UsageView;
  readonly range: UsageRange;
  readonly onRange: (range: UsageRange) => void;
  readonly setup: Setup | undefined;
  readonly items: readonly ItemRecord[];
  readonly issues: readonly CliIssue[];
  readonly now: number;
  readonly onSelectItem: (itemId: string) => void;
  readonly onNewWork: () => void;
}

export function Insights({ bridge, connection, onRetryConnection, usage, range, onRange, setup, items, issues, now, onSelectItem, onNewWork }: InsightsProps) {
  const [tab, setTab] = useState<"usage" | "machine">("usage");
  const [metric, setMetric] = useState<Metric>("tokens");
  const [filter, setFilter] = useState<string | undefined>(undefined);
  const { report } = usage;
  return (
    <main className="main insights-page" tabIndex={-1}>
      <header className="main-header">
        <h1 className="ellipsis">{TEXT.title}</h1>
        <span className="summary">{TEXT.summary}</span>
      </header>
      <div className="ins-tabs" role="tablist" aria-label={TEXT.tabs}>
        <button type="button" role="tab" className="ins-tab" aria-selected={tab === "usage"} onClick={() => setTab("usage")}>
          {TEXT.usage}
        </button>
        <button type="button" role="tab" className="ins-tab" aria-selected={tab === "machine"} onClick={() => setTab("machine")}>
          {TEXT.machine}
        </button>
      </div>
      {tab === "machine" ? (
        <MachineTab bridge={bridge} connection={connection} onRetryConnection={onRetryConnection} setup={setup} items={items} onSelectItem={onSelectItem} onNewWork={onNewWork} />
      ) : (
      <section className="ins-body" role="tabpanel" aria-label={TEXT.usage}>
        {connection.status === "failed" ? (
          <ConnectionFailure state={connection} onRetry={onRetryConnection} />
        ) : report === undefined ? (
          <p className="placeholder">{usage.error === undefined ? TEXT.loading : `${TEXT.failed}: ${usage.error}`}</p>
        ) : (
          <>
            <PlanMeters report={report} issues={issues} now={now} />
            <section className="ins-section" aria-labelledby="ins-chart-title">
              <div className="ins-controls">
                <div className="segments" role="group" aria-label={TEXT.range}>
                  {RANGES.map((days) => (
                    <button key={days} type="button" className="segment" aria-pressed={range === days} onClick={() => onRange(days)}>
                      {TEXT.days(days)}
                    </button>
                  ))}
                </div>
                <div className="segments" role="group" aria-label={TEXT.metric}>
                  {(["tokens", "cost"] as const).map((m) => (
                    <button key={m} type="button" className="segment" aria-pressed={metric === m} onClick={() => setMetric(m)}>
                      {m === "tokens" ? TEXT.tokens : TEXT.cost}
                    </button>
                  ))}
                </div>
              </div>
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
              </header>
              <Headline report={report} filter={filter} metric={metric} setup={setup} now={now} />
              <Legend report={report} setup={setup} metric={metric} filter={filter} onFilter={setFilter} />
              <UsageChart report={report} setup={setup} metric={metric} filter={filter} onFilter={setFilter} />
              <p className="muted ins-hint">{TEXT.hint}</p>
            </section>
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
        )}
      </section>
      )}
    </main>
  );
}

/** The range's total for the measure shown, with the other measure beside it. */
function Headline({ report, filter, metric, setup, now }: { readonly report: NonNullable<UsageView["report"]>; readonly filter: string | undefined; readonly metric: Metric; readonly setup: Setup | undefined; readonly now: number }) {
  const workflow = filter === undefined ? undefined : report.workflows.find((w) => w.templateId === filter);
  const tokens = filter === undefined ? totalOf(report.totals.tokens) : (workflow?.tokens ?? 0);
  const cost = filter === undefined ? report.totals.costUsd : (workflow?.costUsd ?? null);
  const tokenText = `${formatTokens(tokens)} tokens`;
  const costText = `${formatCost(cost)} estimated`;
  const scope = filter === undefined ? TEXT.allWorkflows : TEXT.only(workflowName(filter, setup));
  const unpriced = filter === undefined && report.totals.unpricedCalls > 0 ? TEXT.unpriced(report.totals.unpricedCalls) : undefined;
  return (
    <p className="ins-headline">
      <strong className="ins-hero">{metric === "tokens" ? tokenText : formatCost(cost)}</strong>
      <span className="muted">{[metric === "tokens" ? costText : tokenText, scope, unpriced, `as of ${formatClock(report.asOf, now)}`].filter(Boolean).join(" · ")}</span>
    </p>
  );
}
