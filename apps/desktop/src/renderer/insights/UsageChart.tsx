// Tokens or estimated cost by day, stacked by workflow. Columns in SVG drawn from attributes (the
// page allows no inline styles): thin bars, a 2px gap between segments, a rounded top. Each
// workflow keeps its tag colour whatever the filter, and its name and icon are always beside the
// colour (legend, tooltip, table), so identity is never colour alone. Hovering or focusing a day
// lists its workflows with their share and items; clicking a segment or a legend entry filters.
// The days are one tab stop: arrow keys, Home and End move between them (each a labelled image).
import type { Setup, UsageReport } from "@tokama/core";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { TemplateIcon, tagOf } from "../shell/TemplateIcon.js";
import { type ChartModel, chartModel, formatCost, formatTokens, type Metric, share, templateFor, tickLabel, workflowName } from "./usage-model.js";

const HEIGHT = 200;
const GUTTER = 44;
const AXIS = 22;
const BAR_MAX = 24;
const GAP = 2;
const RADIUS = 4;

const TEXT = {
  table: "Usage by day and workflow",
  days: "Days",
  day: "Day",
  total: "Total",
  items: (n: number) => (n === 1 ? "1 item" : `${n} items`),
  noUsage: "no agent calls",
} as const;

export interface UsageChartProps {
  readonly report: UsageReport;
  readonly setup: Setup | undefined;
  readonly metric: Metric;
  /** The workflow the page is filtered to. */
  readonly filter: string | undefined;
  readonly onFilter: (templateId: string | undefined) => void;
}

const valueText = (value: number, metric: Metric) => (metric === "cost" ? formatCost(value) : formatTokens(value));

/** A bar segment with only its top corners rounded. */
function segmentPath(x: number, y: number, width: number, height: number, top: boolean): string {
  const r = top ? Math.min(RADIUS, height, width / 2) : 0;
  return `M${x},${y + height}V${y + r}${r > 0 ? `Q${x},${y} ${x + r},${y}` : ""}H${x + width - r}${r > 0 ? `Q${x + width},${y} ${x + width},${y + r}` : ""}V${y + height}Z`;
}

export function UsageChart({ report, setup, metric, filter, onFilter }: UsageChartProps) {
  const model = chartModel(report, metric, setup);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hovered, setHovered] = useState<number | undefined>(undefined);
  // The day that takes the tab stop: today until the keys move it.
  const [current, setCurrent] = useState<number | undefined>(undefined);
  const columns = useRef<(SVGGElement | null)[]>([]);
  const last = model.columns.length - 1;
  const active = Math.min(current ?? last, last);
  const move = (event: KeyboardEvent<SVGGElement>, index: number) => {
    const next = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: last }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const target = Math.max(0, Math.min(last, next));
    setCurrent(target);
    columns.current[target]?.focus();
  };
  useEffect(() => {
    const element = box.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => entry !== undefined && entry.contentRect.width > 0 && setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const plotWidth = Math.max(100, width - GUTTER);
  const slot = plotWidth / Math.max(1, model.columns.length);
  const bar = Math.max(2, Math.min(BAR_MAX, slot * 0.62));
  const labelEvery = model.columns.length <= 14 ? 1 : model.columns.length <= 30 ? 3 : 7;
  const y = (value: number) => HEIGHT - (value / model.max) * HEIGHT;

  return (
    <div className="ins-chart" ref={box} onMouseLeave={() => setHovered(undefined)}>
      <svg width={width} height={HEIGHT + AXIS} className="ins-svg" role="group" aria-label={TEXT.days}>
        {model.ticks.map((tick) => (
          <g key={tick} aria-hidden="true">
            <line className={tick === 0 ? "ins-baseline" : "ins-grid"} x1={GUTTER} x2={width} y1={y(tick) + 0.5} y2={y(tick) + 0.5} />
            <text className="ins-tick" x={GUTTER - 8} y={y(tick) + 4} textAnchor="end">
              {tickLabel(tick, metric)}
            </text>
          </g>
        ))}
        {model.columns.map((column, index) => {
          const x = GUTTER + index * slot + (slot - bar) / 2;
          let top = HEIGHT;
          const today = index === model.columns.length - 1;
          return (
            <g
              key={column.date}
              className="ins-col"
              ref={(element) => void (columns.current[index] = element)}
              role="img"
              tabIndex={index === active ? 0 : -1}
              aria-label={dayLabel(column, model, metric, setup)}
              onKeyDown={(event) => move(event, index)}
              onMouseEnter={() => setHovered(index)}
              onFocus={() => setHovered(index)}
              onBlur={() => setHovered(undefined)}
            >
              <rect className="ins-hit" data-today={today || undefined} x={GUTTER + index * slot} y={0} width={slot} height={HEIGHT} />
              {column.segments.map((segment, s) => {
                const height = Math.max(1, (segment.value / model.max) * HEIGHT - (s > 0 ? GAP : 0));
                top -= height + (s > 0 ? GAP : 0);
                const template = templateFor(segment.templateId, setup);
                return (
                  <path
                    key={segment.templateId}
                    className="ins-seg"
                    data-tag={tagOf(template?.color) ?? "slate"}
                    data-dim={filter !== undefined && filter !== segment.templateId ? "true" : undefined}
                    d={segmentPath(x, top, bar, height, s === column.segments.length - 1)}
                    onClick={() => onFilter(filter === segment.templateId ? undefined : segment.templateId)}
                  />
                );
              })}
              {(index % labelEvery === 0 || today) && (
                <text className="ins-day" data-today={today || undefined} x={GUTTER + index * slot + slot / 2} y={HEIGHT + 16} textAnchor="middle">
                  {model.columns.length <= 14 ? `${column.weekday} ${column.day}` : column.day}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hovered !== undefined && <DayTip report={report} model={model} index={hovered} metric={metric} setup={setup} />}
      <DataTable model={model} metric={metric} setup={setup} />
    </div>
  );
}

function dayLabel(column: ChartModel["columns"][number], model: ChartModel, metric: Metric, setup: Setup | undefined): string {
  if (column.segments.length === 0) return `${column.weekday} ${column.day}: ${TEXT.noUsage}`;
  const parts = column.segments.map((s) => `${workflowName(s.templateId, setup)} ${valueText(s.value, metric)}`);
  return `${column.weekday} ${column.day}: ${valueText(column.total, metric)}; ${parts.join(", ")}`;
}

/** The hovered day: each workflow's share and value, then the day's items. Placed on the far side of the chart from the day. */
function DayTip({ report, model, index, metric, setup }: { readonly report: UsageReport; readonly model: ChartModel; readonly index: number; readonly metric: Metric; readonly setup: Setup | undefined }) {
  const column = model.columns[index]!;
  const day = report.days[index];
  const items = (day?.workflows ?? []).flatMap((w) => w.items);
  const count = (day?.workflows ?? []).reduce((sum, w) => sum + w.itemCount, 0);
  const date = new Date(`${column.date}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  return (
    <div className="ins-tip" data-side={index < model.columns.length / 2 ? "right" : "left"} role="status">
      <p className="ins-tip-date mono">{date}</p>
      {column.segments.length === 0 ? (
        <p className="muted">{TEXT.noUsage}</p>
      ) : (
        <ul>
          {[...column.segments].reverse().map((segment) => {
            const template = templateFor(segment.templateId, setup);
            return (
              <li key={segment.templateId}>
                <svg width="12" height="4" aria-hidden="true">
                  <rect className="ins-key" data-tag={tagOf(template?.color) ?? "slate"} width="12" height="3" y="0.5" rx="1.5" />
                </svg>
                <span className="ins-tip-name">{workflowName(segment.templateId, setup)}</span>
                <strong className="mono">{share(segment.value, column.total)}%</strong>
                <span className="muted mono">{valueText(segment.value, metric)}</span>
              </li>
            );
          })}
        </ul>
      )}
      {count > 0 && (
        <p className="ins-tip-items">
          <span>{TEXT.items(count)}</span>
          <span className="muted">{items.map((item) => item.title).join(" · ")}</span>
        </p>
      )}
    </div>
  );
}

/** The chart's numbers as a table, for screen readers. */
function DataTable({ model, metric, setup }: { readonly model: ChartModel; readonly metric: Metric; readonly setup: Setup | undefined }) {
  return (
    <table className="visually-hidden">
      <caption>{TEXT.table}</caption>
      <thead>
        <tr>
          <th scope="col">{TEXT.day}</th>
          {model.series.map((id) => (
            <th key={id} scope="col">
              {workflowName(id, setup)}
            </th>
          ))}
          <th scope="col">{TEXT.total}</th>
        </tr>
      </thead>
      <tbody>
        {model.columns.map((column) => (
          <tr key={column.date}>
            <th scope="row">{column.date}</th>
            {model.series.map((id) => (
              <td key={id}>{valueText(column.segments.find((s) => s.templateId === id)?.value ?? 0, metric)}</td>
            ))}
            <td>{valueText(column.total, metric)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The legend: each workflow with its icon, name and total; pressing one filters to it. */
export function Legend({ report, setup, metric, filter, onFilter }: UsageChartProps) {
  const { series } = chartModel(report, metric, setup);
  return (
    <div className="ins-legend" role="group" aria-label="Workflows">
      {series.map((id) => {
        const template = templateFor(id, setup);
        const total = report.workflows.find((w) => w.templateId === id);
        const value = metric === "tokens" ? formatTokens(total?.tokens ?? 0) : formatCost(total?.costUsd ?? null);
        return (
          <button key={id} type="button" className="ins-legend-entry" aria-pressed={filter === id} data-dim={filter !== undefined && filter !== id ? "true" : undefined} onClick={() => onFilter(filter === id ? undefined : id)}>
            <svg width="10" height="10" aria-hidden="true">
              <rect className="ins-key" data-tag={tagOf(template?.color) ?? "slate"} width="10" height="10" rx="2" />
            </svg>
            <TemplateIcon icon={template?.icon} color={template?.color} />
            <span>{workflowName(id, setup)}</span>
            <span className="mono muted">{value}</span>
          </button>
        );
      })}
    </div>
  );
}
