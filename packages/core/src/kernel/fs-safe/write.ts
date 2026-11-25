import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname } from "node:path";
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
  // The file name only: messages may reach logs and diagnostics, which hold no machine paths.
  const name = basename(path);
  if (error instanceof NotRegular) return err({ reason: "not_regular_file", path, message: `${name} is not a regular file` });
  const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
  if (code === "ELOOP" || code === "EMLINK") return err({ reason: "symlink", path, message: `${name} is a symlink` });
  return err({ reason: "io_error", path, message: `cannot write ${name}: ${code}`, code });
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
 * Replaces a file's content atomically: writes a new temp file beside it under a random name
 * (created exclusively, never through a symlink, with exactly `mode`), fsyncs it, renames it over
 * `path`, then fsyncs the folder so the rename survives a power cut. A reader sees the old or the
 * new content, never a mix. A symlink at `path` is replaced itself; its target is never written.
 * Never throws.
 */
export function replaceTextSync(path: string, text: string, mode = 0o600): Result<void, WriteFailure> {
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(temp, CREATE_FLAGS, mode);
    created = true;
    // The umask may have taken bits off the mode the caller asked for.
    fchmodSync(fd, mode);
    writeAll(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (created) {
      try {
        unlinkSync(temp);
      } catch {
        // Already renamed.
      }
    }
    return failure(path, error);
  }
  fsyncFolder(dirname(path));
  return ok(undefined);
}

function fsyncFolder(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, constants.O_RDONLY);
    fsyncSync(fd);
  } catch {
    // Not every platform can open a folder for this. The file is in place; only its durability
    // across a power cut is less certain.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
