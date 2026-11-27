// Plan windows in time: how long a window is, when it started, where it ends up at the pace so
// far, and which past weekly windows a set of readings shows as over. Everything comes from the
// reset time the CLI reports and the window's name; a window whose length is unknown has no start,
// no forecast and no history. Never local midnight: a window is what the CLI says it is.
import type { PlanWindow } from "../../kernel/schemas/index.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The share of a window that must have passed before its pace says anything. */
export const FORECAST_AFTER = 0.05;
/** Two reset times this close are the same window: a CLI's reset time is not exact to the second. */
const SAME_WINDOW_MS = 5 * 60_000;
/** The past weekly windows kept per AI CLI. */
export const MAX_PAST_WINDOWS = 14;

/** The length of a window by the CLI's name for it; undefined for a name this build does not know. */
export function windowLength(name: string): number | undefined {
  if (name === "session" || name === "five_hour") return 5 * HOUR;
  if (name.startsWith("seven_day") || name.startsWith("weekly_")) return 7 * DAY;
  return undefined;
}

/** The AI CLI's whole weekly window, not one scoped to a model. */
export function isWeekly(window: Pick<PlanWindow, "window" | "scope">): boolean {
  return window.scope === undefined && (window.window === "weekly_all" || window.window === "seven_day");
}

/** When the window started; undefined without a reset time or a known length. */
export function windowStart(window: Pick<PlanWindow, "window" | "resetsAt">): number | undefined {
  const length = windowLength(window.window);
  return window.resetsAt === undefined || length === undefined ? undefined : window.resetsAt - length;
}

/**
 * Where the window ends up if the pace since its start holds, read at `asOf`: the use at the reset
 * time, and when the limit runs out if that is before the reset. Undefined until 5% of the window
 * has passed, while nothing is used, and once the limit is reached.
 */
export function forecastOf(window: Pick<PlanWindow, "window" | "usedPercent" | "resetsAt">, asOf: number): NonNullable<PlanWindow["forecast"]> | undefined {
  const startsAt = windowStart(window);
  const length = windowLength(window.window);
  if (startsAt === undefined || length === undefined || window.resetsAt === undefined) return undefined;
  const used = window.usedPercent;
  const elapsed = asOf - startsAt;
  if (used <= 0 || used >= 100 || elapsed < length * FORECAST_AFTER || elapsed > length) return undefined;
  const runsOutAt = Math.round(startsAt + (elapsed * 100) / used);
  return {
    atResetPercent: Math.min(100_000, Math.round(((used * length) / elapsed) * 100) / 100),
    ...(runsOutAt < window.resetsAt && { runsOutAt }),
  };
}

/** The window with its start and forecast, when they are known. */
export function withForecast(window: PlanWindow, asOf: number): PlanWindow {
  const startsAt = windowStart(window);
  if (startsAt === undefined) return window;
  const forecast = forecastOf(window, asOf);
  return { ...window, startsAt, ...(forecast !== undefined && { forecast }) };
}

/** A weekly window that is over, with what was known when it closed. */
export interface PastWindow {
  readonly window: string;
  readonly startsAt: number;
  readonly endsAt: number;
  /** The last reading's use of the limit. */
  readonly usedPercent: number;
  /**
   * What the window's usage weighed, in the price table's dollars, fixed when it closed because the
   * AI CLI deletes old logs: Tokama's calls and everything on the machine. Absent when no split
   * could be told then.
   */
  readonly weight?: { readonly tokama: number; readonly all: number };
  /** The price table the weight used. */
  readonly pricesAsOf?: string;
}

/** What one reading of a CLI's windows showed, and when it was made. */
export interface WindowReading {
  readonly at: number;
  readonly windows: readonly Pick<PlanWindow, "window" | "usedPercent" | "resetsAt" | "scope">[];
}

const sameWindow = (a: number, b: number): boolean => Math.abs(a - b) < SAME_WINDOW_MS;

/**
 * The weekly windows the readings show as over (a later reset time was read) that `known` does not
 * hold yet, without their weight. A window's use is its newest reading's.
 */
export function closedWindows(readings: readonly WindowReading[], known: readonly PastWindow[]): PastWindow[] {
  const seen = readings
    .flatMap((reading) => reading.windows.filter((w) => isWeekly(w) && w.resetsAt !== undefined).map((w) => ({ name: w.window, endsAt: w.resetsAt!, usedPercent: w.usedPercent, at: reading.at })))
    .sort((a, b) => a.endsAt - b.endsAt);
  const groups: (typeof seen)[] = [];
  for (const one of seen) {
    const last = groups.at(-1);
    if (last !== undefined && sameWindow(last[0]!.endsAt, one.endsAt)) last.push(one);
    else groups.push([one]);
  }
  const closed: PastWindow[] = [];
  // The newest group may still be running: it is closed only when a later one exists.
  for (const group of groups.slice(0, -1)) {
    const newest = group.reduce((a, b) => (b.at > a.at ? b : a));
    const startsAt = windowStart({ window: newest.name, resetsAt: newest.endsAt });
    if (startsAt === undefined || known.some((past) => sameWindow(past.endsAt, newest.endsAt))) continue;
    closed.push({ window: newest.name, startsAt, endsAt: newest.endsAt, usedPercent: newest.usedPercent });
  }
  return closed;
}

/** The newest past windows, oldest first, at most 14. */
export function keepPast(windows: readonly PastWindow[]): PastWindow[] {
  return [...windows].sort((a, b) => a.endsAt - b.endsAt).slice(-MAX_PAST_WINDOWS);
}

/** Reads a stored list of past windows; anything that is not one is left out, so a damaged record gives none. */
export function readPast(value: unknown): PastWindow[] {
  if (!Array.isArray(value)) return [];
  const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  // The report holds times as whole milliseconds, so a stored time that is not one is left out.
  const epoch = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  const past: PastWindow[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.window !== "string" || e.window === "" || !epoch(e.startsAt) || !epoch(e.endsAt) || !finite(e.usedPercent) || e.endsAt <= e.startsAt) continue;
    const w = e.weight as Record<string, unknown> | undefined;
    const weight = typeof w === "object" && w !== null && finite(w.tokama) && finite(w.all) && w.tokama >= 0 && w.tokama <= w.all && w.all > 0 && w.all < 1e9 ? { tokama: w.tokama, all: w.all } : undefined;
    past.push({
      window: e.window.slice(0, 64),
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      usedPercent: Math.min(1000, Math.max(0, e.usedPercent)),
      ...(weight !== undefined && { weight }),
      ...(weight !== undefined && typeof e.pricesAsOf === "string" && { pricesAsOf: e.pricesAsOf.slice(0, 10) }),
    });
  }
  return keepPast(past);
}
