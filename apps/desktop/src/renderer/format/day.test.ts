import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dayLabel, daysBefore, localDay } from "./day.js";

// A zone with DST, so the tests mean the same on a UTC CI runner. Berlin moved its clocks back
// at 03:00 on 25 Oct 2026 and forward at 02:00 on 29 Mar 2026.
let zone: string | undefined;
beforeAll(() => {
  zone = process.env["TZ"];
  process.env["TZ"] = "Europe/Berlin";
});
afterAll(() => {
  if (zone === undefined) delete process.env["TZ"];
  else process.env["TZ"] = zone;
});

const local = (month: number, day: number, hour: number, minute = 0) => new Date(2026, month - 1, day, hour, minute).getTime();

describe("day keys and labels", () => {
  it("splits at local midnight, not UTC", () => {
    expect(localDay(local(11, 24, 23, 59))).toBe("2026-11-24");
    expect(localDay(local(11, 25, 0, 0))).toBe("2026-11-25");
    // 00:30 in Berlin is still the day before in UTC.
    expect(localDay(Date.UTC(2026, 10, 24, 23, 30))).toBe("2026-11-25");
  });

  it("labels today, yesterday, then the weekday and date", () => {
    const now = local(11, 24, 0, 5);
    expect(dayLabel("2026-11-24", now)).toBe("Today");
    expect(dayLabel("2026-11-23", now)).toBe("Yesterday");
    expect(dayLabel("2026-11-22", now)).toBe("Sun 22 Nov");
    // One minute before midnight, the same day is still today.
    expect(dayLabel("2026-11-23", local(11, 23, 23, 59))).toBe("Today");
  });

  it("counts calendar days across a DST change", () => {
    // The day after the clocks went back has 25 hours; 24 hours after its 00:30 is still that day.
    const after = local(10, 26, 0, 30);
    expect(daysBefore(after, 1)).toBe("2026-10-25");
    expect(dayLabel("2026-10-25", after)).toBe("Yesterday");
    expect(daysBefore(local(3, 30, 0, 30), 1)).toBe("2026-03-29");
    // 24 hours before 23:30 on the 25-hour day is still that day; the calendar says the 24th.
    expect(daysBefore(local(10, 25, 23, 30), 1)).toBe("2026-10-24");
    expect(daysBefore(local(11, 24, 12), 29)).toBe("2026-10-26");
  });
});
