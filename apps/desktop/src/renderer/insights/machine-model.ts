// Numbers and shapes for the Machine tab: byte and percent text, and the chart's time window with
// the runs of readings it draws and the stretches that have none.
import type { MachinePoint, MachineReport } from "@tokama/core";

export const WINDOW_MS = 30 * 60_000;
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const MINUTE = 60_000;

/** `20.4 GB` from one GB up, else whole MB. */
export function formatBytes(bytes: number): string {
  return bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GB` : `${Math.round(bytes / MIB)} MB`;
}

/** The machine's size, which is a round number: `32 GB`. */
export function formatSize(bytes: number): string {
  return `${Math.round(bytes / GIB)} GB`;
}

export const wholePercent = (value: number): string => `${Math.round(value)}%`;
export const onePercent = (value: number): string => `${value.toFixed(1)}%`;

/** Process CPU is a share of one core in the report; the page shows a share of all cores. */
export const ofAllCores = (cpuPercent: number, cores: number): number => cpuPercent / Math.max(1, cores);

const two = (n: number) => String(n).padStart(2, "0");
export function formatClock(at: number): string {
  const date = new Date(at);
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}
export function formatSeconds(at: number): string {
  return `${formatClock(at)}:${two(new Date(at).getSeconds())}`;
}

export interface Tick {
  readonly at: number;
  readonly label: string;
  /** The SVG text-anchor: a label that starts at its time, is centred on it, or ends at it. */
  readonly align: "start" | "middle" | "end";
}

export interface ChartModel {
  readonly start: number;
  readonly end: number;
  /** Readings in time order, split where nobody was asking (the line breaks there). */
  readonly runs: readonly (readonly MachinePoint[])[];
  /** Stretches of the window with no reading, for the hatching. */
  readonly unsampled: readonly { readonly from: number; readonly to: number }[];
  readonly ticks: readonly Tick[];
}

/** The window ends at the last reading and reaches 30 minutes back. */
export function chartModel(report: MachineReport): ChartModel {
  const end = report.asOf;
  const start = end - WINDOW_MS;
  const maxStep = report.everyMs * 3;
  const points = report.points.filter((p) => p.at >= start);
  const runs: MachinePoint[][] = [];
  const unsampled: { from: number; to: number }[] = [];
  const first = points[0];
  if (first !== undefined && first.at - start > maxStep) unsampled.push({ from: start, to: first.at });
  for (const point of points) {
    const run = runs.at(-1);
    const previous = run?.at(-1);
    if (run === undefined || previous === undefined || point.at - previous.at > maxStep) {
      if (previous !== undefined) unsampled.push({ from: previous.at, to: point.at });
      runs.push([point]);
    } else run.push(point);
  }
  const ticks: Tick[] = [{ at: start, label: formatClock(start), align: "start" }];
  // Marks on the ten minute, kept off the two ends so their labels do not touch.
  for (let at = Math.ceil(start / (10 * MINUTE)) * 10 * MINUTE; at < end; at += 10 * MINUTE) {
    if (at - start > 6 * MINUTE && end - at > 6 * MINUTE) ticks.push({ at, label: formatClock(at), align: "middle" });
  }
  ticks.push({ at: end, label: `${formatClock(end)} now`, align: "end" });
  return { start, end, runs, unsampled, ticks };
}

/** Where `at` lies in the window, 0 to 1. */
export const fraction = (model: ChartModel, at: number): number => (at - model.start) / (model.end - model.start);

/** The reading nearest to `fractionOfWindow`, as an index into `report.points`; undefined when there are none in the window. */
export function nearestPoint(report: MachineReport, model: ChartModel, fractionOfWindow: number): number | undefined {
  const target = model.start + fractionOfWindow * (model.end - model.start);
  let best: number | undefined;
  report.points.forEach((point, index) => {
    if (point.at < model.start) return;
    if (best === undefined || Math.abs(point.at - target) < Math.abs((report.points[best]?.at ?? 0) - target)) best = index;
  });
  return best;
}

/** One SVG path through every run, and the same closed to the baseline for the soft fill. */
export function linePaths(model: ChartModel, width: number, height: number, value: (p: MachinePoint) => number, max: number): { line: string; area: string } {
  const x = (at: number) => (fraction(model, at) * width).toFixed(1);
  const y = (p: MachinePoint) => (height - Math.min(1, Math.max(0, value(p) / max)) * height).toFixed(1);
  let line = "";
  let area = "";
  for (const run of model.runs) {
    const [head] = run;
    const last = run.at(-1);
    if (head === undefined || last === undefined) continue;
    const through = run.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.at)} ${y(p)}`).join(" ");
    line += `${line === "" ? "" : " "}${through}`;
    area += `${area === "" ? "" : " "}${through} L${x(last.at)} ${height} L${x(head.at)} ${height} Z`;
  }
  return { line, area };
}

/** Readings one minute apart at most, for the table that stands in for the chart. */
export function tableRows(report: MachineReport, model: ChartModel): MachinePoint[] {
  const rows: MachinePoint[] = [];
  let lastShown = -Infinity;
  for (const point of report.points) {
    if (point.at < model.start || point.at - lastShown < MINUTE) continue;
    rows.push(point);
    lastShown = point.at;
  }
  return rows;
}
