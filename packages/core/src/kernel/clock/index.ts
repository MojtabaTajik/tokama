// Injectable clock, so guard and timeout code is testable without real time (architecture.md, section 11).
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface ManualClock extends Clock {
  advance(ms: number): void;
}

/** A clock that moves only when told to. For tests. */
export function manualClock(startMs = 0): ManualClock {
  let current = startMs;
  return {
    now: () => current,
    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`advance needs a finite, non-negative duration, got ${String(ms)}`);
      current += ms;
    },
  };
}
