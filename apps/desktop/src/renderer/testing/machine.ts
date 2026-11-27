// A machine report shaped like the engine's: 30 minutes of readings every 5 s ending at NOW, on
// 12 cores and 32 GB, with the engine and three running items (one with a check, one with an agent
// and a check, one with an agent alone). model.test.ts checks it against the engine schema.
import type { MachineReport } from "@tokama/core";
import { ITEMS, NOW } from "./sample.js";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** Readings from `from` to NOW every `every` ms. A wave of CPU and memory, so a hover finds distinct values. */
export function machinePoints(from: number, every = 5_000): MachineReport["points"] {
  const points: MachineReport["points"][number][] = [];
  for (let at = from; at <= NOW; at += every) {
    const n = (at - from) / every;
    points.push({ at, cpuPercent: 20 + (n % 40), memoryUsedBytes: Math.round((18 + (n % 8) / 4) * GIB), tokamaCpuPercent: 120 + (n % 30), tokamaMemoryBytes: 2 * GIB + (n % 10) * MIB });
  }
  return points;
}

export const machineReport: MachineReport = {
  asOf: NOW,
  everyMs: 5_000,
  cores: 12,
  memoryTotalBytes: 32 * GIB,
  load: [4.92, 3.8, 2.55],
  points: machinePoints(NOW - 30 * 60_000),
  engine: { cpuPercent: 4.8, memoryBytes: 182 * MIB, processes: 1 },
  items: [
    { itemId: ITEMS.verifying.id, title: ITEMS.verifying.title, role: "check", cpuPercent: 170.4, memoryBytes: 1126 * MIB, processes: 5 },
    { itemId: ITEMS.stock.id, title: ITEMS.stock.title, role: "agent", cpuPercent: 86.4, memoryBytes: 412 * MIB, processes: 3 },
    { itemId: ITEMS.stock.id, title: ITEMS.stock.title, role: "check", cpuPercent: 12, memoryBytes: 36 * MIB, processes: 1 },
    // An item with one agent and nothing else: one row.
    { itemId: ITEMS.working.id, title: ITEMS.working.title, role: "agent", cpuPercent: 58.8, memoryBytes: 395 * MIB, processes: 1 },
  ],
};

/** The same machine with 1.3 GB of its 32 GB left. */
export const lowMemory: MachineReport = {
  ...machineReport,
  points: machineReport.points.map((point) => ({ ...point, memoryUsedBytes: Math.round(30.7 * GIB), tokamaMemoryBytes: Math.round(6.8 * GIB) })),
};
