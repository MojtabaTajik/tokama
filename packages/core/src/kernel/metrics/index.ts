// kernel/metrics: read-only readings of this machine, behind one interface with one
// implementation per OS.
import type { ProcessRunner } from "../process/index.js";
import { createLinuxSource } from "./linux.js";
import { createMacosSource } from "./macos.js";
import type { MachineSource } from "./types.js";

export { createLinuxSource, parseMeminfo, parseProcStat, parseStatusRss } from "./linux.js";
export { createMacosSource, parseCpuTime, parsePs, parseVmStat } from "./macos.js";
export type { MachineSource, MemoryReading, ProcessReading } from "./types.js";

/** The source for this OS, or undefined where there is none yet (Windows). */
export function createMachineSource(runner: ProcessRunner, platform: NodeJS.Platform = process.platform): MachineSource | undefined {
  if (platform === "darwin") return createMacosSource(runner);
  if (platform === "linux") return createLinuxSource();
  return undefined;
}
