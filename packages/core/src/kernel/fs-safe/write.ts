import { closeSync, constants, fstatSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { err, ok, type Result } from "../result/index.js";

export type WriteFailureReason = "symlink" | "not_regular_file" | "io_error";

export interface WriteFailure {
  readonly reason: WriteFailureReason;
  readonly path: string;
  readonly message: string;
  /** The errno code, for `io_error`. */
  readonly code?: string;
}

// The same guards as the reads: no symlink at the last path component, no blocking on a FIFO
// (with no reader, a non-blocking write-only open fails with ENXIO), no controlling terminal.
// O_NOFOLLOW does not exist on Windows; a Windows port needs its own guard.
const GUARDS = (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK | constants.O_NOCTTY;
const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | GUARDS;
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | GUARDS;

function failure(path: string, error: unknown): Result<never, WriteFailure> {
  if (error instanceof NotRegular) return err({ reason: "not_regular_file", path, message: "path is not a regular file" });
  const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
  if (code === "ELOOP" || code === "EMLINK") return err({ reason: "symlink", path, message: "path is a symlink" });
  return err({ reason: "io_error", path, message: `cannot write: ${code}`, code });
}

class NotRegular extends Error {}

function writeAll(fd: number, text: string): void {
  if (!fstatSync(fd).isFile()) throw new NotRegular();
  const data = Buffer.from(text, "utf8");
  let written = 0;
  while (written < data.length) written += writeSync(fd, data, written, data.length - written);
}

/**
 * Appends `text` to a regular file with one open, creating it with `mode` when missing. Never
 * follows a symlink at the last path component and never blocks on a FIFO. Synchronous, so it
 * also works while the process is dying. Never throws.
 */
export function appendTextSync(path: string, text: string, mode = 0o600): Result<void, WriteFailure> {
  let fd: number | undefined;
  try {
    fd = openSync(path, APPEND_FLAGS, mode);
    writeAll(fd, text);
    return ok(undefined);
  } catch (error) {
    return failure(path, error);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Replaces a file's content atomically: writes a new temp file beside it (`mode`, never through a
 * symlink), fsyncs it, then renames it over `path`. A reader sees the old or the new content,
 * never a mix. Never throws.
 */
export function replaceTextSync(path: string, text: string, mode = 0o600): Result<void, WriteFailure> {
  const temp = `${path}.${process.pid}.tmp`;
  let fd: number | undefined;
  try {
    try {
      unlinkSync(temp);
    } catch {
      // No stale temp file.
    }
    fd = openSync(temp, CREATE_FLAGS, mode);
    writeAll(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    return ok(undefined);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      // Never created, or already renamed.
    }
    return failure(path, error);
  }
}
