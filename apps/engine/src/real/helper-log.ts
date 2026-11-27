// The helper log: one line per thing a helper run did, in `<home>/helper-runs/events-<yyyy-mm>.jsonl`.
// It holds ids, times, process ids and token counts, and nothing a person wrote or an agent said:
// no path, prompt, input or answer. That keeps it small, and safe to sync later. A restart reads
// the last four monthly files to find helper processes left running, and the usage report reads the
// same lines for its helper calls.
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { appendTextSync, type Clock, type HelperCallRow, HelperIdSchema, type HelperLogLine, HelperLogLineSchema, type HelperRunId, type HostId, readTextFile } from "@tokama/core";

/** The monthly files read at start: the current month and three before it cover the longest usage range (90 days). */
const MONTHS_READ = 4;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const FILE = /^events-\d{4}-\d{2}\.jsonl$/;

/** What a caller writes: the log adds the format, host, time and run id. */
export type HelperLogEvent = HelperLogLine extends infer Line ? (Line extends HelperLogLine ? Omit<Line, "format" | "hostId" | "at" | "runId"> : never) : never;

export interface HelperLogOptions {
  readonly home: string;
  readonly hostId: HostId;
  readonly clock: Clock;
  readonly log: (message: string) => void;
}

/** A run that started a process and never ended. */
export interface LeftoverRun {
  readonly runId: HelperRunId;
  readonly pid: number;
  readonly startedAt: number;
  readonly bootTime: number;
}

export class HelperLog {
  constructor(private readonly options: HelperLogOptions) {}

  /** The folder of the log and of each run's `call.json`. */
  get dir(): string {
    return join(this.options.home, "helper-runs");
  }

  /** Adds one line. A line that cannot be written is logged, never thrown: the log is accounting, not the run. */
  append(runId: HelperRunId, event: HelperLogEvent): void {
    const { clock, hostId } = this.options;
    const at = new Date(clock.now()).toISOString();
    const line = { format: 1, hostId, at, runId, ...event } satisfies HelperLogLine;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      return this.options.log(`the helper log folder was not made: ${String(error)}`);
    }
    const written = appendTextSync(join(this.dir, `events-${at.slice(0, 7)}.jsonl`), `${JSON.stringify(line)}\n`);
    if (!written.ok) this.options.log(`the helper log was not written: ${written.error.message}`);
  }

  /** Every valid line of the last four monthly files, oldest first. A damaged line or file is skipped. */
  async read(): Promise<HelperLogLine[]> {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((name) => FILE.test(name)).sort().slice(-MONTHS_READ);
    } catch {
      return [];
    }
    const lines: HelperLogLine[] = [];
    for (const name of names) {
      const text = await readTextFile(join(this.dir, name), { maxBytes: MAX_FILE_BYTES });
      if (!text.ok) {
        this.options.log(`the helper log ${name} was not read: ${text.error.message}`);
        continue;
      }
      for (const raw of text.value.split("\n")) {
        const parsed = raw === "" ? undefined : HelperLogLineSchema.safeParse(parseJson(raw));
        if (parsed?.success === true) lines.push(parsed.data);
      }
    }
    return lines;
  }

  /** The runs of this machine that started a process and have no end line. */
  leftovers(lines: readonly HelperLogLine[]): LeftoverRun[] {
    const ended = new Set(lines.flatMap((line) => (line.type === "helper_run_ended" ? [line.runId] : [])));
    const found = new Map<string, LeftoverRun>();
    for (const line of lines) {
      if (line.type === "process_started" && line.hostId === this.options.hostId && !ended.has(line.runId)) {
        found.set(line.runId, { runId: line.runId, pid: line.pid, startedAt: line.startedAt, bootTime: line.bootTime });
      }
    }
    return [...found.values()];
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The usage rows in the lines. A call whose step id is not a helper's id is dropped: the id came from a file. */
export function helperCallRows(lines: readonly HelperLogLine[]): HelperCallRow[] {
  return lines.flatMap((line): HelperCallRow[] => {
    if (line.type !== "usage_recorded") return [];
    const helperId = HelperIdSchema.safeParse(line.usage.stepId);
    return helperId.success ? [{ helperId: helperId.data, call: line.usage }] : [];
  });
}
