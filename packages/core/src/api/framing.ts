// Wire framing of the engine API: one JSON message per line (newline-delimited JSON), UTF-8.
// Both sides cap a message's size, so a peer cannot make the other buffer without limit.
import { err, ok, type Result } from "../kernel/result/index.js";

/** Largest message either side accepts or sends, in bytes, without the line break. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

const NEWLINE = 0x0a;

export interface FrameTooLarge {
  readonly code: "message_too_large";
  readonly maxBytes: number;
}

/**
 * Splits a byte stream into lines. The cap applies to bytes buffered before a line break arrives,
 * so an endless line fails as soon as it passes the cap. A line break byte never occurs inside a
 * multi-byte UTF-8 character, so whole lines decode safely however the chunks were split.
 */
export class LineDecoder {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private failed = false;

  constructor(private readonly maxBytes: number = MAX_MESSAGE_BYTES) {}

  /** Returns the complete lines in `chunk`. After an error the decoder stays failed. */
  push(chunk: Buffer): Result<string[], FrameTooLarge> {
    if (this.failed) return err({ code: "message_too_large", maxBytes: this.maxBytes });
    const lines: string[] = [];
    let start = 0;
    for (let index = chunk.indexOf(NEWLINE); index !== -1; index = chunk.indexOf(NEWLINE, start)) {
      const part = chunk.subarray(start, index);
      if (this.pendingBytes + part.length > this.maxBytes) return this.fail();
      lines.push(Buffer.concat([...this.pending, part]).toString("utf8"));
      this.pending = [];
      this.pendingBytes = 0;
      start = index + 1;
    }
    const rest = chunk.subarray(start);
    if (this.pendingBytes + rest.length > this.maxBytes) return this.fail();
    if (rest.length > 0) {
      this.pending.push(rest);
      this.pendingBytes += rest.length;
    }
    return ok(lines);
  }

  private fail(): Result<never, FrameTooLarge> {
    this.failed = true;
    this.pending = [];
    this.pendingBytes = 0;
    return err({ code: "message_too_large", maxBytes: this.maxBytes });
  }
}

/** One message as a line, or an error when it is larger than the cap. */
export function encodeLine(message: unknown, maxBytes: number = MAX_MESSAGE_BYTES): Result<string, FrameTooLarge> {
  const json = JSON.stringify(message);
  if (Buffer.byteLength(json, "utf8") > maxBytes) return err({ code: "message_too_large", maxBytes });
  return ok(`${json}\n`);
}
