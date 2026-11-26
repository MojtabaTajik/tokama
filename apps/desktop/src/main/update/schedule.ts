// When the app checks for updates by itself: once shortly after start, once the window has
// loaded, then every few hours. Timers are passed in, so a test controls time.

export interface Timers {
  /** Calls `fn` once after `ms`; returns a function that cancels it. */
  after(ms: number, fn: () => void): () => void;
  /** Calls `fn` every `ms`; returns a function that stops it. */
  every(ms: number, fn: () => void): () => void;
}

export const FIRST_CHECK_MS = 30_000;
export const CHECK_EVERY_MS = 6 * 60 * 60_000;

/** Timers that never keep the process alive. */
export const realTimers: Timers = {
  after: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return () => clearTimeout(timer);
  },
  every: (ms, fn) => {
    const timer = setInterval(fn, ms);
    timer.unref();
    return () => clearInterval(timer);
  },
};

/** Starts the schedule; returns the function that stops it. `check` itself never runs two checks at once. */
export function startSchedule(check: () => Promise<void>, timers: Timers = realTimers): () => void {
  const run = () => void check().catch(() => undefined);
  const stopFirst = timers.after(FIRST_CHECK_MS, run);
  const stopEvery = timers.every(CHECK_EVERY_MS, run);
  return () => {
    stopFirst();
    stopEvery();
  };
}
