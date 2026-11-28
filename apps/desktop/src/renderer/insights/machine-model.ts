// Numbers and shapes for the Machine tab: byte and percent text, and the chart's time window with
// the runs of readings it draws and the stretches that have none.
import type { ItemProcessSetUsage, MachinePoint, MachineReport } from "@tokama/core";
import { clock } from "../format/time.js";

export const WINDOW_MS = 30 * 60_000;
const GIB = 1024 ** 3;
const MINUTE = 60_000;

export { formatBytes } from "../format/bytes.js";

/** The machine's size, which is a round number: `32 GB`. */
export function formatSize(bytes: number): string {
  return `${Math.round(bytes / GIB)} GB`;
}

export const onePercent = (value: number): string => `${value.toFixed(1)}%`;

/** Whole percent, but one decimal for a share that would round to nothing: `27%`, `0.4%`, `0%`. */
export const sharePercent = (value: number): string => (value > 0 && Math.round(value) === 0 ? onePercent(value) : `${Math.round(value)}%`);

/** Process CPU is a share of one core in the report; the page shows a share of all cores. */
export const ofAllCores = (cpuPercent: number, cores: number): number => cpuPercent / Math.max(1, cores);

/** A whole (the memory, or all the CPU) cut into what Tokama uses, what the other apps use and what is left. */
export interface Split {
  readonly tokama: number;
  readonly other: number;
  readonly rest: number;
  readonly total: number;
}

/**
 * What is used is clamped to the whole, and Tokama's part to what is used, so the three parts always
 * add up to the whole: the machine's reading and Tokama's processes' reading come from different
 * sources and may disagree.
 */
function split(total: number, tokama: number, used: number): Split {
  const all = Math.min(total, Math.max(0, used));
  const own = Math.min(all, Math.max(0, tokama));
  return { tokama: own, other: all - own, rest: total - all, total };
}

export const memorySplit = (now: MachinePoint, totalBytes: number): Split => split(totalBytes, now.tokamaMemoryBytes, now.memoryUsedBytes);

/** In percent of all cores, so the whole is 100. */
export const cpuSplit = (now: MachinePoint, cores: number): Split => split(100, ofAllCores(now.tokamaCpuPercent, cores), now.cpuPercent);

/** What is left of the memory under which the page warns. */
const LOW_FREE_FRACTION = 0.1;
export const isLow = (memory: Split): boolean => memory.total > 0 && memory.rest / memory.total < LOW_FREE_FRACTION;

/** What Tokama runs for one item: its agent and checks, with their sums. */
export interface ItemGroup {
  readonly itemId: ItemProcessSetUsage["itemId"];
  readonly title: string;
  /** Heaviest memory first. */
  readonly rows: readonly ItemProcessSetUsage[];
  readonly cpuPercent: number;
  readonly memoryBytes: number;
  readonly processes: number;
}

const sum = (rows: readonly ItemProcessSetUsage[], key: "cpuPercent" | "memoryBytes" | "processes"): number => rows.reduce((total, row) => total + row[key], 0);

/** The rows of the report by item, the heaviest memory first; equal ones by title, then id, so the order holds still between readings. */
export function groupItems(rows: readonly ItemProcessSetUsage[]): ItemGroup[] {
  const byItem = new Map<string, ItemProcessSetUsage[]>();
  for (const row of rows) byItem.set(row.itemId, [...(byItem.get(row.itemId) ?? []), row]);
  return [...byItem.values()]
    .map((own) => {
      const ordered = own.toSorted((a, b) => b.memoryBytes - a.memoryBytes || (a.role === b.role ? 0 : a.role === "agent" ? -1 : 1));
      const [first] = ordered as [ItemProcessSetUsage, ...ItemProcessSetUsage[]];
      return { itemId: first.itemId, title: first.title, rows: ordered, cpuPercent: sum(own, "cpuPercent"), memoryBytes: sum(own, "memoryBytes"), processes: sum(own, "processes") };
    })
    .sort((a, b) => b.memoryBytes - a.memoryBytes || a.title.localeCompare(b.title) || (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));
}

/** An item with one agent and nothing else is one row; anything more (a check, a second agent) goes under the item. */
export const isOneRow = (group: ItemGroup): boolean => group.rows.length === 1 && group.rows[0]?.role === "agent";

/** Everything Tokama runs: the engine and every item. */
export function tokamaTotal(report: MachineReport, groups: readonly ItemGroup[]) {
  return {
    items: groups.length,
    processes: report.engine.processes + sum(report.items, "processes"),
    cpuPercent: report.engine.cpuPercent + sum(report.items, "cpuPercent"),
    memoryBytes: report.engine.memoryBytes + sum(report.items, "memoryBytes"),
  };
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
  const ticks: Tick[] = [{ at: start, label: clock(start), align: "start" }];
  // Marks on the ten minute, kept off the two ends so their labels do not touch.
  for (let at = Math.ceil(start / (10 * MINUTE)) * 10 * MINUTE; at < end; at += 10 * MINUTE) {
    if (at - start > 6 * MINUTE && end - at > 6 * MINUTE) ticks.push({ at, label: clock(at), align: "middle" });
  }
  ticks.push({ at: end, label: `${clock(end)} now`, align: "end" });
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
