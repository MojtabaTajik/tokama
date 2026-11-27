// The headline an agent writes at the end of its reply, and what the run loop makes of it. The
// rule is added to the instructions of every agent step of a template; helpers and Tokama's own
// steps never get it. Reading the block back is in summary.ts.
import { MAX_HEADLINE_CHARS, MAX_POINT_CHARS, MAX_POINTS, type Said } from "../../kernel/schemas/index.js";
import type { ParsedHeadline } from "./summary.js";

/** Added to an agent step's instructions; a reviewer's `VERDICT_RULE` comes after it, so the verdict stays the last line. */
export const HEADLINE_RULE = `

End your reply with this block, exactly in this form:
HEADLINE: <one line, at most ${MAX_HEADLINE_CHARS} characters: the most important thing you did or found>
POINT: <optional; up to ${MAX_POINTS} such lines, each at most ${MAX_POINT_CHARS} characters: what else the engineer must know, such as what is not done, what you assumed, what you are unsure about>
READ: yes   <only when the engineer must read your full reply to use this work: a design, findings, a plan with choices>`;

/** Added after `HEADLINE_RULE` on a step you approve that a step follows, unless the engineer chose to build anyway on it. */
export const NO_CHANGE_RULE = `
NO_CHANGE: yes   <only when nothing needs to be changed or built and your reply is the answer, and you changed no files; leave the line out otherwise>`;

/** Added to a reviewer's instructions in place of `HEADLINE_RULE`, before its `VERDICT_RULE`, which keeps the last line. */
export const REVIEWER_HEADLINE_RULE = `${HEADLINE_RULE}
This block goes above the VERDICT line.`;

// A block label at the start of a line, in any letter case, after a list mark, a quote mark or bold
// marks; the rest of the line is the value (any character, so a line separator does not end it).
// The one grammar for the headline parser and the verdict reader.
const BLOCK_LABEL = /^\s*(?:(?:[-*]\s+|>\s*)*)(?:\*\*|__)?(HEADLINE|POINT|READ|NO_CHANGE)(?:\*\*|__)?\s*:([\s\S]*)$/i;
// Control, invisible formatting and line-break characters, as a notification's text drops them.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

/** One line of plain text: no control characters, no Markdown marks, spaces folded. */
export const plain = (text: string): string =>
  text
    .replace(INVISIBLE, " ")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^#{1,6}\s+/, "");

/**
 * The label of a headline block line and its plain value. `block` is true for a `HEADLINE:` or
 * `POINT:` line, for a `READ:` line that says yes or no, and for a `NO_CHANGE:` line that says
 * yes; any other `READ:` or `NO_CHANGE:` line is part of the reply. Both the headline reader and
 * the verdict reader decide by this flag.
 */
export function labelOf(line: string): { label: "HEADLINE" | "POINT" | "READ" | "NO_CHANGE"; value: string; block: boolean } | undefined {
  const match = BLOCK_LABEL.exec(line);
  if (match === null) return undefined;
  const label = match[1]!.toUpperCase() as "HEADLINE" | "POINT" | "READ" | "NO_CHANGE";
  const value = plain(match[2]!);
  const block = label === "READ" ? /^(?:yes|no)\b/i.test(value) : label === "NO_CHANGE" ? /^yes$/i.test(value) : true;
  return { label, value, block };
}

/** Whether the line is a line of the headline block. */
export const isBlockLine = (line: string): boolean => labelOf(line)?.block === true;

/** A reply of at least this many words can be a must-read by the agent's own flag. */
const READ_FLAG_MIN_WORDS = 150;
const WORDS_PER_MINUTE = 200;
const MAX_READ_MINUTES = 60;

/** What the engine knows about the attempt that decides whether its reply is a must-read. */
export interface ReadContext {
  /** The step is `you approve` and what it asks you to approve changed nothing: the text is the thing you approve. */
  readonly approvesText: boolean;
  /** The template finishes with findings or a document and this is its last agent step. */
  readonly lastOfDocument: boolean;
  /** The step was told it may say "no change needed", and what it asks you to approve changed nothing. */
  readonly noChangeOffered?: boolean;
}

/** Minutes to read `words`, rounded up: 1 to 60. */
export const readMinutesOf = (words: number): number => Math.min(MAX_READ_MINUTES, Math.max(1, Math.ceil(words / WORDS_PER_MINUTE)));

/**
 * The record of what the agent said. A reply is a must-read when the engineer approves a text
 * that changed nothing, when it is the findings or document the template ends with, or when the
 * agent flagged it and it has at least 150 words.
 */
export function saidOf(parsed: ParsedHeadline | undefined, context: ReadContext): Said | undefined {
  if (parsed === undefined) return undefined;
  const mustRead = context.approvesText || context.lastOfDocument || (parsed.readFlag && parsed.words >= READ_FLAG_MIN_WORDS);
  return {
    source: parsed.source,
    headline: parsed.headline,
    points: parsed.points,
    morePoints: parsed.morePoints,
    bodyBytes: parsed.bodyBytes,
    ...(mustRead && { readMinutes: readMinutesOf(parsed.words) }),
    ...(context.noChangeOffered === true && parsed.noChange && { noChange: true as const }),
  };
}
