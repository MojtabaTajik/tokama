import { describe, expect, it, vi } from "vitest";
import { CHECK_EVERY_MS, FIRST_CHECK_MS, startSchedule, type Timers } from "./schedule.js";

/** Timers on a clock the test moves. */
function fakeTimers() {
  let now = 0;
  const timers: { at: number; every?: number; fn: () => void; live: boolean }[] = [];
  const api: Timers = {
    after: (ms, fn) => {
      const timer = { at: now + ms, fn, live: true };
      timers.push(timer);
      return () => void (timer.live = false);
    },
    every: (ms, fn) => {
      const timer = { at: now + ms, every: ms, fn, live: true };
      timers.push(timer);
      return () => void (timer.live = false);
    },
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((timer) => timer.live && timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (due === undefined) break;
      now = due.at;
      if (due.every === undefined) due.live = false;
      else due.at += due.every;
      due.fn();
    }
    now = end;
  };
  return { api, advance };
}

describe("startSchedule", () => {
  it("checks once after the first delay, then every six hours", () => {
    const { api, advance } = fakeTimers();
    const check = vi.fn(async () => undefined);
    startSchedule(check, api);
    advance(FIRST_CHECK_MS - 1);
    expect(check).not.toHaveBeenCalled();
    advance(1);
    expect(check).toHaveBeenCalledTimes(1);
    advance(CHECK_EVERY_MS);
    expect(check).toHaveBeenCalledTimes(2);
    advance(CHECK_EVERY_MS);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("stops every timer", () => {
    const { api, advance } = fakeTimers();
    const check = vi.fn(async () => undefined);
    const stop = startSchedule(check, api);
    stop();
    advance(CHECK_EVERY_MS * 3);
    expect(check).not.toHaveBeenCalled();
  });

  it("survives a check that fails", () => {
    const { api, advance } = fakeTimers();
    const check = vi.fn(async () => {
      throw new Error("no");
    });
    startSchedule(check, api);
    advance(FIRST_CHECK_MS + CHECK_EVERY_MS);
    expect(check).toHaveBeenCalledTimes(2);
  });
});
