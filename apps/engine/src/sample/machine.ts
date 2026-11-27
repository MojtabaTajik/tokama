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
  const engine = { cpuPercent: 3, memoryBytes: 180 * MIB, processes: 1 };
  const rows = running.map((item, index) => ({
    itemId: item.id,
    title: item.title,
    role: item.steps.find((step) => step.state !== "passed")?.agentId === undefined ? ("check" as const) : ("agent" as const),
    cpuPercent: round1(60 + 25 * ((index * 7) % 3)),
    memoryBytes: 420 * MIB + index * 64 * MIB,
    processes: 4 + index,
  }));
  // What Tokama's processes use now: the engine and every item. The last reading is exactly this; the
  // ones before it wobble below it, so Tokama's line moves and the page's summary equals its total row.
  const ownCpu = engine.cpuPercent + rows.reduce((sum, row) => sum + row.cpuPercent, 0);
  const ownMemory = engine.memoryBytes + rows.reduce((sum, row) => sum + row.memoryBytes, 0);
  const points: MachinePoint[] = [];
  for (let i = 0; i < POINTS; i++) {
    const at = end - (POINTS - 1 - i) * EVERY_MS;
    const t = at / 1000;
    const now = i === POINTS - 1;
    const tokamaCpuPercent = round1(ownCpu * (now ? 1 : 0.8 + 0.2 * Math.sin(t / 41) ** 2));
    const tokamaMemoryBytes = Math.round(ownMemory * (now ? 1 : 0.9 + 0.1 * Math.sin(t / 53) ** 2));
    // All apps include Tokama: never less than it.
    const cpuPercent = Math.min(100, Math.max(round1(34 + 22 * Math.sin(t / 97) + 9 * Math.sin(t / 23)), round1(tokamaCpuPercent / CORES + 2)));
    const memoryUsedBytes = Math.max(Math.round(31 * GIB + 2 * GIB * Math.sin(t / 311)), tokamaMemoryBytes);
    points.push({ at, cpuPercent, memoryUsedBytes, tokamaCpuPercent, tokamaMemoryBytes });
  }
  const last = points.at(-1) as MachinePoint;
  return { asOf: last.at, everyMs: EVERY_MS, cores: CORES, memoryTotalBytes: TOTAL, load: [3.2, 2.8, 2.4], points, engine, items: rows };
}
