// Whether New work text reads as a question, by fixed rules: no AI, English words only.

const MAX_CHARS = 400;
const REQUEST_START = /^(?:can you|could you|would you|will you|please)\b/i;
const QUESTION_MARK = /[?？؟]$/;
const QUESTION_WORDS = new Set(["how", "what", "why", "where", "when", "which", "who", "is", "are", "does", "do"]);
const FIRST_PERSON = new Set(["i", "we"]);

/**
 * True for one short paragraph that asks something: it ends with a question mark, or starts with a
 * question word ("can" and "should" only before "I" or "we"). A request phrased as a question
 * ("Can you add CSV export?", "Please explain…?") is not one, and neither is a long text or an alert.
 */
export function looksLikeQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.length > MAX_CHARS || /\n\s*\n/.test(trimmed)) return false;
  if (REQUEST_START.test(trimmed)) return false;
  if (QUESTION_MARK.test(trimmed)) return true;
  const words = /^([a-z']+)(?:\s+([a-z']+))?/i.exec(trimmed);
  const first = words?.[1]?.toLowerCase();
  if (first === undefined) return false;
  if (first === "can" || first === "should") return FIRST_PERSON.has(words?.[2]?.toLowerCase() ?? "");
  return QUESTION_WORDS.has(first);
}
