// Text cut to a length, with `…` where text was left out. Lengths count UTF-16 units, as
// `String.length` and the schema limits do; a cut falls between graphemes, so it never splits a
// surrogate pair, a combining sequence or a joined emoji.
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export const CUT_MARK = "…";

export interface CutOptions {
  /** Which end stays: `head` (the default) keeps the start, `tail` keeps the end. */
  readonly keep?: "head" | "tail";
}

/** `text` as it is when it has at most `max` UTF-16 units; otherwise cut to at most `max`, the `…` mark included. */
export function cutText(text: string, max: number, options: CutOptions = {}): string {
  if (text.length <= max) return text;
  if (max < 1) return "";
  const room = Math.max(0, max - 1);
  const segments = SEGMENTER.segment(text);
  if (options.keep === "tail") {
    const from = text.length - room;
    const cluster = segments.containing(from);
    const start = cluster === undefined || cluster.index === from ? from : cluster.index + cluster.segment.length;
    return `${CUT_MARK}${text.slice(start)}`;
  }
  const end = segments.containing(room)?.index ?? room;
  return `${text.slice(0, end)}${CUT_MARK}`;
}
