import { describe, expect, it } from "vitest";
import { ago, formatDuration } from "./duration.js";

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

describe("long and short durations", () => {
  it("counts days and hours from one day on", () => {
    expect(formatDuration(86_400_000)).toBe("1 d 00 h");
    expect(formatDuration(2 * 86_400_000 + 3 * 3_600_000 + 59_000, "coarse")).toBe("2 d 03 h");
  });

  it("keeps a tenth of a second under ten seconds when fine", () => {
    expect(formatDuration(4_240, "fine")).toBe("4.2 s");
    expect(formatDuration(0, "fine")).toBe("0.0 s");
    expect(formatDuration(14_400, "fine")).toBe("14 s");
    expect(formatDuration(112_000, "fine")).toBe("1 m 52 s");
  });

  it("says how long ago", () => {
    expect(ago(732_000)).toBe("12 m ago");
    expect(ago(30_000)).toBe("30 s ago");
  });
});
