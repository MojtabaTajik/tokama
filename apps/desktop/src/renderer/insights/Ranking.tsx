// What uses the weekly limits: one list per AI tool, each with its own heading line (the Tokama /
// outside Tokama / left bar when Tokama knows its part of the limit, else one sentence saying why
// not), column head, bar scale and order. A tool's list ranks Tokama's own use by step, workflow or
// item, its bars in the tool's colour; it shows the top 8 rows, then "Show all". A share is always
// a part of that tool's own limit, and rows of two tools never share a list. Engine text (titles,
// names) is React text only.
import type { AiCliId, Setup, UsageReport, UsageWindow } from "@tokama/core";
import { useState } from "react";
import { AgentRing } from "../agent/AgentRing.js";
import { shortModel } from "../format/model.js";
import { cliName } from "../model.js";
import { BackendMark } from "../ui/agent.js";
import { Button } from "../ui/Button.js";
import { Segmented } from "../ui/Segmented.js";
import { SplitBar } from "../ui/SplitBar.js";
import { type Group, LIST_ROWS, listsOf, type Row, type SubRow, type ToolList } from "./ranking-model.js";
import { limitShare, toolColour } from "./usage-model.js";

const TEXT = {
  title: "What uses the weekly limits",
  note: (previous: boolean) => `${previous ? "last week" : "this week"} · one list per AI tool, each with its own measure`,
  window: "Week",
  group: "Group by",
  tokama: "Tokama",
  outside: "Outside Tokama",
  left: "Left",
  agent: "Agent",
  agents: "Agents",
  model: "Model",
  runs: "Runs",
  empty: "No Tokama runs this week.",
  emptyHint: "Limits and the forecast above still show. Steps list here once items run.",
  newWork: "+ New work",
  estimate: "~ is an estimate from what ran on this machine and how far the limit moved. Outside Tokama is the same tool, run by you here.",
  priced: (date: string) => `≈ marks a call the CLI gave no cost for: priced from Tokama's price table, prices as of ${date}.`,
  more: (count: number) => `${count} more ${count === 1 ? "item" : "items"}`,
  showAll: (count: number) => `Show all ${count}`,
  showLess: "Show fewer",
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
  readonly now: number;
  /** The week asked for. While the report is still of the other one, its rows are not shown under this label. */
  readonly window: UsageWindow;
  readonly onWindow: (window: UsageWindow) => void;
  readonly onSelectItem: (itemId: string) => void;
  readonly onNewWork: () => void;
}

export function WeeklyUse({ report, only, tools, setup, now, window, onWindow, onSelectItem, onNewWork }: RankingProps) {
  const [group, setGroup] = useState<Group>("step");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [all, setAll] = useState<ReadonlySet<AiCliId>>(new Set());
  const week = report.week;
  if (week === undefined) return null;
  const stale = week.window !== window;
  const lists = listsOf(week, report.clis, group, only, setup, now);
  const toggle = <T,>(set: ReadonlySet<T>, value: T, update: (next: ReadonlySet<T>) => void) => {
    const next = new Set(set);
    if (!next.delete(value)) next.add(value);
    update(next);
  };
  return (
    <section className="ins-section" aria-labelledby="ins-use-title">
      <header className="ins-section-head">
        <h2 id="ins-use-title" className="ins-h2">
          {TEXT.title}
        </h2>
        <span className="muted">{TEXT.note(window === "previous")}</span>
        <Segmented className="ins-use-week" label={TEXT.window} options={[{ value: "current", label: TEXT.thisWeek }, { value: "previous", label: TEXT.lastWeek }]} value={window} onChange={onWindow} />
        <Segmented label={TEXT.group} options={(["step", "workflow", "item"] as const).map((value) => ({ value, label: TEXT.by[value] }))} value={group} onChange={setGroup} />
      </header>
      {stale ? (
        <p className="placeholder">{TEXT.loading}</p>
      ) : lists.length === 0 ? (
        <div className="ins-empty">
          <span>{TEXT.empty}</span>
          <span className="muted">{TEXT.emptyHint}</span>
          <Button variant="link" onClick={onNewWork}>
            {TEXT.newWork}
          </Button>
        </div>
      ) : (
        <>
          {lists.map((list) => (
            <ToolListView
              key={list.cliId}
              list={list}
              group={group}
              tools={tools}
              setup={setup}
              open={open}
              onToggle={(key) => toggle(open, key, setOpen)}
              showAll={all.has(list.cliId)}
              onShowAll={() => toggle(all, list.cliId, setAll)}
              onSelectItem={onSelectItem}
            />
          ))}
          {lists.some((list) => list.heading.kind === "split" || list.rows.some((row) => row.unit === "limit")) && <p className="muted ins-note">{TEXT.estimate}</p>}
          {lists.some((list) => list.rows.some((row) => row.text.startsWith("≈"))) && <p className="muted ins-note">{TEXT.priced(report.pricesAsOf)}</p>}
        </>
      )}
    </section>
  );
}

interface ToolListViewProps {
  readonly list: ToolList;
  readonly group: Group;
  readonly tools: readonly AiCliId[];
  readonly setup: Setup | undefined;
  readonly open: ReadonlySet<string>;
  readonly onToggle: (key: string) => void;
  readonly showAll: boolean;
  readonly onShowAll: () => void;
  readonly onSelectItem: (itemId: string) => void;
}

function ToolListView({ list, group, tools, setup, open, onToggle, showAll, onShowAll, onSelectItem }: ToolListViewProps) {
  const name = cliName(list.cliId);
  const colour = toolColour(list.cliId, tools);
  const shown = showAll ? list.rows : list.rows.slice(0, LIST_ROWS);
  return (
    <section className="ins-list" aria-label={`${name}: what uses its weekly limit`}>
      <div className="ins-list-head">
        <span className="ins-list-tool">
          <BackendMark cliId={list.cliId} size={16} />
          <b className="ins-limit-name">{name}</b>
        </span>
        {list.heading.kind === "split" ? <SplitLine name={name} heading={list.heading} colour={colour} /> : <span className="ins-list-text">{list.heading.text}</span>}
      </div>
      <div className="ins-scroll">
        <div className="ins-rank" role="table" aria-label={`${name}: ${list.header}`} data-group={group}>
          <div className="ins-rank-row ins-rank-head" role="row">
            <span role="columnheader">{TEXT.by[group]}</span>
            <span role="columnheader">{group === "step" ? TEXT.agent : TEXT.agents}</span>
            {group === "step" && <span role="columnheader">{TEXT.model}</span>}
            <span role="columnheader" aria-label="Share, as a bar" />
            <span role="columnheader" className="ins-rank-num">
              {list.header}
            </span>
            <span role="columnheader" className="ins-rank-num">
              {TEXT.runs}
            </span>
          </div>
          {shown.map((row) => (
            <RankRow key={row.key} row={row} group={group} scale={list.scale} colour={colour} setup={setup} open={open.has(row.key)} onToggle={() => onToggle(row.key)} onSelectItem={onSelectItem} />
          ))}
          {list.rows.length > LIST_ROWS && (
            <div role="row" className="ins-rank-more">
              <span role="cell">
                <Button variant="link" aria-expanded={showAll} onClick={onShowAll}>
                  {showAll ? TEXT.showLess : TEXT.showAll(list.rows.length)}
                </Button>
              </span>
            </div>
          )}
          {list.outside !== undefined && <RankRow row={list.outside} group={group} scale={list.scale} colour="var(--chart-other)" setup={setup} open={false} onToggle={() => undefined} onSelectItem={onSelectItem} />}
        </div>
      </div>
    </section>
  );
}

function SplitLine({ name, heading, colour }: { readonly name: string; readonly heading: Extract<ToolList["heading"], { kind: "split" }>; readonly colour: string }) {
  const parts = [
    { label: TEXT.tokama, value: limitShare(heading.tokama), size: heading.tokama, colour, tone: "tokama" as const },
    { label: TEXT.outside, value: limitShare(heading.outside), size: heading.outside, colour: "var(--chart-other)", tone: "other" as const },
    { label: TEXT.left, value: `${Math.round(heading.left)}%`, size: heading.left, colour: "var(--hairline)", tone: "rest" as const },
  ];
  return (
    <>
      <span className="ins-list-bar">
        <SplitBar
          label={`${name} weekly limit: ${parts.map((part) => `${part.label} ${part.value}`).join(", ")}`}
          parts={parts.map((part) => ({ tone: part.tone, value: part.size, ...(part.tone === "tokama" && { colour: part.colour }) }))}
        />
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
    </>
  );
}

function Bar({ value, scale, colour, thin = false }: { readonly value: number; readonly scale: number; readonly colour: string; readonly thin?: boolean }) {
  const width = value > 0 && scale > 0 ? Math.max(1.5, (value / scale) * 100) : 0;
  // A cell like any other: the bar says nothing the value beside it does not, so its drawing is hidden from screen readers.
  return (
    <span role="cell" className="ins-bar" data-thin={thin || undefined}>
      {width > 0 && <span aria-hidden="true" style={{ width: `${width}%`, background: colour }} />}
    </span>
  );
}

interface RankRowProps {
  readonly row: Row;
  readonly group: Group;
  readonly scale: number;
  readonly colour: string;
  readonly setup: Setup | undefined;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onSelectItem: (itemId: string) => void;
}

function RankRow({ row, group, scale, colour, setup, open, onToggle, onSelectItem }: RankRowProps) {
  const expandable = row.items !== undefined && (row.items.length > 0 || row.more !== undefined);
  // Every row holds cells only. The first cell holds the expand button (chevron and name), so the
  // button is one stop in the row and the other cells stay cells a reader can step through.
  const first = expandable ? (
    <Button variant="plain" className="ins-rank-toggle" aria-expanded={open} onClick={onToggle}>
      <span className="ins-chevron" aria-hidden="true">
        {open ? "⌄" : "›"}
      </span>
      <span className="ins-rank-name">{row.name}</span>
    </Button>
  ) : (
    <>
      <span className="ins-chevron" aria-hidden="true" />
      <span className="ins-rank-name">
        {row.itemId === undefined ? (
          row.name
        ) : (
          <Button variant="quiet" onClick={() => onSelectItem(row.itemId!)}>
            {row.name}
          </Button>
        )}
      </span>
    </>
  );
  return (
    <>
      <div role="row" className="ins-rank-row">
        <span role="cell" className="ins-rank-first">
          {first}
        </span>
        <span role="cell" className="ins-rank-cell ins-rank-agents">
          {(row.agentIds ?? []).map((agentId) => (
            <AgentRing key={agentId} agentId={agentId} agents={setup?.agents ?? []} />
          ))}
        </span>
        {group === "step" && (
          <span role="cell" className="ins-rank-cell">
            {row.model !== undefined && (
              <span className="ins-model" title={row.model}>
                <BackendMark cliId={row.cliId} size={12} />
                <span className="mono ins-model-name">{shortModel(row.model)}</span>
              </span>
            )}
          </span>
        )}
        <Bar value={row.value} scale={scale} colour={colour} />
        <span role="cell" className="mono ins-rank-num ins-rank-value">
          {row.text}
        </span>
        <span role="cell" className="ins-rank-num ins-rank-facts">
          {row.facts}
        </span>
      </div>
      {open && row.items?.map((item) => <SubLine key={item.itemId} item={item} scale={scale} colour={colour} onSelectItem={onSelectItem} />)}
      {open && row.more !== undefined && (
        <div role="row" className="ins-rank-row ins-rank-sub">
          <span role="cell" className="ins-rank-first ins-sub-first muted">
            {TEXT.more(row.more.count)}
          </span>
          <span role="cell" />
          <span role="cell" />
          <span role="cell" />
          <span role="cell" className="mono ins-rank-num ins-rank-value">
            {row.more.text}
          </span>
          <span role="cell" />
        </div>
      )}
    </>
  );
}

function SubLine({ item, scale, colour, onSelectItem }: { readonly item: SubRow; readonly scale: number; readonly colour: string; readonly onSelectItem: (itemId: string) => void }) {
  return (
    <div role="row" className="ins-rank-row ins-rank-sub">
      <span role="cell" className="ins-rank-first ins-sub-first">
        <span className="ins-rank-name">
          <Button variant="quiet" onClick={() => onSelectItem(item.itemId)}>
            {item.title}
          </Button>
        </span>
      </span>
      <span role="cell" />
      <span role="cell" />
      <Bar value={item.value} scale={scale} colour={colour} thin />
      <span role="cell" className="mono ins-rank-num ins-rank-value">
        {item.text}
      </span>
      <span role="cell" className="ins-rank-num ins-rank-facts">
        {item.facts}
      </span>
    </div>
  );
}
