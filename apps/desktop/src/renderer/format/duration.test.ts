import { describe, expect, it } from "vitest";
import { formatDuration } from "./duration.js";

describe("formatDuration", () => {
  it.each([
    [0, "0 s"],
    [45_900, "45 s"],
    [59_999, "59 s"],
    [60_000, "1 m 00 s"],
    [252_000, "4 m 12 s"],
    [3_599_000, "59 m 59 s"],
    [3_900_000, "1 h 05 m"],
    [-5_000, "0 s"],
  ])("writes %i ms as %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });

  it("leaves the seconds out of a coarse duration from one minute on", () => {
    expect(formatDuration(45_000, "coarse")).toBe("45 s");
    expect(formatDuration(732_000, "coarse")).toBe("12 m");
    expect(formatDuration(3_900_000, "coarse")).toBe("1 h 05 m");
  });
});
