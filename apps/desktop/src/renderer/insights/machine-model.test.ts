import { parseQueryResult, type MachineReport } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { machinePoints, machineReport } from "../testing/machine.js";
import { NOW } from "../testing/sample.js";
import { chartModel, formatBytes, formatClock, formatSeconds, formatSize, linePaths, nearestPoint, ofAllCores, tableRows, WINDOW_MS } from "./machine-model.js";

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
    expect(formatClock(at)).toBe("09:05");
    expect(formatSeconds(at)).toBe("09:05:07");
  });

  it("turns a share of one core into a share of all cores", () => {
    expect(ofAllCores(120, 12)).toBe(10);
    expect(ofAllCores(50, 0)).toBe(50);
  });
});

describe("chartModel", () => {
  it("covers the 30 minutes up to the last reading, with ticks on the ten minute and a now label", () => {
    const model = chartModel(machineReport);
    expect(model.end - model.start).toBe(WINDOW_MS);
    expect(model.runs).toHaveLength(1);
    expect(model.unsampled).toEqual([]);
    expect(model.ticks.at(0)).toMatchObject({ align: "start", label: formatClock(NOW - WINDOW_MS) });
    expect(model.ticks.at(-1)).toMatchObject({ align: "end", label: `${formatClock(NOW)} now` });
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
