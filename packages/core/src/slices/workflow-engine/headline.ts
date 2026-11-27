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

/** Added to a reviewer's instructions in place of `HEADLINE_RULE`, before its `VERDICT_RULE`, which keeps the last line. */
export const REVIEWER_HEADLINE_RULE = `${HEADLINE_RULE}
This block goes above the VERDICT line.`;

// A block label at the start of a line, in any letter case, after a list mark, a quote mark or bold
// marks; the rest of the line is the value (any character, so a line separator does not end it).
// The one grammar for the headline parser and the verdict reader.
export const BLOCK_LABEL = /^\s*(?:(?:[-*]\s+|>\s*)*)(?:\*\*|__)?(HEADLINE|POINT|READ)(?:\*\*|__)?\s*:([\s\S]*)$/i;

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
  };
}
