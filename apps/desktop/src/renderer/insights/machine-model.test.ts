import { parseQueryResult, type MachineReport } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { machinePoints, machineReport } from "../testing/machine.js";
import { NOW } from "../testing/sample.js";
import { clock, clockSeconds } from "../format/time.js";
import { chartModel, cpuSplit, formatBytes, formatSize, groupItems, isLow, isOneRow, linePaths, memorySplit, nearestPoint, ofAllCores, sharePercent, tableRows, tokamaTotal, WINDOW_MS } from "./machine-model.js";

const MINUTE = 60_000;
const withPoints = (points: MachineReport["points"]): MachineReport => ({ ...machineReport, points });

describe("the machine test data", () => {
  it("matches the engine schema", () => {
    expect(parseQueryResult("machine", machineReport)).toMatchObject({ ok: true });
  });
});

describe("text", () => {
  it("shows bytes as GB from one GB up and as whole MB below", () => {
    expect(formatBytes(20.4 * 1024 ** 3)).toBe("20.4 GB");
    expect(formatBytes(182 * 1024 ** 2)).toBe("182 MB");
    expect(formatBytes(0)).toBe("0 MB");
    expect(formatSize(32 * 1024 ** 3)).toBe("32 GB");
  });

  it("shows the clock in 24 hours, local time", () => {
    const at = new Date(2025, 9, 20, 9, 5, 7).getTime();
    expect(clock(at)).toBe("09:05");
    expect(clockSeconds(at)).toBe("09:05:07");
  });

  it("turns a share of one core into a share of all cores", () => {
    expect(ofAllCores(120, 12)).toBe(10);
    expect(ofAllCores(50, 0)).toBe(50);
  });

  it("shows a share in whole percent, with one decimal only where whole would say nothing", () => {
    expect([27.4, 4.6, 0.4, 0, 0.6, 100].map(sharePercent)).toEqual(["27%", "5%", "0.4%", "0%", "1%", "100%"]);
  });
});

const GIB = 1024 ** 3;
const point = (fields: Partial<MachineReport["points"][number]>): MachineReport["points"][number] => ({ at: NOW, cpuPercent: 0, memoryUsedBytes: 0, tokamaCpuPercent: 0, tokamaMemoryBytes: 0, ...fields });

describe("the split of the machine", () => {
  it("cuts the memory into Tokama, the other apps and what is free", () => {
    expect(memorySplit(point({ memoryUsedBytes: 20 * GIB, tokamaMemoryBytes: 2 * GIB }), 32 * GIB)).toEqual({ tokama: 2 * GIB, other: 18 * GIB, rest: 12 * GIB, total: 32 * GIB });
  });

  it("cuts the CPU as a share of all cores, with Tokama's cores turned into a share of the whole", () => {
    expect(cpuSplit(point({ cpuPercent: 32, tokamaCpuPercent: 240 }), 12)).toEqual({ tokama: 20, other: 12, rest: 68, total: 100 });
  });

  it("never lets a part go below nothing or Tokama above the whole when the two readings disagree", () => {
    // Tokama's processes read a moment after the machine: more than the machine used.
    expect(memorySplit(point({ memoryUsedBytes: 2 * GIB, tokamaMemoryBytes: 3 * GIB }), 32 * GIB)).toEqual({ tokama: 3 * GIB, other: 0, rest: 30 * GIB, total: 32 * GIB });
    expect(memorySplit(point({ memoryUsedBytes: 40 * GIB, tokamaMemoryBytes: 50 * GIB }), 32 * GIB)).toMatchObject({ tokama: 32 * GIB, rest: 0 });
    expect(cpuSplit(point({ cpuPercent: 5, tokamaCpuPercent: 1200 }), 12)).toEqual({ tokama: 100, other: 0, rest: 95, total: 100 });
  });

  it("calls the memory low when under a tenth is free, and not at exactly a tenth", () => {
    const free = (fraction: number) => memorySplit(point({ memoryUsedBytes: Math.round((1 - fraction) * 100 * GIB) }), 100 * GIB);
    expect(isLow(free(0.099))).toBe(true);
    expect(isLow(free(0.1))).toBe(false);
    expect(isLow(free(0.5))).toBe(false);
    expect(isLow(memorySplit(point({}), 0))).toBe(false);
  });
});

describe("the items by memory", () => {
  type Fields = Partial<Omit<MachineReport["items"][number], "itemId">> & { itemId: string };
  const row = (fields: Fields): MachineReport["items"][number] => ({ title: "Item", role: "agent", cpuPercent: 10, memoryBytes: 100, processes: 1, ...fields }) as MachineReport["items"][number];

  it("sums the rows of one item and puts the heaviest item first", () => {
    const groups = groupItems([row({ itemId: "a", title: "Light", memoryBytes: 100 }), row({ itemId: "b", title: "Heavy", role: "check", memoryBytes: 300, processes: 4 }), row({ itemId: "b", title: "Heavy", memoryBytes: 50, processes: 2 })]);
    expect(groups.map((group) => group.title)).toEqual(["Heavy", "Light"]);
    expect(groups[0]).toMatchObject({ memoryBytes: 350, processes: 6, cpuPercent: 20 });
    // Inside an item the heaviest row is first too.
    expect(groups[0]!.rows.map((entry) => entry.role)).toEqual(["check", "agent"]);
  });

  it("keeps equal items in a fixed order: by title, then by id, and an agent before a check", () => {
    const groups = groupItems([row({ itemId: "z", title: "Same" }), row({ itemId: "y", title: "Same" }), row({ itemId: "x", title: "Earlier title" })]);
    expect(groups.map((group) => group.itemId)).toEqual(["x", "y", "z"]);
    expect(groupItems([row({ itemId: "a", role: "check" }), row({ itemId: "a", role: "agent" })])[0]!.rows.map((entry) => entry.role)).toEqual(["agent", "check"]);
  });

  it("is one row only for an item with a single agent", () => {
    const one = (rows: Fields[]) => isOneRow(groupItems(rows.map(row))[0]!);
    expect(one([{ itemId: "a", role: "agent" }])).toBe(true);
    expect(one([{ itemId: "a", role: "check" }])).toBe(false);
    expect(one([{ itemId: "a", role: "agent" }, { itemId: "a", role: "check" }])).toBe(false);
    expect(one([{ itemId: "a", role: "agent" }, { itemId: "a", role: "agent" }])).toBe(false);
  });

  it("totals the engine and every item, and counts the items", () => {
    const groups = groupItems(machineReport.items);
    const total = tokamaTotal(machineReport, groups);
    expect(total).toMatchObject({ items: 3, processes: 11, memoryBytes: (182 + 1126 + 412 + 36 + 395) * 1024 ** 2 });
    expect(total.cpuPercent).toBeCloseTo(332.4);
  });
});

describe("chartModel", () => {
  it("covers the 30 minutes up to the last reading, with ticks on the ten minute and a now label", () => {
    const model = chartModel(machineReport);
    expect(model.end - model.start).toBe(WINDOW_MS);
    expect(model.runs).toHaveLength(1);
    expect(model.unsampled).toEqual([]);
    expect(model.ticks.at(0)).toMatchObject({ align: "start", label: clock(NOW - WINDOW_MS) });
    expect(model.ticks.at(-1)).toMatchObject({ align: "end", label: `${clock(NOW)} now` });
    for (const tick of model.ticks.slice(1, -1)) expect(new Date(tick.at).getMinutes() % 10).toBe(0);
  });

  it("hatches the part before the first reading, and breaks the line where nobody asked", () => {
    const points = [...machinePoints(NOW - 20 * MINUTE).filter((p) => p.at < NOW - 12 * MINUTE), ...machinePoints(NOW - 6 * MINUTE)];
    const model = chartModel(withPoints(points));
    expect(model.runs).toHaveLength(2);
    expect(model.unsampled).toHaveLength(2);
    expect(model.unsampled[0]).toEqual({ from: NOW - 30 * MINUTE, to: NOW - 20 * MINUTE });
    expect(model.unsampled[1]!.to).toBe(NOW - 6 * MINUTE);
    expect(model.unsampled[1]!.from).toBeGreaterThan(NOW - 13 * MINUTE);
  });

  it("does not hatch a short start, and leaves out readings older than the window", () => {
    const model = chartModel(withPoints(machinePoints(NOW - 31 * MINUTE)));
    expect(model.unsampled).toEqual([]);
    expect(model.runs[0]![0]!.at).toBeGreaterThanOrEqual(model.start);
  });
});

describe("linePaths", () => {
  it("draws one move per run and closes each area to the baseline", () => {
    const points = [...machinePoints(NOW - 20 * MINUTE).filter((p) => p.at < NOW - 12 * MINUTE), ...machinePoints(NOW - 6 * MINUTE)];
    const report = withPoints(points);
    const { line, area } = linePaths(chartModel(report), 1200, 100, (p) => p.cpuPercent, 100);
    expect(line.match(/M/g)).toHaveLength(2);
    expect(area.match(/Z/g)).toHaveLength(2);
    expect(line.startsWith("M")).toBe(true);
  });

  it("keeps a value above the maximum on the chart", () => {
    const report = withPoints([{ at: NOW, cpuPercent: 100, memoryUsedBytes: 1, tokamaCpuPercent: 0, tokamaMemoryBytes: 0 }]);
    expect(linePaths(chartModel(report), 100, 50, () => 400, 100).line).toBe("M100.0 0.0");
  });
});

describe("nearestPoint and tableRows", () => {
  it("finds the reading nearest to a place in the window", () => {
    const model = chartModel(machineReport);
    expect(machineReport.points[nearestPoint(machineReport, model, 1)!]!.at).toBe(NOW);
    expect(machineReport.points[nearestPoint(machineReport, model, 0)!]!.at).toBe(NOW - WINDOW_MS);
    expect(nearestPoint(withPoints([]), chartModel(withPoints([])), 0.5)).toBeUndefined();
  });

  it("keeps one row a minute for the table", () => {
    const rows = tableRows(machineReport, chartModel(machineReport));
    expect(rows).toHaveLength(31);
    expect(rows[1]!.at - rows[0]!.at).toBe(MINUTE);
  });
});
