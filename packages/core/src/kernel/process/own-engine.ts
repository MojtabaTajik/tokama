// What an engine's lock file says, and the per-OS part a client needs around it: signalling one
// process. The decision to stop an engine lives in `@tokama/client`: it never asks the OS whether
// a pid is the engine, it asks the engine's socket, and it signals only through
// `EngineProcesses.signal`.
import { connect } from "node:net";
import { isAbsolute } from "node:path";
import { hasCode } from "../errno/index.js";
import { readPidFile } from "./pid-file.js";

/** The engine's lock: `<pid> <engineId> <socketPath>`. */
export interface EngineLock {
  readonly pid: number;
  readonly engineId: string;
  /** The socket this engine listens on; the token is next to it. */
  readonly socketPath: string;
  /** The lock's whole text: two reads that give the same text read the same lock. */
  readonly text: string;
}

/** The OS-specific part: signal one process. One per OS. */
export interface EngineProcesses {
  /** Never throws for a pid that is gone. */
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
}

// sun_path is 104 bytes on macOS and 108 on Linux, including the terminating NUL.
const MAX_SOCKET_PATH = 107;

/**
 * The lock's pid, engine id and socket; undefined when it is missing, not a plain file, not owned
 * by this user, writable by group or others, or malformed: such a file is not an engine's lock.
 */
export function readEngineLock(lockPath: string): EngineLock | undefined {
  const read = readPidFile(lockPath);
  if (read?.pid === undefined || read.fields.length < 3) return undefined;
  const uid = process.getuid?.();
  if ((uid !== undefined && read.uid !== uid) || (read.mode & 0o022) !== 0) return undefined;
  const engineId = read.fields[1] ?? "";
  const socketPath = read.fields.slice(2).join(" ");
  if (engineId.length > 128 || !isAbsolute(socketPath) || !socketPath.endsWith(".sock") || Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) return undefined;
  return { pid: read.pid, engineId, socketPath, text: read.text };
}

export type Liveness = "alive" | "dead" | "unknown";

const PROBE_TIMEOUT_MS = 2_000;

/**
 * Whether an engine listens on a socket: one connect. The kernel closes a listening socket when its
 * process dies, however it dies, so accepted is alive, refused or no such file is dead, and
 * anything else (no answer in time, a permission error) is not knowing.
 */
export function probeSocket(socketPath: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<Liveness> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    const done = (state: Liveness) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(state);
    };
    const timer = setTimeout(() => done("unknown"), timeoutMs);
    socket.once("connect", () => done("alive"));
    socket.once("error", (error) => done(hasCode(error, "ECONNREFUSED") || hasCode(error, "ENOENT") ? "dead" : "unknown"));
  });
}

/** macOS and Linux. */
export const posixEngineProcesses: EngineProcesses = {
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
