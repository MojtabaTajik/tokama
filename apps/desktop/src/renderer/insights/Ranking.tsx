// What uses the weekly limits: per AI tool one line with Tokama, outside Tokama and what is left of
// its limit, then the ranking of Tokama's own use by step, workflow or item, each row's bar in its
// tool's colour (the tool's icon is in the same row, so colour is never the only signal). A share is
// always a part of that row's own tool's limit. Engine text (titles, names) is React text only.
import type { AiCliId, Setup, UsageReport, UsageWindow } from "@tokama/core";
import { useState } from "react";
import { AgentRing } from "../agent/AgentRing.js";
import { cliName } from "../model.js";
import { BackendMark } from "../ui/agent.js";
import { Button } from "../ui/Button.js";
import { Segmented } from "../ui/Segmented.js";
import { type Group, kindOf, type Ranking as RankingData, rankingOf, type Row, type SubRow } from "./ranking-model.js";
import { limitShare, toolColour } from "./usage-model.js";

const TEXT = {
  title: "What uses the weekly limits",
  note: (previous: boolean) => `${previous ? "last week" : "this week"} · each share is of that tool's own limit`,
  window: "Week",
  group: "Group by",
  split: "Weekly limit by AI tool",
  tokama: "Tokama",
  outside: "Outside Tokama",
  left: "Left",
  table: "What uses the weekly limits",
  step: "Step",
  agent: "Agent",
  model: "Model",
  runs: "Runs",
  empty: "No Tokama runs this week.",
  emptyHint: "Limits and the forecast above still show. Steps list here once items run.",
  newWork: "+ New work",
  estimate: "~ is an estimate from what ran on this machine and how far the limit moved. Outside Tokama is the same tool, run by you here.",
  priced: (date: string) => `≈ marks a call the CLI gave no cost for: priced from Tokama's price table, prices as of ${date}.`,
  more: (count: number) => `${count} more ${count === 1 ? "item" : "items"}`,
  loading: "Loading usage",
  thisWeek: "This week",
  lastWeek: "Last week",
  by: { step: "Step", workflow: "Workflow", item: "Item" },
} as const;

export interface RankingProps {
  readonly report: UsageReport;
  readonly only: AiCliId | undefined;
  readonly tools: readonly AiCliId[];
  readonly setup: Setup | undefined;
  /** The week asked for. While the report is still of the other one, its rows are not shown under this label. */
  readonly window: UsageWindow;
  readonly onWindow: (window: UsageWindow) => void;
  readonly onSelectItem: (itemId: string) => void;
  readonly onNewWork: () => void;
}

export function WeeklyUse({ report, only, tools, setup, window, onWindow, onSelectItem, onNewWork }: RankingProps) {
  const [group, setGroup] = useState<Group>("step");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const week = report.week;
  if (week === undefined) return null;
  const stale = week.window !== window;
  const ranking = rankingOf(week, report.clis, group, only, setup);
  const previous = window === "previous";
  const split = week.limits.filter((limit) => (only === undefined || limit.cliId === only) && limit.tokamaPercent !== undefined && limit.outsidePercent !== undefined);
  const toggle = (key: string) =>
    setOpen((keys) => {
      const next = new Set(keys);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return (
    <section className="ins-section" aria-labelledby="ins-use-title">
      <header className="ins-section-head">
        <h2 id="ins-use-title" className="ins-h2">
          {TEXT.title}
        </h2>
        <span className="muted">{TEXT.note(previous)}</span>
        <Segmented className="ins-use-week" label={TEXT.window} options={[{ value: "current", label: TEXT.thisWeek }, { value: "previous", label: TEXT.lastWeek }]} value={window} onChange={onWindow} />
        <Segmented
          label={TEXT.group}
          options={(["step", "workflow", "item"] as const).map((value) => ({ value, label: TEXT.by[value] }))}
          value={group}
          onChange={setGroup}
        />
      </header>
      {stale ? (
        <p className="placeholder">{TEXT.loading}</p>
      ) : (
        <>
      {split.length > 0 && (
        <div className="ins-split" role="list" aria-label={TEXT.split}>
          {split.map((limit) => (
            <SplitLine key={limit.cliId} cliId={limit.cliId} tokama={limit.tokamaPercent!} outside={limit.outsidePercent!} used={limit.usedPercent} tools={tools} />
          ))}
        </div>
      )}
      {ranking.rows.length === 0 ? (
        <div className="ins-empty">
          <span>{TEXT.empty}</span>
          <span className="muted">{TEXT.emptyHint}</span>
          <Button variant="link" onClick={onNewWork}>
            {TEXT.newWork}
          </Button>
        </div>
      ) : (
        <div className="ins-scroll">
          <div className="ins-rank" role="table" aria-label={TEXT.table}>
            <div className="ins-rank-row ins-rank-head" role="row">
              <span />
              <span role="columnheader">{TEXT.step}</span>
              <span role="columnheader">{TEXT.agent}</span>
              <span role="columnheader">{TEXT.model}</span>
              <span role="columnheader" aria-label="Share, as a bar" />
              <span role="columnheader" className="ins-rank-num">
                {ranking.header}
              </span>
              <span role="columnheader" className="ins-rank-num">
                {TEXT.runs}
              </span>
            </div>
            {ranking.rows.map((row) => (
              <RankRow key={row.key} row={row} ranking={ranking} tools={tools} setup={setup} open={open.has(row.key)} onToggle={() => toggle(row.key)} onSelectItem={onSelectItem} />
            ))}
          </div>
        </div>
      )}
      {ranking.rows.some((row) => row.unit === "limit") && <p className="muted ins-note">{TEXT.estimate}</p>}
      {ranking.rows.some((row) => row.text.startsWith("≈")) && <p className="muted ins-note">{TEXT.priced(report.pricesAsOf)}</p>}
        </>
      )}
    </section>
  );
}

function SplitLine({ cliId, tokama, outside, used, tools }: { readonly cliId: AiCliId; readonly tokama: number; readonly outside: number; readonly used: number; readonly tools: readonly AiCliId[] }) {
  const left = Math.max(0, 100 - used);
  const whole = tokama + outside + left || 1;
  const name = cliName(cliId);
  const parts = [
    { label: TEXT.tokama, value: limitShare(tokama), size: tokama, colour: toolColour(cliId, tools) },
    { label: TEXT.outside, value: limitShare(outside), size: outside, colour: "var(--chart-other)" },
    { label: TEXT.left, value: `${Math.round(left)}%`, size: left, colour: "var(--hairline)" },
  ];
  return (
    <div role="listitem" className="ins-split-row">
      <span className="ins-split-tool">
        <BackendMark cliId={cliId} size={16} />
        <span className="ins-limit-name">{name}</span>
      </span>
      <span className="ins-split-bar" role="img" aria-label={`${name} weekly limit: ${parts.map((part) => `${part.label} ${part.value}`).join(", ")}`}>
        {parts.filter((part) => part.size > 0).map((part) => (
          <span key={part.label} style={{ flex: `${part.size / whole} 1 0`, background: part.colour }} />
        ))}
      </span>
      <span className="ins-split-figs">
        {parts.map((part) => (
          <span key={part.label} className="ins-fig">
            <span className="ins-swatch" aria-hidden="true" style={{ background: part.colour }} />
            <span className="muted">{part.label}</span>
            <b className="mono">{part.value}</b>
          </span>
        ))}
      </span>
    </div>
  );
}

function ToolMark({ cliId, text }: { readonly cliId: AiCliId; readonly text: string }) {
  return (
    <span className="ins-model" title={cliName(cliId)}>
      <BackendMark cliId={cliId} size={12} />
      <span className="mono ins-model-name">{text}</span>
    </span>
  );
}

function Bar({ value, scale, colour, thin = false }: { readonly value: number; readonly scale: number; readonly colour: string; readonly thin?: boolean }) {
  const width = value > 0 && scale > 0 ? Math.max(1.5, (value / scale) * 100) : 0;
  return (
    <span className="ins-bar" aria-hidden="true" data-thin={thin || undefined}>
      {width > 0 && <span style={{ width: `${width}%`, background: colour }} />}
    </span>
  );
}

interface RankRowProps {
  readonly row: Row;
  readonly ranking: RankingData;
  readonly tools: readonly AiCliId[];
  readonly setup: Setup | undefined;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onSelectItem: (itemId: string) => void;
}

function RankRow({ row, ranking, tools, setup, open, onToggle, onSelectItem }: RankRowProps) {
  const scale = ranking.scale[kindOf(row.unit)];
  const colour = row.kind === "outside" ? "var(--chart-other)" : toolColour(row.cliId, tools);
  const expandable = row.items !== undefined && (row.items.length > 0 || row.more !== undefined);
  const cells = (
    <>
      <span className="ins-chevron" aria-hidden="true">
        {expandable ? (open ? "⌄" : "›") : ""}
      </span>
      <span className="ins-rank-name">{row.itemId === undefined ? row.name : (
        <Button variant="quiet" onClick={() => onSelectItem(row.itemId!)}>
          {row.name}
        </Button>
      )}</span>
      <span className="ins-rank-cell ins-rank-agents">
        {(row.agentIds ?? []).map((agentId) => (
          <AgentRing key={agentId} agentId={agentId} agents={setup?.agents ?? []} />
        ))}
      </span>
      <span className="ins-rank-cell">
        <ToolMark cliId={row.cliId} text={row.kind === "outside" ? "" : (row.model ?? cliName(row.cliId))} />
      </span>
      <Bar value={row.value} scale={scale} colour={colour} />
      <span className="mono ins-rank-num ins-rank-value" title={row.unit === "tokens" && row.text === "no limit" ? "Local models have no plan limit" : undefined}>
        {row.text}
      </span>
      <span className="ins-rank-num ins-rank-facts">{row.facts}</span>
    </>
  );
  return (
    <>
      {expandable ? (
        <div role="row" className="ins-rank-line">
          <Button variant="plain" className="ins-rank-row" aria-expanded={open} onClick={onToggle}>
            {cells}
          </Button>
        </div>
      ) : (
        <div role="row" className="ins-rank-line ins-rank-row">
          {cells}
        </div>
      )}
      {open && row.items?.map((item) => <SubLine key={item.itemId} item={item} scale={scale} colour={colour} onSelectItem={onSelectItem} />)}
      {open && row.more !== undefined && (
        <div role="row" className="ins-rank-row ins-rank-sub">
          <span />
          <span className="ins-rank-name ins-sub-name muted">{TEXT.more(row.more.count)}</span>
          <span />
          <span />
          <span />
          <span className="mono ins-rank-num ins-rank-value">{row.more.text}</span>
          <span />
        </div>
      )}
    </>
  );
}

function SubLine({ item, scale, colour, onSelectItem }: { readonly item: SubRow; readonly scale: number; readonly colour: string; readonly onSelectItem: (itemId: string) => void }) {
  return (
    <div role="row" className="ins-rank-row ins-rank-sub">
      <span />
      <span className="ins-rank-name ins-sub-name">
        <Button variant="quiet" onClick={() => onSelectItem(item.itemId)}>
          {item.title}
        </Button>
      </span>
      <span />
      <span />
      <Bar value={item.value} scale={scale} colour={colour} thin />
      <span className="mono ins-rank-num ins-rank-value">{item.text}</span>
      <span className="ins-rank-num ins-rank-facts">{item.facts}</span>
    </div>
  );
}
