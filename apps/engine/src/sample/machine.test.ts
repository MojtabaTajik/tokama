import { parseItemRecord, parseQueryResult, type ItemRecord } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { sampleItems } from "./data.js";
import { sampleMachineReport } from "./machine.js";

const NOW = Date.UTC(2026, 10, 25, 14, 32, 3);

describe("sample machine", () => {
  const items: ItemRecord[] = sampleItems(NOW).map((item) => {
    const parsed = parseItemRecord(item);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error.issues));
    return parsed.value;
  });

  it("is a valid report: 30 minutes of points ending now, and a row for each running item", () => {
    const report = sampleMachineReport(items, NOW);
    expect(parseQueryResult("machine", report).ok).toBe(true);
    expect(report.points).toHaveLength(360);
    expect(report.points.at(-1)!.at).toBeLessThanOrEqual(NOW);
    expect(NOW - report.points[0]!.at).toBeLessThanOrEqual(30 * 60_000);
    const running = items.filter((item) => item.state === "running");
    expect(running.length).toBeGreaterThan(0);
    expect(report.items.map((row) => row.itemId)).toEqual(running.map((item) => item.id));
  });

  it("is the same for the same time, and every value stays in range", () => {
    expect(sampleMachineReport(items, NOW)).toEqual(sampleMachineReport(items, NOW));
    for (const p of sampleMachineReport(items, NOW).points) {
      expect(p.cpuPercent).toBeGreaterThanOrEqual(0);
      expect(p.cpuPercent).toBeLessThanOrEqual(100);
    }
  });
});
