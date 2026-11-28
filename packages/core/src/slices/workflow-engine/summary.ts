// What an agent's output says, read for the card of a step that stopped: the reviewer's verdict
// with the items of its "Must change" list, or the first lines as written. Agent output is free
// text, so the reading is tolerant: an unknown shape gives the first lines, never an error.
import {
  MAX_CHOICES,
  MAX_EVIDENCE,
  MAX_HEADLINE_CHARS,
  MAX_MUST_FIX,
  MAX_PLAN_PART_CHARS,
  MAX_POINT_CHARS,
  MAX_POINTS,
  MAX_RISKS,
  MAX_SUMMARY_ITEMS,
  MAX_SUMMARY_LINE_CHARS,
  type FindingsSaid,
  type OutputSummary,
  type PlacedNote,
  type PlanChoice,
  type PlanReach,
  type PlanSummary,
  type ReachKind,
  type ReviewSaid,
} from "../../kernel/schemas/index.js";
import { cutText } from "../../kernel/text/index.js";
import { extraLabelOf, isBlockLine, labelOf, plain, type ExtraLabel } from "./headline.js";
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
 * The first non-empty lines as written, each cut to fit: without the headline block and verdict
 * lines, unless the output holds nothing else (`VERDICT: APPROVE` alone is no verdict, and still
 * says something).
 */
function firstLines(lines: readonly string[], count: number): string[] {
  const all = lines.map((line) => line.trim()).filter((line) => line !== "");
  const written = all.filter((line) => labelOf(line)?.block !== true);
  const words = written.filter((line) => !VERDICT_LINE.test(line));
  return (words.length > 0 ? words : written.length > 0 ? written : all).slice(0, count).map(cut);
}

/** The items of the first "Must change" (or "Must fix") section, up to the next heading. */
function mustFixItems(lines: readonly string[]): { ref?: string; text: string }[] {
  const start = lines.findIndex((line) => MUST_HEADING.test(headingText(line) ?? ""));
  if (start < 0) return [];
  const items: { ref?: string; text: string }[] = [];
  for (const line of lines.slice(start + 1)) {
    if (headingText(line) !== undefined || VERDICT_LINE.test(line.trim()) || labelOf(line)?.block === true) break;
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

// ---- the headline block ---------------------------------------------------------------------

/** How many non-empty lines at the end of a reply the headline block is looked for in. */
const BLOCK_WINDOW = 30;
/** What `parseHeadline` reads from a reply. `words` and `bodyBytes` count the reply without the block. */
export interface ParsedHeadline {
  readonly source: "headline" | "first_lines";
  readonly headline: string;
  readonly points: string[];
  readonly morePoints: number;
  readonly bodyBytes: number;
  readonly words: number;
  /** The agent wrote `READ: yes`. */
  readonly readFlag: boolean;
  /** The agent wrote `NO_CHANGE: yes` in its block, after the headline. */
  readonly noChange: boolean;
  /** The plan lines of the block; empty when there are none. */
  readonly plan: PlanSummary;
  /** The step was asked for the plan lines and plan labels stand in its last lines, yet none was read. */
  readonly planUnread: boolean;
  /** The MUST lines of the block; empty when there are none. */
  readonly review: ReviewSaid;
  /** The EVIDENCE and NEXT lines of the block; empty when there are none. */
  readonly findings: FindingsSaid;
}

/**
 * The headline of an agent's final reply: the last `HEADLINE:` line among the last 30 non-empty
 * lines, with the `POINT:` and `READ:` lines after it. Without one the first lines of the reply
 * stand in. Undefined when the reply says nothing. Never throws.
 */
export function parseHeadline(text: string, planAsked = false, asked?: "review" | "findings"): ParsedHeadline | undefined {
  try {
    return parse(text, planAsked, asked);
  } catch {
    return undefined;
  }
}

function parse(text: string, planAsked: boolean, asked: "review" | "findings" | undefined): ParsedHeadline | undefined {
  const lines = text.split(/\r?\n/);
  // Only a step that was asked for the plan, review or findings lines reads them; for any other step they are text of the reply.
  const planLines = extraLineIndices(lines, planAsked, asked);
  const extras = planLines.map((index) => extraLabelOf(lines[index]!)!);
  const plan = parsePlan(extras);
  const review = parseReview(extras);
  const findings = parseFindings(extras);
  const planUnread = planAsked && planLines.length === 0 && planLabelsUnread(lines);
  // The plan, review and findings lines do not count toward the window the headline is looked for in.
  const window = lines.flatMap((line, index) => (line.trim() === "" || planLines.includes(index) ? [] : [index])).slice(-BLOCK_WINDOW);
  const head = window.findLast((index) => labelOf(lines[index]!)?.label === "HEADLINE");
  const headline = head === undefined ? "" : labelOf(lines[head]!)!.value;
  const after = head === undefined || headline === "" ? [] : window.filter((index) => index > head).map((index) => labelOf(lines[index]!));
  // Whatever is block text from the headline on is not part of the reply, and neither are the plan lines.
  const body = lines.filter((line, index) => !planLines.includes(index) && ((head === undefined || index < head) || labelOf(line)?.block !== true));
  const bodyText = body.join("\n").trim();
  const result = { bodyBytes: new TextEncoder().encode(bodyText).length, words: bodyText === "" ? 0 : bodyText.split(/\s+/).length };
  if (headline !== "") {
    const points = after.flatMap((found) => (found?.label === "POINT" && found.value !== "" ? [found.value] : []));
    return {
      source: "headline",
      headline: cutText(headline, MAX_HEADLINE_CHARS),
      points: points.slice(0, MAX_POINTS).map((point) => cutText(point, MAX_POINT_CHARS)),
      morePoints: Math.max(0, points.length - MAX_POINTS),
      ...result,
      readFlag: after.some((found) => found?.label === "READ" && /^yes\b/i.test(found.value)),
      noChange: after.some((found) => found?.label === "NO_CHANGE" && found.block),
      plan,
      planUnread,
      review,
      findings,
    };
  }
  const said = body.flatMap((line) => (VERDICT_LINE.test(line.trim()) || labelOf(line)?.block === true ? [] : [plain(line)])).filter((line) => line !== "");
  if (said.length === 0) return undefined;
  return {
    source: "first_lines",
    headline: cutText(said[0]!, MAX_HEADLINE_CHARS),
    points: said.slice(1, 3).map((line) => cutText(line, MAX_POINT_CHARS)),
    morePoints: 0,
    ...result,
    readFlag: false,
    noChange: false,
    plan,
    planUnread,
    review,
    findings,
  };
}

// ---- the plan lines -------------------------------------------------------------------------

/** How many non-empty lines at the end of a reply the plan lines are looked for in. */
const PLAN_WINDOW = 40;
const FENCE_LINE = /^\s*(?:`{3,}|~{3,})[\w+-]*\s*$/;
// Only the exact words of "there is none": anything longer is a value, because a card that says
// "none" for a secret or a service the plan needs is worse than one that shows its words.
const NONE_WORDS = /^(?:none|nothing|n\/a|-|–|—)[.!]?$/i;
// A reach line also says "no" and "no new <kind>".
const NONE_REACH = /^(?:no|none needed|no new (?:files?|dependenc(?:y|ies)|deps?|(?:outside )?services?|secrets?|keys?))[.!]?$/i;
const UNSURE = /^unsure\s*:\s*/i;
const REACH_KINDS: Readonly<Record<string, ReachKind>> = {
  file: "files",
  files: "files",
  dep: "deps",
  deps: "deps",
  dependencies: "deps",
  "new dependencies": "deps",
  service: "services",
  services: "services",
  "outside services": "services",
  secret: "secrets",
  secrets: "secrets",
  keys: "secrets",
};

/**
 * The plan, review and findings lines of the block: those after the last `HEADLINE:` line, up to
 * the end of the reply, where every line is a block or such a line (empty lines and code fences
 * are stepped over, and a reviewer's block steps over one `VERDICT:` line), and those directly
 * above it with no empty line between. A reply that goes on in prose after the block has none,
 * and one of these labels anywhere else in the reply is prose. A label counts only for the step
 * that was asked for it: plan labels for `planAsked`, `MUST:` for a reviewer step (`asked`),
 * `EVIDENCE:` and `NEXT:` for the findings step.
 */
function extraLineIndices(lines: readonly string[], planAsked: boolean, asked: "review" | "findings" | undefined): number[] {
  const counts = (line: string): boolean => {
    const label = extraLabelOf(line)?.label;
    if (label === undefined) return false;
    return label === "MUST" ? asked === "review" : label === "EVIDENCE" || label === "NEXT" ? asked === "findings" : planAsked;
  };
  const head = lastHeadline(lines);
  if (head === undefined) return [];
  const found: number[] = [];
  let seen = 0;
  let verdict = false;
  for (let index = head + 1; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.trim() === "" || FENCE_LINE.test(line)) continue;
    if (++seen > PLAN_WINDOW) return [];
    if (counts(line)) found.push(index);
    else if (asked === "review" && !verdict && VERDICT_LINE.test(line.trim())) verdict = true;
    else if (!isBlockLine(line)) return [];
  }
  const above: number[] = [];
  for (let index = head - 1; index >= 0 && above.length < PLAN_WINDOW; index--) {
    const line = lines[index]!;
    if (FENCE_LINE.test(line)) continue;
    if (counts(line)) above.push(index);
    else if (line.trim() === "" || !isBlockLine(line)) break;
  }
  return [...above.reverse(), ...found];
}

/** The last `HEADLINE:` line among the last 80 non-empty lines. */
function lastHeadline(lines: readonly string[]): number | undefined {
  let seen = 0;
  for (let index = lines.length - 1; index >= 0 && seen < 2 * PLAN_WINDOW; index--) {
    if (lines[index]!.trim() === "") continue;
    seen++;
    if (labelOf(lines[index]!)?.label === "HEADLINE") return index;
  }
  return undefined;
}

/** Plan labels sit in the last lines of the reply, yet none was read: the agent wrote them in a shape the reader does not know. */
function planLabelsUnread(lines: readonly string[]): boolean {
  return lines.filter((line) => line.trim() !== "").slice(-PLAN_WINDOW).some((line) => ["CHOICE", "REACH", "RISK"].includes(extraLabelOf(line)?.label ?? ""));
}

/** The parts of a line, split on `|`: at most three, the rest joined into the last. */
function partsOf(value: string): string[] {
  const parts = value.replace(/^\s*\|+\s*|\s*\|+\s*$/g, "").split(/\s*\|\s*/);
  return parts.length <= 3 ? parts : [parts[0]!, parts[1]!, parts.slice(2).join(" | ")];
}

const part = (text: string | undefined): string | undefined => (text === undefined || text === "" ? undefined : cutText(text, MAX_PLAN_PART_CHARS));

function choiceOf(value: string): PlanChoice | undefined {
  const parts = partsOf(value);
  const [open, picked, means] = parts.length === 1 ? [undefined, parts[0], undefined] : parts;
  // "Unsure: " leads the open part or the picked part.
  const unsure = [open, picked].some((p) => p !== undefined && UNSURE.test(p));
  const answer = part(picked?.replace(UNSURE, "").trim());
  if (answer === undefined) return undefined;
  const asked = part(open?.replace(UNSURE, "").trim());
  const meant = part(means);
  return { ...(asked !== undefined && { open: asked }), picked: answer, ...(meant !== undefined && { means: meant }), ...(unsure && { unsure: true as const }) };
}

function reachOf(value: string): PlanReach | undefined {
  const [kind, said, note] = partsOf(value);
  const known = REACH_KINDS[(kind ?? "").toLowerCase()];
  const written = part(said);
  if (known === undefined || written === undefined) return undefined;
  const noted = part(note);
  return { kind: known, ...(NONE_WORDS.test(written) || NONE_REACH.test(written) ? { none: true as const } : { value: written }), ...(noted !== undefined && { note: noted }) };
}

/** The plan lines read in order: each reach kind once (the first wins), 7 choices and 3 risks, the rest counted. */
function parsePlan(found: readonly { label: ExtraLabel; value: string }[]): PlanSummary {
  const choices = found.flatMap((line) => (line.label === "CHOICE" ? [choiceOf(line.value)] : [])).filter((choice) => choice !== undefined);
  const risks = found.flatMap((line) => {
    const risk = line.label === "RISK" ? part(line.value) : undefined;
    return risk === undefined || NONE_WORDS.test(risk) ? [] : [risk];
  });
  const reach: PlanReach[] = [];
  for (const line of found) {
    const read = line.label === "REACH" ? reachOf(line.value) : undefined;
    if (read !== undefined && !reach.some((r) => r.kind === read.kind)) reach.push(read);
  }
  return {
    choices: choices.slice(0, MAX_CHOICES),
    moreChoices: Math.max(0, choices.length - MAX_CHOICES),
    reach,
    risks: risks.slice(0, MAX_RISKS),
    moreRisks: Math.max(0, risks.length - MAX_RISKS),
  };
}

// A MUST or EVIDENCE line that says there is none: "none", "n/a", "-". Stricter than `NONE`: "No timeout is cleared" is a finding.
const NO_NOTE = /^(?:none|nothing|n\/a|-|–|—)[.!]?$/i;

/** `<where> | <what>`: at most two parts, the rest joined into the what; a line without `|` is the what alone. Undefined for an empty line or "none". */
function placedOf(value: string): PlacedNote | undefined {
  const trimmed = value.replace(/^\s*\|+\s*|\s*\|+\s*$/g, "");
  if (NO_NOTE.test(trimmed)) return undefined;
  const parts = trimmed.split(/\s*\|\s*/);
  const where = parts.length > 1 ? part(parts[0]) : undefined;
  const what = part(parts.length > 1 ? parts.slice(1).join(" | ") : parts[0]);
  return what === undefined ? undefined : { ...(where !== undefined && { where }), what };
}

/** The MUST lines in order: 5 carried, the rest counted. */
function parseReview(found: readonly { label: ExtraLabel; value: string }[]): ReviewSaid {
  const notes = found.flatMap((line) => (line.label === "MUST" ? [placedOf(line.value)] : [])).filter((note) => note !== undefined);
  return { mustFix: notes.slice(0, MAX_MUST_FIX), moreMustFix: Math.max(0, notes.length - MAX_MUST_FIX) };
}

/** The EVIDENCE lines in order (5 carried, the rest counted) and the first NEXT line that says something; NEXT is not split on `|`. */
function parseFindings(found: readonly { label: ExtraLabel; value: string }[]): FindingsSaid {
  const notes = found.flatMap((line) => (line.label === "EVIDENCE" ? [placedOf(line.value)] : [])).filter((note) => note !== undefined);
  const next = found.flatMap((line) => (line.label === "NEXT" && !NO_NOTE.test(line.value) ? [part(line.value)] : [])).find((text) => text !== undefined);
  return { evidence: notes.slice(0, MAX_EVIDENCE), moreEvidence: Math.max(0, notes.length - MAX_EVIDENCE), ...(next !== undefined && { next }) };
}

/** Markdown emphasis and code marks out, spaces folded. */
const clean = (text: string): string =>
  text
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .replace(/:$/, "")
    .trim();

const cut = (text: string): string => cutText(text, MAX_SUMMARY_LINE_CHARS);
const cutRef = (ref: string): string => cutText(ref, 200);
