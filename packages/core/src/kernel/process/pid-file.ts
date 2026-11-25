// Pid files: the small lock and marker files that name a process by its pid (`<pid>[ <field>...]`),
// and the check whether that process is still alive.
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { hasCode } from "../errno/index.js";

/** A pid file's content and write time. */
export interface PidFile {
  /** The first word, when it is a pid; undefined while the file is still empty or when it is malformed. */
  readonly pid: number | undefined;
  /** Every word of the file, the pid included. */
  readonly fields: readonly string[];
  /** The file's modification time, epoch ms: when its writer wrote it. */
  readonly writtenAt: number;
}

const MAX_PID_FILE_BYTES = 512;
const PID = /^[1-9]\d{0,9}$/;

/**
 * Reads a pid file without following a symlink and without blocking on a FIFO in its place.
 * Undefined when it is missing, not a regular file, larger than 512 bytes or unreadable. A file
 * that exists but holds no pid (yet) comes back with `pid` undefined, so a caller can tell a lock
 * that is being written from a missing one.
 */
export function readPidFile(path: string): PidFile | undefined {
  let fd: number | undefined;
  try {
    // O_NOFOLLOW does not exist on Windows; a Windows port needs its own guard.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_PID_FILE_BYTES) return undefined;
    const buffer = Buffer.alloc(stat.size);
    const length = readSync(fd, buffer, 0, stat.size, 0);
    const text = buffer.subarray(0, length).toString("utf8").trim();
    const fields = text === "" ? [] : text.split(/\s+/);
    const first = fields[0] ?? "";
    return { pid: PID.test(first) ? Number(first) : undefined, fields, writtenAt: stat.mtimeMs };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * True while a process with this pid exists, ours or another user's (EPERM). False for a pid that
 * is gone (ESRCH), on any other error, and for 0 or a negative number, which would name a
 * process group rather than one process.
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, "EPERM");
  }
}
