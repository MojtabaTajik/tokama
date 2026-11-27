// Every status the app shows, as one table of symbol, word and tone, so a state reads the same on
// every screen and colour is never its only signal. Screens map their own states onto these
// (a step's `passed`, an item's `done`) and render them with StatusMark.

/** A status colour: working now, passed, needs attention, failed, or nothing to act on. */
export type Tone = "live" | "pass" | "warn" | "fail" | "muted";

export interface Mark {
  readonly symbol: string;
  readonly word: string;
  readonly tone: Tone;
}

const MARKS = {
  queued: { symbol: "◌", word: "queued", tone: "muted" },
  pending: { symbol: "○", word: "pending", tone: "muted" },
  waiting: { symbol: "○", word: "waiting", tone: "muted" },
  next: { symbol: "○", word: "next", tone: "muted" },
  running: { symbol: "●", word: "running", tone: "live" },
  checking: { symbol: "◐", word: "checking", tone: "live" },
  needs_you: { symbol: "⏸", word: "needs you", tone: "warn" },
  passed: { symbol: "✓", word: "passed", tone: "pass" },
  done: { symbol: "✓", word: "done", tone: "pass" },
  failed: { symbol: "✕", word: "failed", tone: "fail" },
  run_failed: { symbol: "!", word: "run failed", tone: "warn" },
  warning: { symbol: "!", word: "warning", tone: "warn" },
  stopped: { symbol: "■", word: "stopped", tone: "muted" },
  discarded: { symbol: "⊘", word: "discarded", tone: "muted" },
  pull_request: { symbol: "↗", word: "pull request", tone: "pass" },
  ready: { symbol: "●", word: "ready", tone: "pass" },
  logged_out: { symbol: "○", word: "logged out", tone: "warn" },
  no_answer: { symbol: "…", word: "no answer", tone: "warn" },
  unknown: { symbol: "–", word: "unknown", tone: "muted" },
} as const satisfies Record<string, Mark>;

export type Status = keyof typeof MARKS;

/** The mark of a status, with its own word when the screen says it differently ("merged", "1 problem"). */
export function markOf(status: Status, word?: string): Mark {
  const base: Mark = MARKS[status];
  return word === undefined ? base : { ...base, word };
}

export interface StatusMarkProps {
  /** A status from the table, or a mark already looked up. */
  readonly status: Status | Mark;
  readonly className?: string | undefined;
  /**
   * Where the word goes: "hidden" (visible text next to the mark says it), "spoken" (to screen
   * readers only) or "visible" (printed after the symbol, in the tone's colour).
   */
  readonly word?: "hidden" | "spoken" | "visible";
  /** Print only the word, with no symbol: for a state that has a mark of its own elsewhere or none (running, pending, next). */
  readonly markless?: boolean;
}

/** The symbol in its tone colour, hidden from screen readers; the word as `word` says. */
export function StatusMark({ status, className, word: wordShown = "hidden", markless = false }: StatusMarkProps) {
  const { symbol, word, tone } = typeof status === "string" ? MARKS[status] : status;
  const classes = ["mark", className].filter(Boolean).join(" ");
  if (markless) {
    return (
      <span className={["mark-word", className].filter(Boolean).join(" ")} data-tone={tone}>
        {word}
      </span>
    );
  }
  return (
    <>
      <span className={classes} data-tone={tone} aria-hidden="true">
        {symbol}
      </span>
      {wordShown === "spoken" && <span className="visually-hidden">{word}</span>}
      {wordShown === "visible" && (
        <>
          {" "}
          <span className="mark-word" data-tone={tone}>
            {word}
          </span>
        </>
      )}
    </>
  );
}
