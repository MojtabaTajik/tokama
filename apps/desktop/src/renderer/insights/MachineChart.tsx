// The last 30 minutes of CPU and memory, one chart each on its own scale (CPU 0 to 100%, memory 0 to
// the machine's size) on one time axis. Each chart has two lines: all apps in grey, Tokama's own in
// teal over a light wash; the label column is the legend and says the readings now. Drawn in SVG
// from attributes, since the page allows no inline styles. Hatching marks stretches with no
// readings; the lines break there. Hovering or focusing the charts (arrow keys, Home, End) shows one
// crosshair on both and one tooltip with both lines' readings. A hidden table with one row a minute
// stands in for the lines.
import type { MachinePoint, MachineReport } from "@tokama/core";
import { type KeyboardEvent, type MouseEvent, useEffect, useId, useRef, useState } from "react";
import { clock, clockSeconds } from "../format/time.js";
import { chartModel, formatBytes, formatSize, fraction, linePaths, nearestPoint, ofAllCores, onePercent, sharePercent, tableRows, type ChartModel } from "./machine-model.js";

const HEIGHT = 96;
const DEFAULT_WIDTH = 720;

const TEXT = {
  cpu: "CPU",
  memory: "Memory",
  tokama: "Tokama",
  all: "All apps",
  aria: (name: string, from: string) => `${name} over the last 30 minutes, from ${from}: Tokama and all apps`,
  group: "Readings over the last 30 minutes",
  table: "CPU and memory, one reading a minute",
  time: "Time",
} as const;

/** One measure: how to read it from a reading, how to write it, and where its scale ends. */
interface Measure {
  readonly name: string;
  readonly tokama: (point: MachinePoint) => number;
  readonly all: (point: MachinePoint) => number;
  readonly text: (value: number) => string;
  readonly max: number;
  /** The scale's top, written in the corner of the plot. */
  readonly top: string;
}

interface RowProps {
  readonly measure: Measure;
  readonly aria: string;
  readonly model: ChartModel;
  readonly report: MachineReport;
  readonly width: number;
  readonly hovered: number | undefined;
  readonly plotRef?: (element: HTMLDivElement | null) => void;
  readonly onMove: (event: MouseEvent<HTMLDivElement>) => void;
}

function ChartRow({ measure, aria, model, report, width, hovered, plotRef, onMove }: RowProps) {
  const id = useId();
  const tokama = linePaths(model, width, HEIGHT, measure.tokama, measure.max);
  const all = linePaths(model, width, HEIGHT, measure.all, measure.max);
  const last = report.points.at(-1);
  const hoveredPoint = hovered === undefined ? undefined : report.points[hovered];
  const y = (value: number) => HEIGHT - Math.min(1, Math.max(0, value / measure.max)) * HEIGHT;
  const dots = (point: MachinePoint, className: string, radius: number) => (
    <>
      <circle className={`${className} mc-dot-all`} cx={fraction(model, point.at) * width} cy={y(measure.all(point))} r={radius} />
      <circle className={`${className} mc-dot-tokama`} cx={fraction(model, point.at) * width} cy={y(measure.tokama(point))} r={radius} />
    </>
  );
  return (
    <div className="mc-row">
      <div className="mc-label">
        <span className="mc-name">{measure.name}</span>
        {last !== undefined &&
          (
            [
              ["tokama", TEXT.tokama, measure.tokama(last)],
              ["all", TEXT.all, measure.all(last)],
            ] as const
          ).map(([line, name, value]) => (
            <span key={line} className="mc-legend muted">
              <span className="mc-line-key" data-line={line} aria-hidden="true" />
              {name}
              <b className="mono">{measure.text(value)}</b>
            </span>
          ))}
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
          <text className="mc-top" x={4} y={12}>
            {measure.top}
          </text>
          <path className="mc-area" d={tokama.area} />
          <path className="mc-line mc-line-all" d={all.line} />
          <path className="mc-line mc-line-tokama" d={tokama.line} />
          {hoveredPoint !== undefined && (
            <g aria-hidden="true">
              <line className="mc-cross" x1={fraction(model, hoveredPoint.at) * width} x2={fraction(model, hoveredPoint.at) * width} y1={-6} y2={HEIGHT + 6} />
              {dots(hoveredPoint, "mc-hover-dot", 5)}
            </g>
          )}
          {last !== undefined && <g aria-hidden="true">{dots(last, "mc-now-dot", 4)}</g>}
        </svg>
      </div>
    </div>
  );
}

export function MachineChart({ report }: { readonly report: MachineReport }) {
  const model = chartModel(report);
  const first = report.points.find((p) => p.at >= model.start);
  const from = clock(first?.at ?? model.start);
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

  const cpu: Measure = { name: TEXT.cpu, tokama: (p) => ofAllCores(p.tokamaCpuPercent, report.cores), all: (p) => p.cpuPercent, text: sharePercent, max: 100, top: "100%" };
  const memory: Measure = { name: TEXT.memory, tokama: (p) => p.tokamaMemoryBytes, all: (p) => p.memoryUsedBytes, text: formatBytes, max: report.memoryTotalBytes, top: formatSize(report.memoryTotalBytes) };
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
      <ChartRow measure={cpu} aria={TEXT.aria(TEXT.cpu, from)} model={model} report={report} width={width} hovered={hovered} plotRef={(element) => void (plot.current = element)} onMove={move} />
      <ChartRow measure={memory} aria={TEXT.aria(TEXT.memory, from)} model={model} report={report} width={width} hovered={hovered} onMove={move} />
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
          <p className="mc-tip-time mono">{clockSeconds(point.at)}</p>
          <span className="mc-tip-head mc-legend">
            <span className="mc-line-key" data-line="tokama" aria-hidden="true" />
            {TEXT.tokama}
          </span>
          <span className="mc-tip-head mc-legend">
            <span className="mc-line-key" data-line="all" aria-hidden="true" />
            {TEXT.all}
          </span>
          {[cpu, memory].map((measure) => (
            <TipRow key={measure.name} measure={measure} point={point} />
          ))}
        </div>
      )}
      <table className="visually-hidden">
        <caption>{TEXT.table}</caption>
        <thead>
          <tr>
            <th scope="col">{TEXT.time}</th>
            <th scope="col">{`${TEXT.all} ${TEXT.cpu}`}</th>
            <th scope="col">{`${TEXT.all} ${TEXT.memory}`}</th>
            <th scope="col">{`${TEXT.tokama} ${TEXT.cpu}`}</th>
            <th scope="col">{`${TEXT.tokama} ${TEXT.memory}`}</th>
          </tr>
        </thead>
        <tbody>
          {tableRows(report, model).map((row) => (
            <tr key={row.at}>
              <th scope="row">{clockSeconds(row.at)}</th>
              <td>{sharePercent(row.cpuPercent)}</td>
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

function TipRow({ measure, point }: { readonly measure: Measure; readonly point: MachinePoint }) {
  return (
    <>
      <span className="mc-tip-name">{measure.name}</span>
      <b className="mono">{measure.text(measure.tokama(point))}</b>
      <b className="mono">{measure.text(measure.all(point))}</b>
    </>
  );
}
