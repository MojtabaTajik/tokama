import { describe, expect, it } from "vitest";
import { DEFAULT_DESKTOP_STATE, type DesktopState } from "../shared/desktop-state.js";
import { AWAY_MS, createAway } from "./away.js";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 10, 27, 12, 0, 0);

/** A store in memory and a clock the test moves; `saved` is what desktop.json held before the app started. */
function setup(saved?: DesktopState["away"]) {
  let state: DesktopState = { ...DEFAULT_DESKTOP_STATE, ...(saved === undefined ? {} : { away: saved }) };
  let time = T0;
  const told: unknown[] = [];
  const away = createAway({
    store: { get: () => state, update: (change) => void (state = change(state)) },
    now: () => time,
    onChange: (info) => told.push(info),
  });
  return { away, told, saved: () => state.away, wait: (ms: number) => void (time += ms) };
}

describe("away", () => {
  it("the first start has nothing to report: seen up to now", () => {
    const { away, saved } = setup();
    away.start();
    expect(saved()).toEqual({ seenUntil: T0, due: false });
    expect(away.info()).toEqual({ seenUntil: T0, due: false });
  });

  it("14 minutes 59 seconds away is not away; 15 minutes is", () => {
    const short = setup({ seenUntil: T0 - 5 * MINUTE, due: false });
    short.away.start();
    short.away.left();
    short.wait(AWAY_MS - 1000);
    short.away.back();
    expect(short.away.info().due).toBe(false);

    const long = setup({ seenUntil: T0 - 5 * MINUTE, due: false });
    long.away.start();
    long.away.left();
    long.wait(AWAY_MS);
    long.away.back();
    expect(long.away.info()).toEqual({ seenUntil: T0, due: true, backAt: T0 + AWAY_MS });
    expect(long.told).toEqual([{ seenUntil: T0, due: false }, { seenUntil: T0, due: true, backAt: T0 + AWAY_MS }]);
  });

  it("leaving makes what came before seen, when nothing is due", () => {
    const { away, saved, wait } = setup({ seenUntil: T0 - 5 * MINUTE, due: false });
    away.start();
    wait(10 * MINUTE);
    away.left();
    expect(saved()).toEqual({ seenUntil: T0 + 10 * MINUTE, leftAt: T0 + 10 * MINUTE, due: false });
  });

  it("a lock or a sleep with the window in front counts the same as a blur: the caller reports it as left", () => {
    const { away, wait } = setup({ seenUntil: T0, due: false });
    away.start();
    away.left();
    wait(40 * MINUTE);
    away.back();
    expect(away.info()).toMatchObject({ due: true, backAt: T0 + 40 * MINUTE });
  });

  it("a lock after a blur keeps the earlier time", () => {
    const { away, saved, wait } = setup({ seenUntil: T0, due: false });
    away.start();
    away.left();
    wait(10 * MINUTE);
    away.left();
    expect(saved()?.leftAt).toBe(T0);
    wait(6 * MINUTE);
    away.back();
    expect(away.info().due).toBe(true);
  });

  it("a window that gets the front with no earlier leave is not away, however long the app has run", () => {
    const { away, wait, told } = setup({ seenUntil: T0, due: false });
    away.start();
    wait(60 * MINUTE);
    away.back();
    expect(away.info().due).toBe(false);
    expect(told).toEqual([]);
  });

  it("a return clears the leave, so a focus long after it is not away", () => {
    const { away, saved, wait } = setup({ seenUntil: T0, due: false });
    away.start();
    away.left();
    wait(5 * MINUTE);
    away.back();
    expect(saved()?.leftAt).toBeUndefined();
    wait(60 * MINUTE);
    away.back();
    expect(away.info().due).toBe(false);
  });

  it("a restart after 2 minutes shows nothing, and after 20 minutes it does", () => {
    const soon = setup({ seenUntil: T0 - 30 * MINUTE, leftAt: T0 - 2 * MINUTE, due: false });
    soon.away.start();
    expect(soon.away.info()).toEqual({ seenUntil: T0 - 30 * MINUTE, due: false });
    expect(soon.saved()?.leftAt).toBeUndefined();

    const late = setup({ seenUntil: T0 - 30 * MINUTE, leftAt: T0 - 20 * MINUTE, due: false });
    late.away.start();
    expect(late.away.info()).toEqual({ seenUntil: T0 - 30 * MINUTE, due: true, backAt: T0 });
  });

  it("after a crash (no leftAt) the time since seenUntil stands in", () => {
    const recent = setup({ seenUntil: T0 - 3 * MINUTE, due: false });
    recent.away.start();
    expect(recent.away.info().due).toBe(false);
    const old = setup({ seenUntil: T0 - 3 * 60 * MINUTE, due: false });
    old.away.start();
    expect(old.away.info()).toMatchObject({ due: true, backAt: T0 });
  });

  it("a strip not yet dismissed is still due after a restart", () => {
    const { away } = setup({ seenUntil: T0 - 90 * MINUTE, leftAt: T0 - MINUTE, due: true, backAt: T0 - 5 * MINUTE });
    away.start();
    expect(away.info()).toEqual({ seenUntil: T0 - 90 * MINUTE, due: true, backAt: T0 - 5 * MINUTE });
  });

  it("Got it sees everything up to now and ends the strip until the next time away", () => {
    const { away, saved, wait } = setup({ seenUntil: T0 - 90 * MINUTE, due: true, backAt: T0 - MINUTE });
    away.start();
    wait(MINUTE);
    away.close();
    expect(saved()).toEqual({ seenUntil: T0 + MINUTE, due: false });
    wait(5 * MINUTE);
    away.left();
    wait(5 * MINUTE);
    away.back();
    expect(away.info().due).toBe(false);
  });

  it("a blur while the strip is due keeps seenUntil and the first return time, so the time away does not grow", () => {
    const { away, saved, wait } = setup({ seenUntil: T0 - 90 * MINUTE, due: true, backAt: T0 });
    away.start();
    wait(MINUTE);
    away.left();
    wait(MINUTE);
    away.back();
    expect(saved()).toEqual({ seenUntil: T0 - 90 * MINUTE, due: true, backAt: T0 });
  });

  it("quitting counts as leaving, so the next start measures from it", () => {
    const { away, saved } = setup({ seenUntil: T0, due: false });
    away.start();
    away.left();
    expect(saved()).toEqual({ seenUntil: T0, leftAt: T0, due: false });
  });
});
