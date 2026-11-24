import { constants, type promises } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { err, ok, type Result } from "../result/index.js";

export type ReadFailureReason =
  | "not_found"
  | "symlink"
  | "not_regular_file"
  | "too_large"
  | "too_many_lines"
  | "invalid_utf8"
  | "invalid_json"
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
const FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
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
  let handle: promises.FileHandle;
  try {
    handle = await open(path, FLAGS);
  } catch (error) {
    return openFailure(path, error);
  }
  let bytes: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return failure(path, "not_regular_file", "not a regular file");
    if (stat.size > maxBytes) return failure(path, "too_large", `larger than ${maxBytes} bytes`);
    // The file can grow after fstat, so read up to one byte past the cap rather than stat.size.
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      if (total > maxBytes) return failure(path, "too_large", `larger than ${maxBytes} bytes`);
    }
    bytes = Buffer.concat(chunks, total);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    return failure(path, "io_error", `cannot read: ${code}`, code);
  } finally {
    await handle.close().catch(() => undefined);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return failure(path, "invalid_utf8", "not valid UTF-8");
  }
  if (maxLines !== undefined && countLines(text) > maxLines) {
    return failure(path, "too_many_lines", `more than ${maxLines} lines`);
  }
  return ok(text);
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
 * can still escape. That is out of scope (architecture.md, section 9); it stops planted links.
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
