// The last 30 minutes of CPU and memory as two lines on one time axis (one measure per chart, one
// colour: the label column names each). Drawn in SVG from attributes, since the page allows no
// inline styles. Hatching marks stretches with no readings; the line breaks there. Hovering or
// focusing the charts (arrow keys, Home, End) shows one crosshair on both and a tooltip with the
// readings and Tokama's share. A hidden table with one row a minute stands in for the lines.
import type { MachineReport } from "@tokama/core";
import { type KeyboardEvent, type MouseEvent, useEffect, useId, useRef, useState } from "react";
import { chartModel, formatBytes, formatClock, formatSeconds, formatSize, fraction, linePaths, nearestPoint, ofAllCores, onePercent, tableRows, wholePercent, type ChartModel } from "./machine-model.js";

const HEIGHT = 96;
const DEFAULT_WIDTH = 720;

const TEXT = {
  cpu: "CPU",
  memory: "Memory",
  cpuRange: "0% – 100%",
  cpuAria: (from: string) => `CPU over the last 30 minutes, from ${from}`,
  memoryAria: (from: string) => `Memory over the last 30 minutes, from ${from}`,
  group: "Readings over the last 30 minutes",
  share: "Tokama share",
  table: "CPU and memory, one reading a minute",
  time: "Time",
  tokama: "Tokama",
} as const;

interface RowProps {
  readonly label: string;
  readonly range: string;
  readonly aria: string;
  readonly model: ChartModel;
  readonly report: MachineReport;
  readonly width: number;
  readonly value: (point: MachineReport["points"][number]) => number;
  readonly max: number;
  readonly top: string;
  readonly hovered: number | undefined;
  readonly plotRef?: (element: HTMLDivElement | null) => void;
  readonly onMove: (event: MouseEvent<HTMLDivElement>) => void;
}

function ChartRow({ label, range, aria, model, report, width, value, max, top, hovered, plotRef, onMove }: RowProps) {
  const id = useId();
  const paths = linePaths(model, width, HEIGHT, value, max);
  const last = report.points.at(-1);
  const hoveredPoint = hovered === undefined ? undefined : report.points[hovered];
  const y = (point: NonNullable<typeof last>) => HEIGHT - Math.min(1, Math.max(0, value(point) / max)) * HEIGHT;
  return (
    <div className="mc-row">
      <div className="mc-label">
        <span className="mc-name">{label}</span>
        <span className="mono muted">{range}</span>
      </div>
      <div className="mc-plot" ref={plotRef} onMouseMove={onMove}>
        <svg className="mc-svg" width={width} height={HEIGHT} role="img" aria-label={aria}>
          <defs>
            <pattern id={id} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(135)">
              <line className="mc-hatch" x1="0" y1="0" x2="0" y2="7" />
            </pattern>
          </defs>
          {model.unsampled.map((gap) => (
            <rect key={gap.from} className="mc-gap" x={fraction(model, gap.from) * width} y={0} width={Math.max(0, (fraction(model, gap.to) - fraction(model, gap.from)) * width)} height={HEIGHT} fill={`url(#${id})`} />
          ))}
          <text className="mc-top" x={width - 4} y={12} textAnchor="end">
            {top}
          </text>
          <path className="mc-area" d={paths.area} />
          <path className="mc-line" d={paths.line} />
          {hoveredPoint !== undefined && (
            <g aria-hidden="true">
              <line className="mc-cross" x1={fraction(model, hoveredPoint.at) * width} x2={fraction(model, hoveredPoint.at) * width} y1={-6} y2={HEIGHT + 6} />
              <circle className="mc-hover-dot" cx={fraction(model, hoveredPoint.at) * width} cy={y(hoveredPoint)} r={5} />
            </g>
          )}
          {last !== undefined && <circle className="mc-now-dot" cx={fraction(model, last.at) * width} cy={y(last)} r={4} aria-hidden="true" />}
        </svg>
      </div>
    </div>
  );
}

export function MachineChart({ report }: { readonly report: MachineReport }) {
  const model = chartModel(report);
  const first = report.points.find((p) => p.at >= model.start);
  const from = formatClock(first?.at ?? model.start);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const plot = useRef<HTMLDivElement | null>(null);
  // The reading under the pointer or the keys, by its time: the report changes every few seconds
  // and its readings shift, so an index would drift to another reading.
  const [hoveredAt, setHoveredAt] = useState<number | undefined>(undefined);
  const found = hoveredAt === undefined ? -1 : report.points.findIndex((p) => p.at === hoveredAt);
  const hovered = found === -1 ? undefined : found;
  const setHovered = (index: number | undefined) => setHoveredAt(index === undefined ? undefined : report.points[index]?.at);

  useEffect(() => {
    const element = plot.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => entry !== undefined && entry.contentRect.width > 0 && setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const move = (event: MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return;
    setHovered(nearestPoint(report, model, Math.min(1, Math.max(0, (event.clientX - box.left) / box.width))));
  };
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    const inWindow = report.points.map((p, i) => (p.at >= model.start ? i : -1)).filter((i) => i >= 0);
    const at = hovered === undefined ? -1 : inWindow.indexOf(hovered);
    const next = { ArrowLeft: at < 0 ? inWindow.length - 1 : at - 1, ArrowRight: at + 1, Home: 0, End: inWindow.length - 1 }[event.key];
    if (next === undefined || inWindow.length === 0) return;
    event.preventDefault();
    setHovered(inWindow[Math.max(0, Math.min(inWindow.length - 1, next))]);
  };

  const point = hovered === undefined ? undefined : report.points[hovered];
  return (
    <div
      className="mc-chart"
      role="group"
      aria-label={TEXT.group}
      tabIndex={0}
      onKeyDown={key}
      onFocus={() => hovered === undefined && setHovered(report.points.length - 1)}
      onBlur={() => setHovered(undefined)}
      onMouseLeave={() => setHovered(undefined)}
    >
      <ChartRow
        label={TEXT.cpu}
        range={TEXT.cpuRange}
        aria={TEXT.cpuAria(from)}
        model={model}
        report={report}
        width={width}
        value={(p) => p.cpuPercent}
        max={100}
        top="100%"
        hovered={hovered}
        plotRef={(element) => void (plot.current = element)}
        onMove={move}
      />
      <ChartRow
        label={TEXT.memory}
        range={`0 – ${formatSize(report.memoryTotalBytes)}`}
        aria={TEXT.memoryAria(from)}
        model={model}
        report={report}
        width={width}
        value={(p) => p.memoryUsedBytes}
        max={report.memoryTotalBytes}
        top={formatSize(report.memoryTotalBytes)}
        hovered={hovered}
        onMove={move}
      />
      <div className="mc-row">
        <span />
        <svg className="mc-axis" width={width} height={18} aria-hidden="true">
          {model.ticks.map((tick) => (
            <text key={tick.at} className="mc-tick" x={fraction(model, tick.at) * width} y={13} textAnchor={tick.align}>
              {tick.label}
            </text>
          ))}
        </svg>
      </div>
      {point !== undefined && (
        <div className="mc-tip" role="status" data-side={fraction(model, point.at) < 0.5 ? "right" : "left"}>
          <p className="mc-tip-time mono">{formatSeconds(point.at)}</p>
          <p className="mc-tip-line">
            <span>{TEXT.cpu}</span>
            <b className="mono">{wholePercent(point.cpuPercent)}</b>
          </p>
          <p className="mc-tip-line">
            <span>{TEXT.memory}</span>
            <b className="mono">{formatBytes(point.memoryUsedBytes)}</b>
          </p>
          <p className="mc-tip-line">
            <span>{TEXT.share}</span>
            <b className="mono">
              {onePercent(ofAllCores(point.tokamaCpuPercent, report.cores))} · {formatBytes(point.tokamaMemoryBytes)}
            </b>
          </p>
        </div>
      )}
      <table className="visually-hidden">
        <caption>{TEXT.table}</caption>
        <thead>
          <tr>
            <th scope="col">{TEXT.time}</th>
            <th scope="col">{TEXT.cpu}</th>
            <th scope="col">{TEXT.memory}</th>
            <th scope="col">{`${TEXT.tokama} ${TEXT.cpu}`}</th>
            <th scope="col">{`${TEXT.tokama} ${TEXT.memory}`}</th>
          </tr>
        </thead>
        <tbody>
          {tableRows(report, model).map((row) => (
            <tr key={row.at}>
              <th scope="row">{formatSeconds(row.at)}</th>
              <td>{wholePercent(row.cpuPercent)}</td>
              <td>{formatBytes(row.memoryUsedBytes)}</td>
              <td>{onePercent(ofAllCores(row.tokamaCpuPercent, report.cores))}</td>
              <td>{formatBytes(row.tokamaMemoryBytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
