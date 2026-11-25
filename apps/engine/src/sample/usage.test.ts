import { describe, expect, it } from "vitest";
import { localDate, parseQueryResult, summarizeUsage } from "@tokama/core";
import { sampleSetup } from "./data.js";
import { sampleUsageRows } from "./usage.js";

const setup = (() => {
  const parsed = parseQueryResult("setup", sampleSetup);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error.issues));
  return parsed.value;
})();

describe("sample usage", () => {
  it.each([
    ["just after midnight", new Date(2025, 9, 20, 0, 0, 30)],
    ["early in the morning", new Date(2025, 9, 20, 4, 40)],
    ["in the afternoon", new Date(2025, 9, 20, 15, 0)],
  ])("has calls today %s, none after now, and the same calls on every start", (_label, date) => {
    const now = date.getTime();
    const rows = sampleUsageRows(setup, [], now);
    expect(rows.every((row) => row.call.endedAt <= now && row.call.startedAt <= row.call.endedAt)).toBe(true);
    expect(rows.some((row) => localDate(row.call.endedAt) === localDate(now))).toBe(true);
    expect(sampleUsageRows(setup, [], now)).toEqual(rows);
    expect(summarizeUsage({ rows, range: 14, now, clis: [] }).days.at(-1)?.workflows.length).toBeGreaterThan(0);
  });
});
