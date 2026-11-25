// Stops this app's own engine for one engine dir (an older version still running after an
// update), and never any other process.
//
// The engine dir's lock names the engine's pid. That pid can belong to another process by now
// (the engine died and the pid was reused), so before every step the pid must pass three checks:
// it is alive, its command line ends with this app's engine entry and `--dir <this engine dir>`,
// and it started no later than the lock was written. Then the steps, each only when the one
// before did not stop it: a shutdown request on the engine's socket, SIGTERM, and SIGKILL.
import { execFile } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { systemClock, type Clock } from "../clock/index.js";
import { LSTART, parseLstart } from "./leftover.js";

/** The engine dir's lock: `<pid> <engineId>`. */
export interface EngineLock {
  readonly pid: number;
  readonly engineId: string;
  /** The lock file's modification time, epoch ms: when the engine wrote it. */
  readonly writtenAt: number;
}

/** The OS-specific part: read one process, signal one process. One per OS. */
export interface EngineProcesses {
  /** Start time (epoch ms, to the second) and full command line of a live pid; undefined when there is none. Rejects when it cannot tell. */
  describe(pid: number): Promise<{ readonly startedAt: number; readonly command: string } | undefined>;
  /** Never throws for a pid that is gone. */
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
}

/** Which engine counts as this app's own. */
export interface OwnEngine {
  /** `<engine dir>/engine.lock`. */
  readonly lockPath: string;
  /**
   * How the engine's command line ends, from the entry file on: e.g.
   * `/engine/dist/main.js --dir /home/dev/.tokama/run`. Must start with `/`, so it matches whole
   * path segments only.
   */
  readonly commandEnd: string;
  /** Other locks the engine holds (the Tokama home's); stopped means none names its pid any more. */
  readonly otherLocks?: readonly string[];
}

export type VerifyOutcome =
  | { readonly kind: "verified"; readonly lock: EngineLock; readonly startedAt: number }
  | { readonly kind: "refused"; readonly reason: "no_lock" | "unsafe" | "gone" | "not_engine" | "pid_reused" | "unreadable"; readonly pid?: number };

export type StopOutcome =
  /** The engine stopped (or let go of its locks) after this step. */
  | { readonly kind: "stopped"; readonly by: "shutdown" | "sigterm" | "sigkill"; readonly lock: EngineLock }
  /** The check failed before the first step; nothing was sent. */
  | Extract<VerifyOutcome, { kind: "refused" }>
  /** The lock names another engine now: someone else replaced it. Nothing more was sent. */
  | { readonly kind: "replaced" }
  /** Still running after SIGKILL. */
  | { readonly kind: "still_running"; readonly lock: EngineLock };

export interface StopOptions {
  readonly processes: EngineProcesses;
  /**
   * The engine id the lock named when the caller decided to stop it. When the lock names another
   * engine by now (another app replaced it meanwhile), nothing is sent.
   */
  readonly expectedEngineId?: string;
  /** Sends the shutdown request on the engine's socket; true when the engine accepted it. */
  readonly requestShutdown: () => Promise<boolean>;
  readonly clock?: Clock;
  /** How long each step waits for the engine to stop. Default 15 s. */
  readonly stepMs?: number;
  /** How often it looks meanwhile. Default 200 ms. */
  readonly pollMs?: number;
  /** This process, which is never signalled. */
  readonly selfPid?: number;
}

const MAX_LOCK_BYTES = 512;

/** The lock's pid, engine id and write time; undefined when it is missing, not a plain file, or malformed. */
export function readEngineLock(lockPath: string): EngineLock | undefined {
  const read = readSmallFile(lockPath);
  if (read === undefined) return undefined;
  const match = /^(\d{1,10}) (\S{1,128})\n?$/.exec(read.text);
  if (match === null) return undefined;
  return { pid: Number(match[1]), engineId: match[2] ?? "", writtenAt: read.mtimeMs };
}

/** The pid a lock file names first; undefined when there is no readable lock. */
function lockPid(lockPath: string): number | undefined {
  const pid = Number.parseInt(readSmallFile(lockPath)?.text.split(" ")[0] ?? "", 10);
  return Number.isInteger(pid) ? pid : undefined;
}

export async function verifyOwnEngine(engine: OwnEngine, processes: EngineProcesses, selfPid = process.pid): Promise<VerifyOutcome> {
  const lock = readEngineLock(engine.lockPath);
  if (lock === undefined) return { kind: "refused", reason: "no_lock" };
  const { pid } = lock;
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === selfPid || !engine.commandEnd.startsWith("/")) return { kind: "refused", reason: "unsafe", pid };
  let info: Awaited<ReturnType<EngineProcesses["describe"]>>;
  try {
    info = await processes.describe(pid);
  } catch {
    return { kind: "refused", reason: "unreadable", pid };
  }
  if (info === undefined) return { kind: "refused", reason: "gone", pid };
  if (!info.command.endsWith(engine.commandEnd)) return { kind: "refused", reason: "not_engine", pid };
  // The engine writes its lock after it starts; a process that started later took a reused pid.
  if (info.startedAt > lock.writtenAt) return { kind: "refused", reason: "pid_reused", pid };
  return { kind: "verified", lock, startedAt: info.startedAt };
}

export async function stopOwnEngine(engine: OwnEngine, options: StopOptions): Promise<StopOutcome> {
  const { processes } = options;
  const clock = options.clock ?? systemClock;
  const stepMs = options.stepMs ?? 15_000;
  const pollMs = options.pollMs ?? 200;
  const selfPid = options.selfPid ?? process.pid;

  const first = await verifyOwnEngine(engine, processes, selfPid);
  if (first.kind === "refused") return first;
  const { lock, startedAt } = first;
  if (options.expectedEngineId !== undefined && lock.engineId !== options.expectedEngineId) return { kind: "replaced" };
  const sleep = (ms: number) => new Promise<void>((resolve) => clock.setTimeout(resolve, ms));
  const sameEngine = (other: EngineLock | undefined) => other !== undefined && other.pid === lock.pid && other.engineId === lock.engineId;

  // Stopped: the process is gone (or the pid is another process's now), or no lock names it any more.
  const stopped = async () => {
    const info = await processes.describe(lock.pid).catch(() => "unknown" as const);
    if (info === "unknown") return false;
    if (info === undefined || info.startedAt !== startedAt) return true;
    return [engine.lockPath, ...(engine.otherLocks ?? [])].every((path) => lockPid(path) !== lock.pid);
  };
  const waitStopped = async () => {
    const deadline = clock.now() + stepMs;
    for (;;) {
      if (await stopped()) return true;
      if (clock.now() >= deadline) return false;
      await sleep(pollMs);
    }
  };

  const steps = [
    { by: "shutdown", send: () => options.requestShutdown() },
    { by: "sigterm", send: () => (processes.signal(lock.pid, "SIGTERM"), Promise.resolve(true)) },
    { by: "sigkill", send: () => (processes.signal(lock.pid, "SIGKILL"), Promise.resolve(true)) },
  ] as const;
  for (const [index, step] of steps.entries()) {
    if (index > 0) {
      // The check again, right before the signal: the same lock, the same process.
      const again = await verifyOwnEngine(engine, processes, selfPid);
      if (again.kind === "verified" && !sameEngine(again.lock)) return { kind: "replaced" };
      // The process list could not be read: no signal on a guess.
      if (again.kind === "refused" && again.reason === "unreadable") return again;
      if (again.kind !== "verified" || again.startedAt !== startedAt) {
        const current = readEngineLock(engine.lockPath);
        return current !== undefined && !sameEngine(current) ? { kind: "replaced" } : { kind: "stopped", by: steps[index - 1]?.by ?? "shutdown", lock };
      }
    }
    // An engine that refuses the request (one from before it existed) gets SIGTERM at once.
    const sent = await Promise.resolve()
      .then(step.send)
      .catch(() => false);
    if (sent && (await waitStopped())) return { kind: "stopped", by: step.by, lock };
  }
  return { kind: "still_running", lock };
}

/** macOS and Linux. */
export const posixEngineProcesses: EngineProcesses = {
  describe(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      execFile(
        "ps",
        ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "command="],
        { env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" }, timeout: 10_000, maxBuffer: 1024 * 1024 },
        // ps exits with 1 and prints nothing when there is no such process; any other failure is not knowing.
        (error, stdout) => {
          if (error === null) return resolve(parseDescribe(stdout));
          if (error.code === 1 && stdout.trim() === "") return resolve(undefined);
          reject(error);
        },
      );
    });
  },
  signal(pid, signal) {
    // 0, -1 and negative pids would reach a group or every process we may signal.
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new RangeError(`not an engine pid: ${pid}`);
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  },
};

const DESCRIBE_LINE = new RegExp(`^\\s*(${LSTART})\\s+(.*?)\\s*$`);

/** Parses `ps -o lstart= -o command=` output for one pid. */
export function parseDescribe(output: string): { startedAt: number; command: string } | undefined {
  const line = output.split("\n").find((candidate) => candidate.trim() !== "");
  const match = DESCRIBE_LINE.exec(line ?? "");
  if (match === null) return undefined;
  const startedAt = parseLstart(match[1] ?? "");
  return startedAt === undefined || match[2] === undefined || match[2] === "" ? undefined : { startedAt, command: match[2] };
}

function readSmallFile(path: string): { text: string; mtimeMs: number } | undefined {
  let fd: number | undefined;
  try {
    // Non-blocking, so a FIFO in its place cannot hang the caller.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_LOCK_BYTES) return undefined;
    const buffer = Buffer.alloc(stat.size);
    const length = readSync(fd, buffer, 0, stat.size, 0);
    return { text: buffer.subarray(0, length).toString("utf8"), mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
