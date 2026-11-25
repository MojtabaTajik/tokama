import { describe, expect, it } from "vitest";
import { overlapMs } from "./timing.js";

describe("overlapMs", () => {
  it("counts overlapping spans once and only within the window", () => {
    expect(overlapMs([], 0, 100)).toBe(0);
    expect(overlapMs([[10, 20]], 0, 100)).toBe(10);
    expect(overlapMs([[10, 30], [20, 40]], 0, 100)).toBe(30);
    expect(overlapMs([[10, 30], [12, 15]], 0, 100)).toBe(20);
    expect(overlapMs([[-50, 10], [90, Infinity]], 0, 100)).toBe(20);
    expect(overlapMs([[40, 60], [0, 5]], 50, 100)).toBe(10);
  });
});
