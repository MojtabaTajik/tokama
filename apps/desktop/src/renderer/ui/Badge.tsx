// Counts. Badge: a small count on an icon button, or a symbol when the kind matters more than how
// many (the button's label says it in words). StatusCounts: a row of symbol-and-count badges, such
// as a sidebar row's "⏸ 2 ✕ 1 ● 3", each with its words for screen readers and as a tooltip.

export interface BadgeProps {
  readonly count: number;
  readonly tone: "warn" | "fail" | "neutral";
  readonly symbol?: string | undefined;
}

/** Nothing at zero; 99+ above 99. Hidden from screen readers: the button's label carries the count. */
export function Badge({ count, tone, symbol }: BadgeProps) {
  if (count <= 0) return null;
  return (
    <span className="badge" data-tone={tone} aria-hidden="true">
      {symbol ?? (count > 99 ? "99+" : count)}
    </span>
  );
}

export interface StatusCount {
  readonly kind: "needs" | "failed" | "running";
  readonly symbol: string;
  readonly count: number;
  readonly word: string;
}

export function StatusCounts({ counts, className }: { readonly counts: readonly StatusCount[]; readonly className?: string | undefined }) {
  if (counts.length === 0) return null;
  return (
    <span className={["status-counts", className].filter(Boolean).join(" ")}>
      {counts.map((count) => (
        <span key={count.kind} className="status-count" data-kind={count.kind} title={`${count.count} ${count.word}`}>
          <span aria-hidden="true">
            {count.symbol} {count.count}
          </span>
          <span className="visually-hidden">
            {count.count} {count.word}
          </span>
        </span>
      ))}
    </span>
  );
}
