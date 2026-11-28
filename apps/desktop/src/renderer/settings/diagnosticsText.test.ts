import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inDateRange } from "./diagnosticsText.js";

describe("inDateRange", () => {
  let zone: string | undefined;
  beforeEach(() => {
    zone = process.env["TZ"];
  });
  afterEach(() => {
    if (zone === undefined) delete process.env["TZ"];
    else process.env["TZ"] = zone;
  });

  // Each zone, with a day on which the clocks change inside the 7-day and 30-day windows.
  const CASES = [
    ["Europe/Amsterdam", "clocks go forward", new Date(2026, 2, 29, 12)],
    ["Europe/Amsterdam", "clocks go back", new Date(2026, 9, 25, 12)],
    ["America/Los_Angeles", "clocks go forward", new Date(2026, 2, 8, 12)],
    ["America/Los_Angeles", "clocks go back", new Date(2026, 10, 1, 12)],
    ["UTC", "no clock change", new Date(2026, 2, 29, 12)],
  ] as const;

  it.each(CASES)("in %s, %s: the window starts at local midnight of its first day, to the minute", (zoneName, _what, change) => {
    process.env["TZ"] = zoneName;
    const at = (daysAfter: number, hour: number, minute: number) => new Date(change.getFullYear(), change.getMonth(), change.getDate() + daysAfter, hour, minute).getTime();
    // Noon on the day of the change, just after midnight three days on, and just before midnight six days on.
    for (const now of [at(0, 12, 0), at(3, 0, 1), at(6, 23, 59)]) {
      const nowDay = new Date(now);
      const firstDay = (daysBack: number) => new Date(nowDay.getFullYear(), nowDay.getMonth(), nowDay.getDate() - daysBack);
      for (const [filter, daysBack] of [["7d", 6], ["30d", 29]] as const) {
        const first = firstDay(daysBack);
        const midnight = new Date(first.getFullYear(), first.getMonth(), first.getDate()).getTime();
        expect(inDateRange(midnight, filter, now), `${filter} at ${new Date(now).toISOString()}: its first midnight`).toBe(true);
        expect(inDateRange(midnight - 1, filter, now), `${filter} at ${new Date(now).toISOString()}: just before it`).toBe(false);
      }
      expect(inDateRange(new Date(nowDay.getFullYear(), nowDay.getMonth(), nowDay.getDate()).getTime(), "today", now)).toBe(true);
      expect(inDateRange(new Date(nowDay.getFullYear(), nowDay.getMonth(), nowDay.getDate()).getTime() - 1, "today", now)).toBe(false);
    }
  });
});
