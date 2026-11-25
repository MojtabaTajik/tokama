// The Insights page: its header and tabs, the Usage tab (UsageTab) once the first report has come,
// and the Machine tab (MachineTab).
import type { ItemRecord, Setup, UsageRange, UsageScope } from "@tokama/core";
import { useState } from "react";
import type { ConnectionState, TokamaBridge } from "../../shared/bridge.js";
import type { CliIssue } from "../model.js";
import { ConnectionFailure } from "../shell/ConnectionStatus.js";
import { MachineTab } from "./MachineTab.js";
import type { Metric } from "./usage-model.js";
import { UsageTab } from "./UsageTab.js";
import type { UsageView } from "./useUsage.js";
import { Tabs } from "../ui/Tabs.js";

const TEXT = {
  title: "Insights",
  summary: "This machine · history kept 90 days on this machine; nothing leaves it",
  tabs: "Insights views",
  usage: "Usage",
  machine: "Machine",
  loading: "Loading usage",
  failed: "Could not load usage",
} as const;

export interface InsightsProps {
  readonly bridge: TokamaBridge;
  readonly connection: ConnectionState;
  readonly onRetryConnection: () => void;
  readonly usage: UsageView;
  readonly range: UsageRange;
  readonly onRange: (range: UsageRange) => void;
  readonly scope: UsageScope;
  readonly onScope: (scope: UsageScope) => void;
  readonly setup: Setup | undefined;
  readonly items: readonly ItemRecord[];
  readonly issues: readonly CliIssue[];
  readonly now: number;
  readonly onSelectItem: (itemId: string) => void;
  readonly onNewWork: () => void;
}

const TABS = ["usage", "machine"] as const;

export function Insights({ bridge, connection, onRetryConnection, usage, range, onRange, scope, onScope, setup, items, issues, now, onSelectItem, onNewWork }: InsightsProps) {
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
      <Tabs tabs={TABS} selected={tab} onSelect={setTab} label={TEXT.tabs} labelOf={(id) => (id === "usage" ? TEXT.usage : TEXT.machine)} />
      {tab === "machine" ? (
        <MachineTab bridge={bridge} connection={connection} onRetryConnection={onRetryConnection} setup={setup} items={items} onSelectItem={onSelectItem} onNewWork={onNewWork} />
      ) : (
        <section className="ins-body" role="tabpanel" aria-label={TEXT.usage}>
          {connection.status === "failed" ? (
            <ConnectionFailure state={connection} onRetry={onRetryConnection} />
          ) : report === undefined ? (
            <p className="placeholder">{usage.error === undefined ? TEXT.loading : `${TEXT.failed}: ${usage.error}`}</p>
          ) : (
            <UsageTab
              report={report}
              error={usage.error}
              range={range}
              onRange={onRange}
              scope={scope}
              onScope={onScope}
              onRefresh={usage.refresh}
              setup={setup}
              items={items}
              issues={issues}
              now={now}
              onSelectItem={onSelectItem}
              metric={metric}
              onMetric={setMetric}
              filter={filter}
              onFilter={setFilter}
            />
          )}
        </section>
      )}
    </main>
  );
}
