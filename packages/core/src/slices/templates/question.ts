// Whether New work text reads as a question, by fixed rules: no AI, English words only.

const MAX_CHARS = 400;
const REQUEST_START = /^(?:can you|could you|would you|will you|please)\b/i;
const QUESTION_MARK = /[?？؟]$/;
// A pasted alert field ("What: 502 from gateway") starts with a word and a colon.
const ALERT_FIELD = /^[a-z]+\s*:/i;
const QUESTION_WORDS = new Set(["how", "what", "why", "which", "who", "is", "are", "does"]);
// These start many bug reports and orders ("When I click Export it crashes", "Do not retry"): they count only with the word a question puts next.
const NEEDS_AUXILIARY = new Set(["when", "where"]);
const AUXILIARY = new Set(["is", "are", "does", "do", "did", "can", "could", "will", "would", "should", "was", "were"]);
const FIRST_PERSON = new Set(["i", "we"]);
const PRONOUN = new Set(["i", "we", "you", "they"]);

/**
 * True for one short paragraph that asks something: it ends with a question mark, or starts with a
 * question word ("can" and "should" only before "I" or "we", "do" only before a pronoun, "when" and
 * "where" only before a verb like "is" or "does"). A request phrased as a question
 * ("Can you add CSV export?", "Please explain…?") is not one, and neither is a long text or an alert.
 */
export function looksLikeQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.length > MAX_CHARS || /\n\s*\n/.test(trimmed)) return false;
  if (REQUEST_START.test(trimmed)) return false;
  if (QUESTION_MARK.test(trimmed)) return true;
  if (ALERT_FIELD.test(trimmed)) return false;
  // The first word stops at an apostrophe, so "what's" and "what’s" both read as "what".
  const words = /^([a-z]+)(?:['’][a-z]+)?(?:\s+([a-z]+))?/i.exec(trimmed);
  const first = words?.[1]?.toLowerCase();
  if (first === undefined) return false;
  const second = words?.[2]?.toLowerCase() ?? "";
  if (first === "can" || first === "should") return FIRST_PERSON.has(second);
  if (first === "do") return PRONOUN.has(second);
  if (NEEDS_AUXILIARY.has(first)) return AUXILIARY.has(second);
  return QUESTION_WORDS.has(first);
}
