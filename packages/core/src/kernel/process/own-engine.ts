// What an engine's lock file says, and the per-OS parts a client needs around it: reading one
// process, signalling one process. The decision to stop an engine lives in `@tokama/client`: it
// never asks the OS whether a pid is the engine, it asks the engine's socket, and it signals only
// through `EngineProcesses.signal` and only while that socket still answers.
import { execFile } from "node:child_process";
import { hasCode } from "../errno/index.js";
import { LSTART, parseLstart } from "./leftover.js";
import { pidAlive, readPidFile, type PidFile } from "./pid-file.js";

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

/** The lock's pid, engine id and write time; undefined when it is missing, not a plain file, or malformed. */
export function readEngineLock(lockPath: string): EngineLock | undefined {
  const read = readPidFile(lockPath);
  if (read?.pid === undefined || read.fields.length !== 2) return undefined;
  const engineId = read.fields[1] ?? "";
  return engineId.length > 128 ? undefined : { pid: read.pid, engineId, writtenAt: read.writtenAt };
}

// A lock that names no pid yet is still being written, unless it is older than this (its writer
// then died between creating and writing it).
const LOCK_WRITE_GRACE_MS = 10_000;
// `ps` gives start times to the second, and on Linux they can be off by about a second more.
const START_TIME_SLACK_MS = 2_000;

/**
 * True while the process that wrote a lock still runs, however long its engine takes to start
 * (a large item log, an index rebuild, a slow disk). The writer is the process with the
 * lock's pid that started no later than the lock was written; a process that started later took
 * the pid over after the engine died. When the start time cannot be read, the writer counts as
 * live: a refused start is safe, two engines on one home are not. A lock with no pid yet counts as
 * live for a short grace. An engine refuses to start while this is true, so a client waits.
 */
export async function lockWriterLive(lock: PidFile, processes: EngineProcesses, now = Date.now()): Promise<boolean> {
  if (lock.pid === undefined) return now - lock.writtenAt < LOCK_WRITE_GRACE_MS;
  if (!pidAlive(lock.pid)) return false;
  const info = await processes.describe(lock.pid).catch(() => "unknown" as const);
  // Nothing read: the process has exited since, or ps printed something unexpected.
  if (info === undefined) return pidAlive(lock.pid);
  return info === "unknown" || info.startedAt <= lock.writtenAt + START_TIME_SLACK_MS;
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
      if (!hasCode(error, "ESRCH")) throw error;
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
