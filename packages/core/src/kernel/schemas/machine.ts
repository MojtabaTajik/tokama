// The machine report the engine serves: CPU and memory of this computer now and over the last
// half hour, and what Tokama's own processes use of it.
import { z } from "zod";
import { EpochMsSchema, ItemIdSchema } from "./ids.js";

const bytes = z.int().nonnegative();
/** Percent of one CPU core, so a process that keeps three cores busy reads 300. */
const corePercent = z.number().nonnegative();

/** One reading, taken at `at`. */
export const MachinePointSchema = z.strictObject({
  at: EpochMsSchema,
  /** All cores together, 0 to 100. */
  cpuPercent: z.number().min(0).max(100),
  memoryUsedBytes: bytes,
  /** What Tokama's processes (the engine and the running items) use of the two above. */
  tokamaCpuPercent: corePercent,
  tokamaMemoryBytes: bytes,
});

/** The CPU and memory of a set of processes. */
export const ProcessSetUsageSchema = z.strictObject({
  cpuPercent: corePercent,
  memoryBytes: bytes,
  /** Processes in the set that were running at the reading. */
  processes: z.int().nonnegative(),
});

/** One process group of a running item: its agent or one of its checks, with everything it started. */
export const ItemProcessSetUsageSchema = ProcessSetUsageSchema.extend({
  itemId: ItemIdSchema,
  title: z.string().max(500),
  role: z.enum(["agent", "check"]),
});

export const MachineReportSchema = z.strictObject({
  /** When the last reading was taken. */
  asOf: EpochMsSchema,
  /** Time between readings while a client asks. */
  everyMs: z.int().positive(),
  cores: z.int().positive(),
  memoryTotalBytes: bytes,
  /** Load average over 1, 5 and 15 minutes; 0 on a system that has none. */
  load: z.tuple([z.number().nonnegative(), z.number().nonnegative(), z.number().nonnegative()]),
  /** Oldest first, at most the last half hour; the last one is now. There are gaps where nobody asked. */
  points: z.array(MachinePointSchema).min(1).max(1000),
  engine: ProcessSetUsageSchema,
  items: z.array(ItemProcessSetUsageSchema).max(200),
});

export type MachinePoint = z.output<typeof MachinePointSchema>;
export type ProcessSetUsage = z.output<typeof ProcessSetUsageSchema>;
export type ItemProcessSetUsage = z.output<typeof ItemProcessSetUsageSchema>;
export type MachineReport = z.output<typeof MachineReportSchema>;
