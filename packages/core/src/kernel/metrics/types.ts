import type { Result } from "../result/index.js";

/** One process at one reading. */
export interface ProcessReading {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** CPU time the process has used since it started, user and system together, in ms. */
  readonly cpuMs: number;
  /** Resident memory. */
  readonly rssBytes: number;
}

export interface MemoryReading {
  readonly totalBytes: number;
  /** Memory in use that the system cannot give back at once; cache it can drop is not counted. */
  readonly usedBytes: number;
}

/** The OS-specific part of the machine readings. One implementation per OS. */
export interface MachineSource {
  memory(signal?: AbortSignal): Promise<Result<MemoryReading, string>>;
  /** Every process the user may see. A process that ends during the reading is left out. */
  processes(signal?: AbortSignal): Promise<Result<ProcessReading[], string>>;
}
