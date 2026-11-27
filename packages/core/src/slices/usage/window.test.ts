import { describe, expect, it } from "vitest";
import { closedWindows, forecastOf, readPast, windowLength, windowStart, withForecast, type PastWindow } from "./window.js";
import { DAY, HOUR } from "./testing/items.js";

const T0 = 1_760_000_000_000;
const week = (usedPercent: number, resetsAt = T0 + 7 * DAY) => ({ window: "weekly_all", usedPercent, resetsAt });

describe("window length and start", () => {
  it("knows the sessions and the weekly windows by name, and nothing else", () => {
    expect(windowLength("session")).toBe(5 * HOUR);
    expect(windowLength("five_hour")).toBe(5 * HOUR);
    for (const name of ["weekly_all", "weekly_scoped", "seven_day", "seven_day_opus"]) expect(windowLength(name)).toBe(7 * DAY);
    expect(windowLength("monthly_extra")).toBeUndefined();
  });

  it("starts a window one length before its reset time, and has no start without either", () => {
    expect(windowStart(week(10))).toBe(T0);
    expect(windowStart({ window: "session", resetsAt: T0 + 5 * HOUR })).toBe(T0);
    expect(windowStart({ window: "weekly_all" })).toBeUndefined();
    expect(windowStart({ window: "odd_one", resetsAt: T0 })).toBeUndefined();
  });
});

describe("forecast", () => {
  it("is on pace: the use at the reset, and no run-out time", () => {
    expect(forecastOf(week(40), T0 + 3.5 * DAY)).toEqual({ atResetPercent: 80 });
  });

  it("runs out before the reset at 70% after half the window", () => {
    expect(forecastOf(week(70), T0 + 3.5 * DAY)).toEqual({ atResetPercent: 140, runsOutAt: T0 + 5 * DAY });
  });

  it("runs out exactly at the reset is not before it, so no run-out time", () => {
    expect(forecastOf(week(50), T0 + 3.5 * DAY)).toEqual({ atResetPercent: 100 });
  });

  it("says nothing at the limit or over it, at 0%, or before 5% of the window has passed", () => {
    expect(forecastOf(week(100), T0 + 3 * DAY)).toBeUndefined();
    expect(forecastOf(week(105), T0 + 3 * DAY)).toBeUndefined();
    expect(forecastOf(week(0), T0 + 3 * DAY)).toBeUndefined();
    // 5% of a week is 8.4 hours.
    expect(forecastOf(week(5), T0 + 8 * HOUR)).toBeUndefined();
    expect(forecastOf(week(5), T0 + 9 * HOUR)).toMatchObject({ atResetPercent: expect.any(Number) });
  });

  it("says nothing for a window of unknown length or without a reset time", () => {
    expect(forecastOf({ window: "monthly_extra", usedPercent: 30, resetsAt: T0 + DAY }, T0)).toBeUndefined();
    expect(forecastOf({ window: "weekly_all", usedPercent: 30 }, T0 + DAY)).toBeUndefined();
  });

  it("goes into the window with its start; a window of unknown length stays as it was", () => {
    expect(withForecast(week(70), T0 + 3.5 * DAY)).toEqual({ ...week(70), startsAt: T0, forecast: { atResetPercent: 140, runsOutAt: T0 + 5 * DAY } });
    const odd = { window: "monthly_extra", usedPercent: 30, resetsAt: T0 + DAY };
    expect(withForecast(odd, T0)).toEqual(odd);
  });
});

describe("closed windows", () => {
  const reading = (at: number, usedPercent: number, resetsAt: number) => ({ at, windows: [week(usedPercent, resetsAt), { window: "session", usedPercent: 3, resetsAt: resetsAt - 6 * DAY }] });
  const NEXT = T0 + 7 * DAY;

  it("closes a weekly window the first time a reading shows a later reset, with the newest use it had", () => {
    const readings = [reading(T0 + 2 * DAY, 30, T0 + 7 * DAY), reading(T0 + 6 * DAY, 64, T0 + 7 * DAY + 1000), reading(T0 + 8 * DAY, 5, NEXT + 7 * DAY)];
    expect(closedWindows(readings, [])).toEqual([{ window: "weekly_all", startsAt: T0 + 1000, endsAt: T0 + 7 * DAY + 1000, usedPercent: 64 }]);
  });

  it("does not close the newest window, whatever its reset time", () => {
    expect(closedWindows([reading(T0 + DAY, 30, NEXT)], [])).toEqual([]);
  });

  it("does not close a window twice", () => {
    const readings = [reading(T0 + 6 * DAY, 64, T0 + 7 * DAY), reading(T0 + 8 * DAY, 5, NEXT + 7 * DAY)];
    const known: PastWindow[] = [{ window: "weekly_all", startsAt: T0, endsAt: T0 + 7 * DAY + 1000, usedPercent: 64 }];
    expect(closedWindows(readings, known)).toEqual([]);
  });

  it("ignores scoped and session windows", () => {
    const scoped = { at: T0, windows: [{ window: "weekly_scoped", scope: "Fable", usedPercent: 20, resetsAt: NEXT }] };
    const later = { at: T0 + 8 * DAY, windows: [{ window: "weekly_scoped", scope: "Fable", usedPercent: 5, resetsAt: NEXT + 7 * DAY }] };
    expect(closedWindows([scoped, later], [])).toEqual([]);
  });
});

describe("a stored list of past windows", () => {
  const past = { window: "weekly_all", startsAt: T0, endsAt: T0 + 7 * DAY, usedPercent: 64, weight: { tokama: 3, all: 4 }, pricesAsOf: "2025-10-01" };

  it("reads back what was stored, oldest first, at most 14", () => {
    const stored = Array.from({ length: 20 }, (_, n) => ({ ...past, startsAt: T0 + n * 7 * DAY, endsAt: T0 + (n + 1) * 7 * DAY }));
    const read = readPast([...stored].reverse());
    expect(read).toHaveLength(14);
    expect(read[0]?.startsAt).toBe(T0 + 6 * 7 * DAY);
    expect(read.at(-1)?.endsAt).toBe(T0 + 20 * 7 * DAY);
    expect(readPast([past])).toEqual([past]);
  });

  it("reads a damaged record as no history, never throws, and drops only the entries that are wrong", () => {
    for (const value of [undefined, null, 5, "x", {}, [null], [5], [{}], [{ window: "w", startsAt: "a", endsAt: 1, usedPercent: 1 }], [{ ...past, endsAt: T0 }], [{ ...past, startsAt: T0 + 0.5 }], [{ ...past, window: "" }], [{ ...past, usedPercent: Number.NaN }]]) expect(readPast(value)).toEqual([]);
    expect(readPast([null, past, { ...past, weight: { tokama: "x", all: 1 } }])).toEqual([past, { window: "weekly_all", startsAt: T0, endsAt: T0 + 7 * DAY, usedPercent: 64 }]);
  });
});
