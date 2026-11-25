// Samples the machine while a client asks for it. The first request starts a loop that reads every
// `everyMs`; the loop stops once nobody has asked for `idleMs`, so an idle engine reads nothing.
// The history keeps the last `historyMs`.
import { cpus, loadavg } from "node:os";
import { systemClock, type Clock, type TimerHandle } from "../../kernel/clock/index.js";
import type { MachineSource } from "../../kernel/metrics/index.js";
import { err, ok, type Result } from "../../kernel/result/index.js";
import type { ItemProcessSetUsage, MachinePoint, MachineReport, ProcessSetUsage } from "../../kernel/schemas/index.js";
import { measure, type CpuTimes, type ItemGroup, type Reading } from "./measure.js";

/** What Node's `os` module knows about the CPU; the same on every OS. */
export interface Host {
  cpuTimes(): CpuTimes;
  loadAverage(): [number, number, number];
  cores(): number;
}

export const nodeHost: Host = {
  cpuTimes() {
    let idleMs = 0;
    let totalMs = 0;
    for (const { times } of cpus()) {
      idleMs += times.idle;
      totalMs += times.user + times.nice + times.sys + times.idle + times.irq;
    }
    return { idleMs, totalMs };
  },
  loadAverage: () => loadavg() as [number, number, number],
  cores: () => Math.max(1, cpus().length),
};

/** The most points a report may hold. */
const MAX_POINTS = 1000;

export interface MonitorOptions {
  readonly source: MachineSource;
  /** The process groups of the running items. Read at every sample. */
  readonly groups: () => readonly ItemGroup[];
  readonly clock?: Clock;
  readonly host?: Host;
  /** The engine's own pid. Default: this process. */
  readonly enginePid?: number;
  /** Default: 5 s. */
  readonly everyMs?: number;
  /** Default: 30 minutes. */
  readonly historyMs?: number;
  /** The loop stops when nobody asked for this long. Default: 3 times `everyMs`. */
  readonly idleMs?: number;
  /** Time between the first two readings of a run; CPU load needs two. Default: 1 s. */
  readonly warmupMs?: number;
  readonly log?: (message: string) => void;
}

export interface Monitor {
  /** The latest readings and the history. Starts the sampling loop when it is not running. */
  report(): Promise<Result<MachineReport, string>>;
  /** Stops the loop and waits for a reading in flight. */
  close(): Promise<void>;
}

export function createMonitor(options: MonitorOptions): Monitor {
  const clock = options.clock ?? systemClock;
  const host = options.host ?? nodeHost;
  const enginePid = options.enginePid ?? process.pid;
  const everyMs = options.everyMs ?? 5_000;
  const historyMs = options.historyMs ?? 30 * 60_000;
  const idleMs = options.idleMs ?? everyMs * 3;
  const warmupMs = options.warmupMs ?? 1_000;
  const log = options.log ?? (() => {});

  let points: MachinePoint[] = [];
  let engine: ProcessSetUsage = { cpuPercent: 0, memoryBytes: 0, processes: 0 };
  let items: ItemProcessSetUsage[] = [];
  let memoryTotalBytes = 0;
  let load: [number, number, number] = [0, 0, 0];
  let lastAsked = 0;
  let closed = false;
  let timer: TimerHandle | undefined;
  /** The loop's current run: resolves after its first sample. Undefined while no loop runs. */
  let run: Promise<Result<void, string>> | undefined;
  let running: Promise<void> = Promise.resolve();

  const read = async (): Promise<Result<Reading, string>> => {
    const [memory, processes] = await Promise.all([options.source.memory(), options.source.processes()]);
    if (!memory.ok) return err(memory.error);
    if (!processes.ok) return err(processes.error);
    return ok({ at: clock.now(), cpu: host.cpuTimes(), memory: memory.value, processes: processes.value });
  };

  let wake: (() => void) | undefined;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      if (closed) return resolve();
      wake = resolve;
      timer = clock.setTimeout(resolve, ms);
    });

  const sample = async (prev: Reading): Promise<Result<Reading, string>> => {
    const cur = await read();
    if (!cur.ok) return cur;
    const m = measure(prev, cur.value, options.groups(), enginePid);
    engine = m.engine;
    items = m.items;
    memoryTotalBytes = cur.value.memory.totalBytes;
    load = host.loadAverage();
    points = [...points.filter((p) => p.at >= cur.value.at - historyMs), m.point].slice(-MAX_POINTS);
    return cur;
  };

  const loop = async (first: (result: Result<void, string>) => void): Promise<void> => {
    let prev: Reading | undefined;
    let started = false;
    const fail = (message: string) => {
      if (!started) first(err(message));
      else log(`machine reading failed: ${message}`);
    };
    if (closed) return first(err("the engine is stopping"));
    const baseline = await read();
    if (baseline.ok) {
      prev = baseline.value;
      await sleep(warmupMs);
    } else fail(baseline.error);
    for (;;) {
      if (closed) return first(err("the engine is stopping"));
      // The baseline failed: the run ends, and the next request tries again.
      if (prev === undefined) return;
      const next = await sample(prev);
      if (next.ok) {
        prev = next.value;
        if (!started) {
          started = true;
          first(ok(undefined));
        }
      } else fail(next.error);
      if (closed || clock.now() - lastAsked > idleMs) return;
      await sleep(everyMs);
    }
  };

  const ensureRunning = (): Promise<Result<void, string>> => {
    if (run !== undefined) return run;
    const started = new Promise<Result<void, string>>((resolve) => {
      running = loop(resolve).catch((error: unknown) => resolve(err(String(error)))).finally(() => {
        run = undefined;
        timer = undefined;
      });
    });
    run = started;
    return started;
  };

  return {
    async report() {
      if (closed) return err("the engine is stopping");
      lastAsked = clock.now();
      points = points.filter((p) => p.at >= lastAsked - historyMs);
      // The loop is started again if it had stopped.
      const started = ensureRunning();
      // Readings from before the loop stopped are old: wait for a new one.
      if (points.length === 0 || (points.at(-1)?.at ?? 0) < lastAsked - 2 * everyMs) {
        const result = await started;
        if (!result.ok) return result;
      }
      const last = points.at(-1);
      if (last === undefined) return err("no reading yet");
      return ok({ asOf: last.at, everyMs, cores: host.cores(), memoryTotalBytes, load, points, engine, items });
    },
    async close() {
      closed = true;
      if (timer !== undefined) clock.clearTimeout(timer);
      wake?.();
      await running;
    },
  };
}
