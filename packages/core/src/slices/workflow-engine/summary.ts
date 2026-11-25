// What an agent's output says, read for the card of a step that stopped: the reviewer's verdict
// with the items of its "Must change" list, or the first lines as written. Agent output is free
// text, so the reading is tolerant: an unknown shape gives the first lines, never an error.
import { MAX_SUMMARY_ITEMS, MAX_SUMMARY_LINE_CHARS, type OutputSummary } from "../../kernel/schemas/index.js";
import { parseVerdict } from "./verdict.js";

/** First lines shown for a step without a verdict format; a verdict step that broke it shows more. */
const PLAIN_LINES = 2;

const LIST_ITEM = /^ {0,3}(?:\d{1,3}[.)]|[-*+])\s+(.+)$/;
const MUST_HEADING = /^must[\s-]+(?:change|fix)/i;
const VERDICT_LINE = /^VERDICT:/;
// A file:line the agent named, in backticks or bare; the path has a dot or a slash in it.
const TICKED_REF = /`([^`\s]*[./][^`\s]*:\d+(?:[-–]\d+)?)`/;
const BARE_REF = /(?<![\w./-])([\w./-]*[\w-]\.[A-Za-z0-9]+:\d+(?:[-–]\d+)?)(?!\w)/;

/**
 * The summary of an output. `verdictFormat` says the step's template asks for a verdict (a
 * `reviewer approves` step). `tail` is the end of an output that `text` holds only the start of:
 * the verdict is read from it, the rest from `text`. Never throws: whatever goes wrong reads as
 * the first lines.
 */
export function summarizeOutput(text: string, verdictFormat: boolean, tail?: string): OutputSummary {
  try {
    return summarize(text, verdictFormat, tail);
  } catch {
    const lines = firstLines(text.split(/\r?\n/), MAX_SUMMARY_ITEMS);
    return lines.length === 0 ? { kind: "empty" } : { kind: "lines", format: verdictFormat ? "no_verdict" : "none", lines };
  }
}

function summarize(text: string, verdictFormat: boolean, tail: string | undefined): OutputSummary {
  const lines = text.split(/\r?\n/);
  if (lines.every((line) => line.trim() === "")) return { kind: "empty" };
  if (!verdictFormat) return { kind: "lines", format: "none", lines: firstLines(lines, PLAIN_LINES) };
  const verdict = parseVerdict(tail ?? text);
  if (verdict === undefined) return { kind: "lines", format: "no_verdict", lines: firstLines(lines, MAX_SUMMARY_ITEMS) };
  const items = mustFixItems(lines);
  return {
    kind: "verdict",
    verdict,
    mustFix: items.slice(0, MAX_SUMMARY_ITEMS),
    more: Math.max(0, items.length - MAX_SUMMARY_ITEMS),
    lines: items.length === 0 ? firstLines(lines, MAX_SUMMARY_ITEMS) : [],
  };
}

/**
 * The first non-empty lines as written, each cut to fit: without verdict lines, unless the output
 * holds nothing else (`VERDICT: APPROVE` alone is no verdict, and still says something).
 */
function firstLines(lines: readonly string[], count: number): string[] {
  const written = lines.map((line) => line.trim()).filter((line) => line !== "");
  const words = written.filter((line) => !VERDICT_LINE.test(line));
  return (words.length > 0 ? words : written).slice(0, count).map(cut);
}

/** The items of the first "Must change" (or "Must fix") section, up to the next heading. */
function mustFixItems(lines: readonly string[]): { ref?: string; text: string }[] {
  const start = lines.findIndex((line) => MUST_HEADING.test(headingText(line) ?? ""));
  if (start < 0) return [];
  const items: { ref?: string; text: string }[] = [];
  for (const line of lines.slice(start + 1)) {
    if (headingText(line) !== undefined || VERDICT_LINE.test(line.trim())) break;
    const item = LIST_ITEM.exec(line);
    if (item === null) continue;
    const parsed = itemOf(item[1]!);
    if (parsed !== undefined) items.push(parsed);
  }
  return items;
}

/**
 * The words of a heading line: `## Must change`, a line that is all bold (`**Must change**`), a
 * short line of its own that ends with a colon (`Must change:`), or a short unindented line of
 * words that ends no sentence (`Should change`). Undefined for any other line.
 */
function headingText(line: string): string | undefined {
  const trimmed = line.trim();
  if (trimmed === "" || LIST_ITEM.test(line)) return undefined;
  const hashes = /^#{1,6}\s+(.+)$/.exec(trimmed);
  if (hashes !== null) return clean(hashes[1]!);
  const bold = /^(\*\*|__)(.+?)\1:?$/.exec(trimmed);
  if (bold !== null) return clean(bold[2]!);
  if (/^[A-Za-z][^.!?]{0,60}:$/.test(trimmed)) return clean(trimmed);
  if (/^[A-Z][A-Za-z ()-]{0,39}$/.test(line)) return clean(trimmed);
  return undefined;
}

/**
 * One must-fix item: the file:line it names, and its lead. A bold lead (`**`a.ts:3`: what.**`) is
 * the lead; otherwise the text up to the first sentence break.
 */
function itemOf(raw: string): { ref?: string; text: string } | undefined {
  const bold = /^(\*\*|__)(.+?)\1/.exec(raw);
  let lead = bold === null ? raw : bold[2]!;
  const ref = TICKED_REF.exec(lead) ?? BARE_REF.exec(lead);
  if (ref !== null) lead = lead.replace(ref[0], " ");
  lead = clean(lead).replace(/^[\s:—–-]+/, "");
  if (bold === null) lead = lead.split(/(?<=\S)(?:[.;:!?]\s|\s[—–-]\s)/)[0]!;
  lead = lead.replace(/[.:;]+$/, "").trim();
  // A bold part that held only the file:line: the rest of the item is the text.
  if (lead === "") lead = clean(raw.replace(ref?.[0] ?? "", " ")).replace(/^[\s:—–-]+/, "");
  if (lead === "") return undefined;
  const where = ref?.[1];
  return { ...(where !== undefined && { ref: cutRef(where) }), text: cut(lead) };
}

/** Markdown emphasis and code marks out, spaces folded. */
const clean = (text: string): string =>
  text
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .replace(/:$/, "")
    .trim();

const cut = (text: string): string => (text.length > MAX_SUMMARY_LINE_CHARS ? `${text.slice(0, MAX_SUMMARY_LINE_CHARS - 1)}…` : text);
const cutRef = (ref: string): string => (ref.length > 200 ? `${ref.slice(0, 199)}…` : ref);
