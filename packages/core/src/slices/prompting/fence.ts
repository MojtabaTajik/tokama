// Data blocks: untrusted text between a begin line and an end line that share a random mark. The
// mark is drawn per call and checked against every piece of untrusted text, so no content can
// close its block early or open a fake one.
import { randomBytes } from "node:crypto";
import { err, ok, type Result } from "../../kernel/result/index.js";

/** Check output keeps only its last 16 KiB: the end of a test run holds the failures. */
export const CHECK_OUTPUT_MAX_BYTES = 16 * 1024;

const MARK = /^[A-Za-z0-9]{16,64}$/;
const MAX_DRAWS = 5;

export const randomMark = (): string => randomBytes(16).toString("hex");

/**
 * Draws a mark that occurs in none of `untrusted`. A mark of the wrong shape counts as a
 * collision. Gives up after a few draws, which only a broken generator reaches.
 */
export function chooseMark(untrusted: readonly string[], draw: () => string): Result<string, string> {
  for (let i = 0; i < MAX_DRAWS; i++) {
    const mark = draw();
    if (MARK.test(mark) && !untrusted.some((text) => text.includes(mark))) return ok(mark);
  }
  return err(`no data-block mark was free of the content after ${MAX_DRAWS} draws`);
}

/** One data block. The name is JSON-quoted, so a name with quotes or newlines stays on its line. */
export function fence(name: string, content: string, mark: string, note?: string): string {
  const body = content === "" || content.endsWith("\n") ? content : `${content}\n`;
  const noteAttr = note === undefined ? "" : ` note=${JSON.stringify(note)}`;
  return `<<<tokama-data name=${JSON.stringify(name)} mark="${mark}"${noteAttr}\n${body}tokama-data-end mark="${mark}">>>`;
}

export interface Tail {
  readonly text: string;
  readonly bytes: number;
  /** The UTF-8 size before the cut; equal to `bytes` when nothing was cut. */
  readonly originalBytes: number;
}

/** The last `maxBytes` of `text` in UTF-8, cut on a character boundary. */
export function tail(text: string, maxBytes: number): Tail {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return { text, bytes: buffer.length, originalBytes: buffer.length };
  let start = buffer.length - maxBytes;
  // Skip continuation bytes (10xxxxxx) so the cut lands on the start of a character.
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start++;
  const kept = buffer.subarray(start);
  return { text: kept.toString("utf8"), bytes: kept.length, originalBytes: buffer.length };
}
