// The event log file: one JSON event per line, appended and fsynced, never rewritten.
//
// A crash during an append can leave a last line without its line break. Readers ignore that
// fragment (it was never a committed event), and the next append cuts it off first, so the new
// event does not join onto it. Every complete line must parse; anything else is corruption.
// eslint-disable-next-line no-restricted-imports -- the event log appends and fsyncs in place, never replaces; tests swap these file operations to check their order.
import * as nodeFs from "node:fs";
import { err, ok, type Result } from "../../kernel/result/index.js";
import { parseItemEvent, type ItemEvent } from "../../kernel/schemas/index.js";
import { parseJsonLine } from "../../kernel/json-line/index.js";

/** The file operations the log uses, so a test can watch their order. */
export type LogFs = Pick<
  typeof nodeFs,
  "openSync" | "closeSync" | "writeSync" | "readSync" | "fsyncSync" | "fstatSync" | "ftruncateSync" | "readFileSync"
>;

export interface LogError {
  readonly code: "unreadable" | "corrupt";
  readonly message: string;
}

export interface ReadLog {
  readonly events: ItemEvent[];
  /** A last line without a line break was ignored (an append the crash cut short). */
  readonly tornTail: boolean;
}

// O_NOFOLLOW does not exist on Windows; a Windows port needs its own guard.
const APPEND_FLAGS = nodeFs.constants.O_RDWR | nodeFs.constants.O_APPEND | nodeFs.constants.O_CREAT | (nodeFs.constants.O_NOFOLLOW ?? 0);
const READ_FLAGS = nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW ?? 0);

export function readLog(file: string, fs: LogFs = nodeFs): Result<ReadLog, LogError> {
  let content: string;
  try {
    const fd = fs.openSync(file, READ_FLAGS);
    try {
      content = fs.readFileSync(fd, "utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    return err({ code: "unreadable", message: `cannot read ${file}: ${String(error)}` });
  }
  const lines = content.split("\n");
  // After the last line break: empty for a whole file, a fragment for a torn one.
  const tail = lines.pop() ?? "";
  const events: ItemEvent[] = [];
  for (const [index, line] of lines.entries()) {
    const json = parseJsonLine(line);
    if (!json.ok) return err({ code: "corrupt", message: `${file}: line ${index + 1} is not JSON` });
    const event = parseItemEvent(json.value);
    if (!event.ok) {
      const issue = event.error.issues[0];
      return err({ code: "corrupt", message: `${file}: line ${index + 1}: ${issue?.path ? `${issue.path}: ` : ""}${issue?.message ?? "invalid event"}` });
    }
    events.push(event.value);
  }
  return ok({ events, tornTail: tail !== "" });
}

/**
 * Appends the events as lines with one write, then fsyncs the file before it returns. Creates the
 * file (mode 0600) when missing; the caller fsyncs the folder for a new file.
 */
export function appendEvents(file: string, events: readonly ItemEvent[], fs: LogFs = nodeFs): void {
  const data = Buffer.from(events.map((event) => `${JSON.stringify(event)}\n`).join(""), "utf8");
  const fd = fs.openSync(file, APPEND_FLAGS, 0o600);
  try {
    cutTornTail(fd, fs);
    let written = 0;
    while (written < data.length) written += fs.writeSync(fd, data, written, data.length - written);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Truncates the file after its last line break, when it does not end with one. */
function cutTornTail(fd: number, fs: LogFs): void {
  const size = fs.fstatSync(fd).size;
  if (size === 0 || lastByte(fd, size, fs) === 0x0a) return;
  const chunk = Buffer.alloc(64 * 1024);
  let end = size;
  while (end > 0) {
    const start = Math.max(0, end - chunk.length);
    const read = fs.readSync(fd, chunk, 0, end - start, start);
    const newline = chunk.subarray(0, read).lastIndexOf(0x0a);
    if (newline >= 0) {
      fs.ftruncateSync(fd, start + newline + 1);
      return;
    }
    end = start;
  }
  fs.ftruncateSync(fd, 0);
}

function lastByte(fd: number, size: number, fs: LogFs): number | undefined {
  const byte = Buffer.alloc(1);
  return fs.readSync(fd, byte, 0, 1, size - 1) === 1 ? byte[0] : undefined;
}

/** Makes a new directory entry durable: fsync the folder that holds it. */
export function fsyncDir(dir: string, fs: LogFs = nodeFs): void {
  const fd = fs.openSync(dir, nodeFs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
