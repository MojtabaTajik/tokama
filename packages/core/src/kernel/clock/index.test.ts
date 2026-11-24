import { describe, expect, it } from "vitest";
import { manualClock, systemClock } from "./index.js";

describe("clock", () => {
  it("systemClock reads real time", () => {
    const before = Date.now();
    const now = systemClock.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it("manualClock moves only when advanced", () => {
    const clock = manualClock(1_000);
    expect(clock.now()).toBe(1_000);
    clock.advance(250);
    expect(clock.now()).toBe(1_250);
  });

  it("manualClock refuses to go backwards", () => {
    const clock = manualClock();
    expect(() => clock.advance(-1)).toThrow(RangeError);
    expect(() => clock.advance(Number.NaN)).toThrow(RangeError);
    expect(clock.now()).toBe(0);
  });
});
