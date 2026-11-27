// Counts. Badge: a small mark on an icon button that says the user has to do something: a count, or
// one "!" when the cause matters more than how many (the button's label says it in words).
// StatusCounts: a row of symbol-and-count badges, such as a sidebar row's "⏸ 2 ✕ 1", with their
// words for screen readers and in a tooltip.
import { type CSSProperties, useId } from "react";
import { Tooltip } from "./Tooltip.js";
import { useHostTip } from "./useTip.js";

export interface BadgeProps {
  readonly count: number;
  readonly tone: "warn" | "fail";
  /** "!" in place of the count. */
  readonly symbol?: "!" | undefined;
}

/** Nothing at zero; 1 to 9, then 9+. Hidden from screen readers: the button's label carries the exact count. */
export function Badge({ count, tone, symbol }: BadgeProps) {
  if (count <= 0) return null;
  return (
    <span className="badge" data-tone={tone} aria-hidden="true">
      {symbol ?? (count > 9 ? "9+" : count)}
    </span>
  );
}

export interface StatusCount {
  readonly kind: "needs" | "failed";
  readonly symbol: string;
  readonly count: number;
  readonly word: string;
}

/**
 * The counts of a row, each as symbol and number with its words for screen readers. The words also show in the
 * shared tooltip while the pointer is on the row or the keyboard focus is on the row's button around the counts.
 */
export function StatusCounts({ counts, className }: { readonly counts: readonly StatusCount[]; readonly className?: string | undefined }) {
  const { ref, open } = useHostTip(counts.length > 0);
  const anchor = `--counts-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  if (counts.length === 0) return null;
  return (
    <span ref={ref} className={["status-counts", className].filter(Boolean).join(" ")} style={{ anchorName: anchor } as CSSProperties}>
      {counts.map((count) => (
        <span key={count.kind} className="status-count" data-kind={count.kind}>
          <span aria-hidden="true">
            {count.symbol} {count.count}
          </span>
          <span className="visually-hidden">
            {count.count} {count.word}
          </span>
        </span>
      ))}
      {open && (
        <Tooltip id={`${anchor.slice(2)}-tip`} anchor={anchor} className="counts-tip" decorative>
          {counts.map((count) => `${count.count} ${count.word}`).join(" · ")}
        </Tooltip>
      )}
    </span>
  );
}
