import { describe, expect, it } from "vitest";
import { manualClock, sleep, systemClock, withDeadline } from "./index.js";

describe("clock", () => {
  it("systemClock reads real time", () => {
    const before = Date.now();
    const now = systemClock.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it("systemClock fires and clears real timers", async () => {
    const fired: string[] = [];
    const cleared = systemClock.setTimeout(() => fired.push("cleared"), 1);
    systemClock.clearTimeout(cleared);
    await new Promise<void>((resolve) => systemClock.setTimeout(() => resolve(), 5));
    expect(fired).toEqual([]);
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

  it("manualClock fires due timers in order, at their due time", () => {
    const clock = manualClock(100);
    const fired: [string, number][] = [];
    clock.setTimeout(() => fired.push(["b", clock.now()]), 50);
    clock.setTimeout(() => fired.push(["a", clock.now()]), 10);
    clock.setTimeout(() => fired.push(["c", clock.now()]), 50);
    clock.setTimeout(() => fired.push(["late", clock.now()]), 500);
    clock.advance(49);
    expect(fired).toEqual([["a", 110]]);
    clock.advance(1);
    expect(fired).toEqual([["a", 110], ["b", 150], ["c", 150]]);
    expect(clock.now()).toBe(150);
  });

  it("manualClock does not fire cleared timers", () => {
    const clock = manualClock();
    let fired = false;
    const handle = clock.setTimeout(() => (fired = true), 10);
    clock.clearTimeout(handle);
    clock.advance(100);
    expect(fired).toBe(false);
  });

  it("manualClock fires timers that callbacks set, when they fall due in the same advance", () => {
    const clock = manualClock();
    const fired: number[] = [];
    clock.setTimeout(() => {
      fired.push(clock.now());
      clock.setTimeout(() => fired.push(clock.now()), 5);
      clock.setTimeout(() => fired.push(clock.now()), 50);
    }, 10);
    clock.advance(20);
    expect(fired).toEqual([10, 15]);
    clock.advance(40);
    expect(fired).toEqual([10, 15, 60]);
  });

  it("manualClock runs zero, negative and NaN delays on the next advance", () => {
    const clock = manualClock();
    const fired: number[] = [];
    for (const delay of [0, -5, Number.NaN]) clock.setTimeout(() => fired.push(delay), delay);
    expect(fired).toEqual([]);
    clock.advance(0);
    expect(fired).toEqual([0, -5, Number.NaN]);
  });
});

describe("sleep", () => {
  it("resolves only once the clock reaches the time", async () => {
    const clock = manualClock();
    let done = false;
    const slept = sleep(clock, 100).then(() => (done = true));
    clock.advance(99);
    await Promise.resolve();
    expect(done).toBe(false);
    clock.advance(1);
    await slept;
    expect(done).toBe(true);
  });
});

describe("withDeadline", () => {
  it("resolves when the work settles, and clears its timer", async () => {
    const clock = manualClock();
    let finish = () => {};
    const work = new Promise<void>((resolve) => (finish = resolve));
    let done = false;
    const waited = withDeadline(clock, work, 1_000).then(() => (done = true));
    finish();
    await waited;
    expect(done).toBe(true);
  });

  it("resolves at the deadline when the work never settles", async () => {
    const clock = manualClock();
    let done = false;
    const waited = withDeadline(clock, new Promise(() => {}), 1_000).then(() => (done = true));
    clock.advance(999);
    await Promise.resolve();
    expect(done).toBe(false);
    clock.advance(1);
    await waited;
    expect(done).toBe(true);
  });

  it("does not reject when the work rejects", async () => {
    await expect(withDeadline(manualClock(), Promise.reject(new Error("boom")), 1_000)).resolves.toBeUndefined();
  });
});
