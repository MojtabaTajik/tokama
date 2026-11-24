// Injectable clock: time and timers, so guard and timeout code is testable without real time
//. The one clock of the kernel; other modules take a Clock.
declare const timerBrand: unique symbol;
/** Opaque handle returned by `setTimeout`. */
export type TimerHandle = { readonly [timerBrand]: true };

export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms) as unknown as TimerHandle,
  clearTimeout: (handle) => globalThis.clearTimeout(handle as unknown as ReturnType<typeof globalThis.setTimeout>),
};

export interface ManualClock extends Clock {
  /** Moves time forward and fires each timer that falls due, in due order, at its due time. */
  advance(ms: number): void;
}

interface ManualTimer {
  readonly due: number;
  readonly seq: number;
  readonly callback: () => void;
}

/** A clock that moves only when told to. For tests. */
export function manualClock(startMs = 0): ManualClock {
  let current = startMs;
  let seq = 0;
  const timers = new Map<TimerHandle, ManualTimer>();

  const nextDue = (until: number): [TimerHandle, ManualTimer] | undefined => {
    let next: [TimerHandle, ManualTimer] | undefined;
    for (const entry of timers) {
      const timer = entry[1];
      if (timer.due > until) continue;
      if (next === undefined || timer.due < next[1].due || (timer.due === next[1].due && timer.seq < next[1].seq)) next = entry;
    }
    return next;
  };

  return {
    now: () => current,
    setTimeout(callback, ms) {
      const handle = {} as TimerHandle;
      // Like the platform timers: a negative or non-finite delay runs as soon as possible.
      const delay = Number.isFinite(ms) && ms > 0 ? ms : 0;
      timers.set(handle, { due: current + delay, seq: seq++, callback });
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle);
    },
    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`advance needs a finite, non-negative duration, got ${String(ms)}`);
      const target = current + ms;
      // Timers set by a callback fire in the same advance when they fall due before the target.
      for (let entry = nextDue(target); entry !== undefined; entry = nextDue(target)) {
        timers.delete(entry[0]);
        current = entry[1].due;
        entry[1].callback();
      }
      current = target;
    },
  };
}
