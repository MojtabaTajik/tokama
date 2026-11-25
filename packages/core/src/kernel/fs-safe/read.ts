import { constants, type promises } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { err, ok, type Result } from "../result/index.js";

export type ReadFailureReason =
  | "not_found"
  | "symlink"
  | "not_regular_file"
  | "too_large"
  | "too_many_lines"
  | "invalid_utf8"
  | "invalid_json"
  | "outside_root"
  | "too_many_entries"
  | "io_error";

export interface ReadFailure {
  readonly reason: ReadFailureReason;
  readonly path: string;
  readonly message: string;
  /** The errno code, for `io_error`. */
  readonly code?: string;
}

export interface ReadTextOptions {
  /** Files larger than this are refused without reading them. */
  readonly maxBytes: number;
  /** Line breaks are `\n` (CRLF counts once); a final line break does not start a new line. */
  readonly maxLines?: number;
}

// O_NONBLOCK: opening a FIFO with no writer returns at once instead of hanging; fstat then refuses it.
// O_NOFOLLOW: a symlink as the last path component fails the open (ELOOP; EMLINK on FreeBSD).
// O_NOCTTY: opening a terminal device never makes it the engine's controlling terminal (Linux).
const FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_NOCTTY;
const CHUNK_BYTES = 64 * 1024;

const failure = (path: string, reason: ReadFailureReason, message: string, code?: string): Result<never, ReadFailure> =>
  err(code === undefined ? { reason, path, message } : { reason, path, message, code });

function openFailure(path: string, error: unknown): Result<never, ReadFailure> {
  const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
  if (code === "ENOENT" || code === "ENOTDIR") return failure(path, "not_found", "file does not exist");
  if (code === "ELOOP" || code === "EMLINK") return failure(path, "symlink", "path is a symlink");
  return failure(path, "io_error", `cannot open: ${code}`, code);
}

/**
 * The UTF-8 text of a regular file. Never follows a symlink at the last path component, never
 * blocks on a FIFO or device, never reads more than `maxBytes + 1` bytes. Symlinked parent
 * directories are followed: use `isInside` when the path must stay inside a folder. Never throws.
 */
export async function readTextFile(path: string, options: ReadTextOptions): Promise<Result<string, ReadFailure>> {
  const { maxBytes, maxLines } = options;
  const read = await readUpTo(path, maxBytes, true);
  if (!read.ok) return read;
  if (read.value.more) return failure(path, "too_large", `larger than ${maxBytes} bytes`);
  const text = decode(path, read.value.bytes);
  if (!text.ok) return text;
  if (maxLines !== undefined && countLines(text.value) > maxLines) {
    return failure(path, "too_many_lines", `more than ${maxLines} lines`);
  }
  return text;
}

/**
 * The first `maxBytes` of a file's UTF-8 text, by the open rules of `readTextFile`; `truncated`
 * when the file holds more. A character split by the cap is left out. Never throws.
 */
export async function readTextHead(path: string, options: { readonly maxBytes: number }): Promise<Result<{ text: string; truncated: boolean }, ReadFailure>> {
  const read = await readUpTo(path, options.maxBytes, false);
  if (!read.ok) return read;
  const { bytes, more } = read.value;
  const text = decode(path, more ? bytes.subarray(0, completeUtf8Length(bytes)) : bytes);
  return text.ok ? ok({ text: text.value, truncated: more }) : text;
}

/** Up to `maxBytes` of a regular file, and whether it holds more; `refuseLarger` refuses a larger file by its size before reading. */
async function readUpTo(path: string, maxBytes: number, refuseLarger: boolean): Promise<Result<{ bytes: Buffer; more: boolean }, ReadFailure>> {
  let handle: promises.FileHandle;
  try {
    handle = await open(path, FLAGS);
  } catch (error) {
    return openFailure(path, error);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return failure(path, "not_regular_file", "not a regular file");
    if (refuseLarger && stat.size > maxBytes) return failure(path, "too_large", `larger than ${maxBytes} bytes`);
    // The file can grow after fstat, so read up to one byte past the cap rather than stat.size.
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    const bytes = Buffer.concat(chunks, total);
    return ok(total > maxBytes ? { bytes: bytes.subarray(0, maxBytes), more: true } : { bytes, more: false });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    return failure(path, "io_error", `cannot read: ${code}`, code);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function decode(path: string, bytes: Uint8Array): Result<string, ReadFailure> {
  try {
    return ok(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return failure(path, "invalid_utf8", "not valid UTF-8");
  }
}

/** The length of `bytes` without a UTF-8 sequence cut off at its end. */
function completeUtf8Length(bytes: Uint8Array): number {
  // Step back over continuation bytes (10xxxxxx) to the last lead byte, at most 3.
  let start = bytes.length - 1;
  while (start >= 0 && bytes.length - start <= 3 && (bytes[start]! & 0xc0) === 0x80) start--;
  if (start < 0) return bytes.length;
  const lead = bytes[start]!;
  const needs = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return bytes.length - start < needs ? start : bytes.length;
}

function countLines(text: string): number {
  if (text === "") return 0;
  let breaks = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) breaks++;
  return text.endsWith("\n") ? breaks : breaks + 1;
}

/** A JSON file read as `readTextFile` reads it. The value is unvalidated: parse it with its schema. */
export async function readJsonFile(path: string, options: ReadTextOptions): Promise<Result<unknown, ReadFailure>> {
  const text = await readTextFile(path, options);
  if (!text.ok) return text;
  try {
    return ok(JSON.parse(text.value) as unknown);
  } catch (error) {
    return failure(path, "invalid_json", `not valid JSON: ${(error as Error).message}`);
  }
}

/**
 * True when `path` exists and its real path (every symlink resolved, `..` applied after each
 * link as the OS does) is `root` or inside it. False for a missing path or root.
 * The check and a later open are two steps: a process that can swap a directory between them
 * can still escape. That is out of scope; it stops planted links.
 */
export async function isInside(root: string, path: string): Promise<boolean> {
  let realRoot: string;
  let realPath: string;
  try {
    [realRoot, realPath] = await Promise.all([realpath(root), realpath(path)]);
  } catch {
    return false;
  }
  const rel = relative(realRoot, realPath);
  // Not `startsWith(root)`: that would accept `/root-evil` for `/root`. A name like `..x` is inside.
  return !isAbsolute(rel) && rel.split(sep)[0] !== "..";
}

/**
 * `readTextFile`, but only after `isInside(root, path)` passes, so nothing outside `root` is
 * opened. A path that is not inside is `not_found` when it does not exist, `symlink` when it is
 * a link, and `outside_root` otherwise (a symlinked folder on the way).
 */
export async function readTextFileInside(root: string, path: string, options: ReadTextOptions): Promise<Result<string, ReadFailure>> {
  if (!(await isInside(root, path))) return notInside(path, "file");
  return readTextFile(path, options);
}

/**
 * The names of the entries in the folder `root/rel` that are not folders, sorted. The folder's
 * real path must be `root` or inside it; that is checked before listing. Symlinks and other
 * non-regular entries are listed, so a read of them is refused with its own reason.
 */
export async function listFiles(root: string, rel: string, options: { readonly max: number }): Promise<Result<string[], ReadFailure>> {
  const dir = join(root, rel);
  if (!(await isInside(root, dir))) return notInside(dir, "folder");
  let names: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    if (code === "ENOENT") return failure(dir, "not_found", "folder does not exist");
    if (code === "ENOTDIR") return failure(dir, "not_regular_file", "not a folder");
    return failure(dir, "io_error", `cannot list: ${code}`, code);
  }
  if (names.length > options.max) return failure(dir, "too_many_entries", `more than ${options.max} entries`);
  return ok(names.sort());
}

async function notInside(path: string, what: "file" | "folder"): Promise<Result<never, ReadFailure>> {
  try {
    if ((await lstat(path)).isSymbolicLink()) return failure(path, "symlink", "path is a symlink");
    await stat(path);
  } catch {
    return failure(path, "not_found", `${what} does not exist`);
  }
  return failure(path, "outside_root", `${what} is outside the allowed folder`);
}

/**
 * The names of the real folders in the folder `root/rel`, sorted. A symlink to a folder is not a
 * folder here: it is left out, so a walk never leaves the tree or reads a folder twice. The
 * folder's real path must be `root` or inside it; that is checked before listing.
 */
export async function listFolders(root: string, rel: string, options: { readonly max: number }): Promise<Result<string[], ReadFailure>> {
  const dir = join(root, rel);
  if (!(await isInside(root, dir))) return notInside(dir, "folder");
  let names: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    if (code === "ENOENT") return failure(dir, "not_found", "folder does not exist");
    if (code === "ENOTDIR") return failure(dir, "not_regular_file", "not a folder");
    return failure(dir, "io_error", `cannot list: ${code}`, code);
  }
  if (names.length > options.max) return failure(dir, "too_many_entries", `more than ${options.max} entries`);
  return ok(names.sort());
}

export interface ReadLinesOptions {
  /** Files larger than this are refused without reading them. */
  readonly maxFileBytes: number;
  /** A longer line is skipped without being kept in memory. */
  readonly maxLineBytes: number;
  /**
   * Where an earlier read ended. It is used only while the file is the same file (same inode) and
   * no shorter than that; otherwise the read starts at the beginning.
   */
  readonly resume?: { readonly ino: number; readonly offset: number };
  /** A file last changed before this time (ms) is not read: the read ends at its size at once. */
  readonly modifiedSince?: number;
  /** Stops between chunks; the result then ends at the last complete line read. */
  readonly signal?: AbortSignal;
}

export interface ReadLinesResult {
  readonly ino: number;
  readonly size: number;
  /** Where the read started. */
  readonly start: number;
  /** Just past the last complete line read: resume from here. A line still being written is left for later. */
  readonly end: number;
  /** Lines skipped for being too long or not valid UTF-8. */
  readonly skipped: number;
}

/**
 * Reads a growing line-based file (a log) from where an earlier read ended, one complete line at
 * a time: `onLine` gets each line without its line break. The same open rules as `readTextFile`:
 * no symlink at the last path component, no FIFO or device, a size cap. Memory stays within one
 * line plus one chunk. Never throws, except what `onLine` throws.
 */
export async function readLinesFrom(path: string, options: ReadLinesOptions, onLine: (line: string) => void): Promise<Result<ReadLinesResult, ReadFailure>> {
  const { maxFileBytes, maxLineBytes, resume, modifiedSince, signal } = options;
  let handle: promises.FileHandle;
  try {
    handle = await open(path, FLAGS);
  } catch (error) {
    return openFailure(path, error);
  }
  try {
    let info;
    try {
      info = await handle.stat();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
      return failure(path, "io_error", `cannot read: ${code}`, code);
    }
    if (!info.isFile()) return failure(path, "not_regular_file", "not a regular file");
    if (info.size > maxFileBytes) return failure(path, "too_large", `larger than ${maxFileBytes} bytes`);
    const start = resume !== undefined && resume.ino === info.ino && resume.offset <= info.size ? resume.offset : 0;
    if (modifiedSince !== undefined && info.mtimeMs < modifiedSince) return ok({ ino: info.ino, size: info.size, start, end: info.size, skipped: 0 });
    // Read only what was there at fstat: a line written after it is read next time.
    const stop = info.size;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let tooLong = false;
    let skipped = 0;
    let position = start;
    let end = start;
    const chunk = Buffer.alloc(CHUNK_BYTES);
    while (position < stop && signal?.aborted !== true) {
      let bytesRead: number;
      try {
        ({ bytesRead } = await handle.read(chunk, 0, Math.min(CHUNK_BYTES, stop - position), position));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
        return failure(path, "io_error", `cannot read: ${code}`, code);
      }
      if (bytesRead === 0) break;
      let from = 0;
      for (let nl = chunk.indexOf(10, from); nl !== -1 && nl < bytesRead; nl = chunk.indexOf(10, from)) {
        const piece = chunk.subarray(from, nl);
        if (!tooLong && pendingBytes + piece.length <= maxLineBytes) {
          const bytes = pending.length === 0 ? piece : Buffer.concat([...pending, piece]);
          let line: string | undefined;
          try {
            line = decoder.decode(bytes);
          } catch {
            skipped++;
          }
          if (line !== undefined) onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
        } else {
          skipped++;
        }
        pending = [];
        pendingBytes = 0;
        tooLong = false;
        from = nl + 1;
        end = position + from;
      }
      const rest = chunk.subarray(from, bytesRead);
      if (!tooLong && pendingBytes + rest.length <= maxLineBytes) {
        // Copied: the chunk buffer is reused for the next read.
        pending.push(Buffer.from(rest));
        pendingBytes += rest.length;
      } else {
        pending = [];
        pendingBytes = 0;
        tooLong = true;
      }
      position += bytesRead;
    }
    return ok({ ino: info.ino, size: info.size, start, end, skipped });
  } finally {
    await handle.close().catch(() => undefined);
  }
}
