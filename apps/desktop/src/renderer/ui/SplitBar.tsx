// A whole cut into parts on one thin bar: how much of the memory Tokama, the other apps and nothing
// use. Each part is a rounded rect with a gap to the next; the length is the share and the colour
// only repeats the words beside the bar, so `label` must say every number. Drawn in SVG at the
// measured width, since the page allows no inline styles and the gap is 2 px at any width.
import { useEffect, useRef, useState } from "react";

/** Tokama's own part, the other apps' part, and what is left over. */
export type SplitTone = "tokama" | "other" | "rest";

export interface SplitPart {
  readonly tone: SplitTone;
  readonly value: number;
}

const HEIGHT = 8;
const GAP = 2;
/** A part that is not nothing stays visible. */
const MIN_PART = 3;
const DEFAULT_WIDTH = 300;

export interface PlacedPart {
  readonly x: number;
  readonly width: number;
}

/** Where each part goes on a bar `width` wide; undefined for a part of nothing. A part never gets less than `MIN_PART`, and the largest gives the room back. */
export function layoutSplit(values: readonly number[], width: number, total: number = values.reduce((sum, value) => sum + Math.max(0, value), 0)): (PlacedPart | undefined)[] {
  const shown = values.map((value) => value > 0);
  const count = shown.filter(Boolean).length;
  const room = Math.max(0, width - GAP * Math.max(0, count - 1));
  const whole = Math.max(total, values.reduce((sum, value) => sum + Math.max(0, value), 0));
  const widths = values.map((value, index) => (shown[index] === true && whole > 0 ? Math.max(MIN_PART, (value / whole) * room) : 0));
  const excess = widths.reduce((sum, value) => sum + value, 0) - room;
  if (excess > 0) {
    const largest = widths.indexOf(Math.max(...widths));
    widths[largest] = (widths[largest] ?? 0) - excess;
  }
  let x = 0;
  return values.map((_, index) => {
    if (shown[index] !== true) return undefined;
    const placed = { x, width: Math.max(0, widths[index] ?? 0) };
    x += placed.width + GAP;
    return placed;
  });
}

export interface SplitBarProps {
  /** What the bar says in words, with every number, for screen readers: "Memory: Tokama 2.3 GB, other apps 18.1 GB, free 11.6 GB of 32 GB". */
  readonly label: string;
  readonly parts: readonly SplitPart[];
  /** The whole the parts are shares of; the sum of the parts by default. A gap at the end stays empty. */
  readonly total?: number | undefined;
}

export function SplitBar({ label, parts, total }: SplitBarProps) {
  const svg = useRef<SVGSVGElement | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useEffect(() => {
    const element = svg.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => entry !== undefined && entry.contentRect.width > 0 && setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const placed = layoutSplit(
    parts.map((part) => part.value),
    width,
    total,
  );
  return (
    <svg ref={svg} className="split-bar" width="100%" height={HEIGHT} role="img" aria-label={label}>
      {parts.map((part, index) => {
        const at = placed[index];
        return at === undefined ? null : <rect key={part.tone} className="split-part" data-tone={part.tone} x={at.x} y={0} width={at.width} height={HEIGHT} rx={HEIGHT / 2} />;
      })}
    </svg>
  );
}

/** The small square beside a part's name in the legend, in the part's colour. */
export function SplitSwatch({ tone }: { readonly tone: SplitTone }) {
  return <span className="split-swatch" data-tone={tone} aria-hidden="true" />;
}
