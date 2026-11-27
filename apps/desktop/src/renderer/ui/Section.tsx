// A section that folds: one line (an arrow, a name, who, a state, facts) that is the toggle, and a
// body shown under it only while it is open. The line is a button inside a heading, so Tab reaches
// every line and Enter and Space open and close it; a line with nothing behind it is plain text.
// The body is built by a function that is called only while the section is open, so a closed
// section costs nothing and its body is not in the page for Tab or a screen reader to reach.
// SectionList draws the bar above a list of sections with its Expand all and Collapse all.
import { type ReactNode, type Ref, useId, useReducer } from "react";
import { Button } from "./Button.js";
import { ChevronIcon } from "./icons.js";
import { type Mark, StatusMark } from "./status.js";

export type SectionLevel = "step" | "attempt";

export interface SectionProps {
  readonly title: string;
  /** Who works on it; the screen draws the name (in the agent's colour when it likes). */
  readonly agent?: ReactNode;
  /** The state, always shown with its word next to the symbol. */
  readonly state?: Mark | undefined;
  /** The line's facts as they are seen: "3 attempts · 4 m 12 s · 38 KB". */
  readonly facts?: string | undefined;
  /** The same facts with their units spelled for screen readers: "3 attempts, 4 minutes 12 seconds, 38 kilobytes". */
  readonly spokenFacts?: string | undefined;
  /** An attempt is one size smaller than a step and sits inside one. */
  readonly level?: SectionLevel;
  /** The heading the line sits in, when the page's outline needs another than the level gives (h3 for a step, h4 for an attempt). */
  readonly heading?: "h2" | "h3" | "h4";
  readonly open: boolean;
  readonly onToggle: () => void;
  /** Nothing to show behind the line: no arrow, not a button. */
  readonly disabled?: boolean;
  /** One line under a closed section's line (and under a line with nothing behind it). */
  readonly summary?: ReactNode;
  /** The deep link focuses the line. */
  readonly buttonRef?: Ref<HTMLButtonElement>;
  readonly className?: string | undefined;
  /** The body, built only while the section is open. */
  readonly children: () => ReactNode;
}

export function Section({ title, agent, state, facts, spokenFacts, level = "step", heading, open, onToggle, disabled = false, summary, buttonRef, className, children }: SectionProps) {
  const id = useId();
  const headId = `${id}-head`;
  const bodyId = `${id}-body`;
  const Heading = heading ?? (level === "step" ? "h3" : "h4");
  const line = (
    <>
      <span className="sec-chev" aria-hidden="true">
        <ChevronIcon />
      </span>
      <span className="sec-name">{title}</span>
      {agent !== undefined && <span className="sec-agent">{agent}</span>}
      {state !== undefined && (
        <span className="sec-state">
          <StatusMark status={state} />
          {state.word}
        </span>
      )}
      {facts !== undefined && (
        <span className="sec-facts mono" aria-hidden={spokenFacts === undefined ? undefined : "true"}>
          {facts}
        </span>
      )}
      {spokenFacts !== undefined && <span className="visually-hidden">, {spokenFacts}</span>}
    </>
  );
  return (
    <section className={["sec", level === "attempt" && "sec-sub", className].filter(Boolean).join(" ")} data-open={open || undefined}>
      <Heading className="sec-h">
        {disabled ? (
          <div className="sec-head" data-plain="true">
            {line}
          </div>
        ) : (
          <button type="button" id={headId} ref={buttonRef} className="sec-head" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={onToggle}>
            {line}
          </button>
        )}
      </Heading>
      {!open && summary !== undefined && <p className="sec-sum">{summary}</p>}
      {!disabled && open && (
        <div id={bodyId} role="region" aria-labelledby={headId} className="sec-body">
          {children()}
        </div>
      )}
    </section>
  );
}

export interface SectionListProps {
  /** The bar's words: "3 steps · 5 attempts · 248 KB". Without `onExpandAll` there is no bar. */
  readonly facts?: string | undefined;
  /** Every line shown is open (Expand all does nothing). */
  readonly allOpen?: boolean;
  /** Every line shown is closed (Collapse all does nothing). */
  readonly noneOpen?: boolean;
  readonly onExpandAll?: (() => void) | undefined;
  readonly onCollapseAll?: (() => void) | undefined;
  readonly className?: string | undefined;
  readonly children: ReactNode;
}

const TEXT = { expand: "Expand all", collapse: "Collapse all" } as const;

export function SectionList({ facts, allOpen = false, noneOpen = false, onExpandAll, onCollapseAll, className, children }: SectionListProps) {
  return (
    <div className={["sec-wrap", className].filter(Boolean).join(" ")}>
      {onExpandAll !== undefined && onCollapseAll !== undefined && (
        <div className="sec-bar">
          <span>{facts}</span>
          <span className="sec-bar-actions">
            <Button size="sm" disabled={allOpen} onClick={onExpandAll}>
              {TEXT.expand}
            </Button>
            <Button size="sm" disabled={noneOpen} onClick={onCollapseAll}>
              {TEXT.collapse}
            </Button>
          </span>
        </div>
      )}
      <div className="sec-list">{children}</div>
    </div>
  );
}

// What was opened stays open while the app runs, per item and tab: the keys of the open sections,
// kept here and not in the screen, so switching a tab or an item and coming back finds them. Not
// written to disk. A scope nobody has touched shows the defaults the screen computes from its data.
const memory = new Map<string, ReadonlySet<string>>();

/** Forgets every remembered section (for tests). */
export const resetOpenSections = (): void => memory.clear();

export interface OpenSections {
  readonly open: ReadonlySet<string>;
  /** Changes a copy of the open keys; the first change of a scope starts from the defaults. */
  readonly update: (change: (keys: Set<string>) => void) => void;
}

export function useOpenSections(scope: string, defaults: readonly string[]): OpenSections {
  const [, render] = useReducer((count: number) => count + 1, 0);
  const open = memory.get(scope) ?? new Set(defaults);
  return {
    open,
    update: (change) => {
      const next = new Set(memory.get(scope) ?? defaults);
      change(next);
      memory.set(scope, next);
      render();
    },
  };
}
