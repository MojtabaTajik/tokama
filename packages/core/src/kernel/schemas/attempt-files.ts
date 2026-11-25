// What an attempt saved beside the item's log, as the engine serves it: each check command with
// the end of its output, and the agent's transcript with its final message. Replies carry text
// only, cleaned of terminal control sequences and cut to fixed caps, and never a path.
import { z } from "zod";

/** The most lines of a check's output a reply carries: the last ones. */
export const MAX_CHECK_TAIL_LINES = 40;
/** The most of a check's output a reply carries, in bytes of UTF-8. */
export const MAX_CHECK_TAIL_BYTES = 16 * 1024;
/** The most lines of a transcript a reply carries: the last ones. */
export const MAX_TRANSCRIPT_TAIL_LINES = 400;
/** The most of a transcript a reply carries, in bytes of UTF-8. */
export const MAX_TRANSCRIPT_TAIL_BYTES = 64 * 1024;
/** The most check commands an attempt reply lists. */
export const MAX_ATTEMPT_CHECKS = 20;

/** The end of a saved text file. */
const tail = (maxBytes: number) =>
  z.strictObject({
    /** The last lines, at most the cap; a line cut by the byte cap is left out. */
    text: z.string().max(maxBytes),
    /** The file holds more than `text`. */
    truncated: z.boolean(),
    totalBytes: z.int().min(0),
    /** null when the file is too large to count its lines. */
    totalLines: z.int().min(0).nullable(),
  });

/** `not_run`: the attempt ended before the check did (refused, not started, stopped). */
export const CheckStateSchema = z.enum(["passed", "failed", "running", "waiting", "not_run"]);

export const AttemptCheckSchema = z.strictObject({
  command: z.string().min(1).max(500),
  state: CheckStateSchema,
  /** null unless it ended, and when a signal ended it. */
  exitCode: z.int().nullable(),
  /** null unless it ended, and for checks recorded before durations were. */
  durationMs: z.int().min(0).nullable(),
  /** The last line of its output, cut to fit; for one that did not run, why. Empty when it has none. */
  summary: z.string().max(200),
  /** null when no output was saved: it waits, or the file is gone. */
  output: tail(MAX_CHECK_TAIL_BYTES).nullable(),
});

/** Each check command of one attempt, in the order they run. */
export const AttemptChecksSchema = z.strictObject({
  attempt: z.int().min(1),
  checks: z.array(AttemptCheckSchema).max(MAX_ATTEMPT_CHECKS),
});

/** The agent's transcript of one attempt and its final message. */
export const AttemptLogSchema = z.strictObject({
  attempt: z.int().min(1),
  /**
   * The agent's messages as written, and one line per tool call that starts with `→ `. null when
   * no transcript was saved.
   */
  transcript: tail(MAX_TRANSCRIPT_TAIL_BYTES).nullable(),
  /** The agent's final message, cut at 64 KiB; null when it wrote none (yet). */
  final: z.strictObject({ text: z.string().max(64 * 1024), truncated: z.boolean() }).nullable(),
});

/** One saved file of an attempt: its transcript, or the output of check number `n` (from 1). */
export const AttemptFileSchema = z.union([z.literal("transcript"), z.int().min(1).max(MAX_ATTEMPT_CHECKS)]);

// ESC sequences: CSI (colours, cursor moves), OSC (titles, links) ended by BEL or ST, and the
// short ones (charset picks, keypad modes). CSI also as the one-byte C1 form.
// eslint-disable-next-line no-control-regex
const CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const OSC = /(?:\u001b\]|\u009d)[^\u0007\u001b\u009c\n]*(?:\u0007|\u001b\\|\u009c)?/g;
// eslint-disable-next-line no-control-regex
const ESC = /\u001b[ -/]*[0-~]?/g;
// Control characters but tab and line feed, and the marks that reorder text on screen.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Terminal output as plain text: no escape sequences or control characters but tab and line
 * feed. A carriage return inside a line keeps what was written after it, as a terminal shows it.
 */
export function terminalText(text: string): string {
  return text
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(ESC, "")
    .replace(/\r+\n/g, "\n")
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("\r") + 1))
    .join("\n")
    .replace(CONTROL, "");
}

export type CheckState = z.output<typeof CheckStateSchema>;
export type AttemptCheck = z.output<typeof AttemptCheckSchema>;
export type AttemptFile = z.output<typeof AttemptFileSchema>;
