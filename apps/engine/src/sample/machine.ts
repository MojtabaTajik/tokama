// Sample machine readings for the fake engine mode: the last 30 minutes drawn from smooth curves,
// the same shape on every start, and one process group for each running sample item: the agent's
// while the item's current step has an agent, else a check's.
import type { ItemRecord, MachineReport, MachinePoint } from "@tokama/core";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const EVERY_MS = 5_000;
const POINTS = 360;
const CORES = 10;
const TOTAL = 48 * GIB;

const round1 = (value: number) => Math.round(value * 10) / 10;

export function sampleMachineReport(items: readonly ItemRecord[], now: number): MachineReport {
  const end = Math.floor(now / EVERY_MS) * EVERY_MS;
  const running = items.filter((item) => item.state === "running");
  const points: MachinePoint[] = [];
  for (let i = 0; i < POINTS; i++) {
    const at = end - (POINTS - 1 - i) * EVERY_MS;
    const t = at / 1000;
    const cpuPercent = round1(34 + 22 * Math.sin(t / 97) + 9 * Math.sin(t / 23));
    const tokamaCpuPercent = round1((running.length === 0 ? 0 : 60 + 40 * Math.sin(t / 41) ** 2) * running.length + 3);
    points.push({
      at,
      cpuPercent,
      memoryUsedBytes: Math.round(31 * GIB + 2 * GIB * Math.sin(t / 311)),
      tokamaCpuPercent,
      tokamaMemoryBytes: Math.round(180 * MIB + running.length * 420 * MIB + 40 * MIB * Math.sin(t / 53)),
    });
  }
  const last = points.at(-1) as MachinePoint;
  return {
    asOf: last.at,
    everyMs: EVERY_MS,
    cores: CORES,
    memoryTotalBytes: TOTAL,
    load: [3.2, 2.8, 2.4],
    points,
    engine: { cpuPercent: 3, memoryBytes: 180 * MIB, processes: 1 },
    items: running.map((item, index) => ({
      itemId: item.id,
      title: item.title,
      role: item.steps.find((step) => step.state !== "passed")?.agentId === undefined ? ("check" as const) : ("agent" as const),
      cpuPercent: round1(60 + 25 * ((index * 7) % 3)),
      memoryBytes: 420 * MIB + index * 64 * MIB,
      processes: 4 + index,
    })),
  };
}
