import { describe, expect, it } from "vitest";
import { ago, sampleItems } from "./data.js";

const startOfDay = (now: number): number => new Date(now).setHours(0, 0, 0, 0);

describe("sample item times", () => {
  it("are minutes before now in the middle of the day", () => {
    const now = new Date(2026, 10, 25, 14, 0, 0).getTime();
    expect(ago(now, 30)).toBe(now - 30 * 60_000);
    expect(ago(now, 180)).toBe(now - 180 * 60_000);
  });

  // Just after midnight a plain "180 minutes ago" falls into yesterday, and the app's default
  // range (today) would hide the finished sample items.
  it.each([[0, 0, 0], [0, 1, 0], [0, 58, 0], [1, 30, 0], [2, 59, 59], [3, 0, 0]])("stay within today at %i:%i:%i", (hour, minute, second) => {
    const now = new Date(2026, 10, 25, hour, minute, second).getTime();
    const times = sampleItems(now).map((item) => item.createdAt);
    for (const time of times) {
      expect(time).toBeGreaterThanOrEqual(startOfDay(now));
      expect(time).toBeLessThanOrEqual(now);
    }
  });

  it("keep their order close to midnight", () => {
    const now = new Date(2026, 10, 25, 0, 58, 0).getTime();
    expect(ago(now, 6)).toBeGreaterThan(ago(now, 41));
    expect(ago(now, 41)).toBeGreaterThan(ago(now, 180));
  });
});
