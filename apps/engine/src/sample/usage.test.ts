import { describe, expect, it } from "vitest";
import { type ItemRecord, localDate, parseQueryResult, summarizeUsage } from "@tokama/core";
import { sampleSetup } from "./data.js";
import { sampleUsageItems, sampleUsageRows } from "./usage.js";

const setup = (() => {
  const parsed = parseQueryResult("setup", sampleSetup);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error.issues));
  return parsed.value;
})();

const NOW = new Date(2025, 9, 20, 15, 0).getTime();

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
    expect(summarizeUsage({ rows, now, clis: [] }).today?.itemCount).toBeGreaterThan(0);
  });

  describe("the items", () => {
    const items = sampleUsageItems(setup, [], NOW);

    it("have attempts for every call, attempts that end before now, and ids that are not used twice", () => {
      expect(new Set(items.map((item) => item.itemId)).size).toBe(items.length);
      for (const item of items) {
        const attempts = new Set(item.steps.flatMap((step) => step.attempts.map((a) => `${step.id}#${a.attempt}`)));
        expect(item.calls.every((call) => attempts.has(`${call.stepId}#${call.attempt}`))).toBe(true);
        expect(item.steps.flatMap((step) => step.attempts).every((a) => a.endedAt !== undefined && a.endedAt <= NOW && a.startedAt <= a.endedAt)).toBe(true);
      }
      const rows = sampleUsageRows(setup, [], NOW);
      expect(new Set(rows.map((row) => row.call.callId)).size).toBe(rows.length);
    });

    it("give a sample board item's id to an item of today or yesterday with its title, and to no other", () => {
      const record = (id: string, title: string) => ({ id, title }) as ItemRecord;
      const board = [record("item_1a2b3c4d-0001-4a1b-8c1d-000000000001", "Add order export endpoint"), record("item_1a2b3c4d-0002-4a1b-8c1d-000000000002", "Orders API returns 500 after deploy")];
      const withBoard = sampleUsageItems(setup, board, NOW);
      const known = withBoard.filter((item) => item.itemId.startsWith("item_1a2b3c4d"));
      expect(known.map((item) => item.title).sort()).toEqual(["Add order export endpoint", "Orders API returns 500 after deploy"]);
      expect(new Set(withBoard.map((item) => item.itemId)).size).toBe(items.length);
      const day = 24 * 60 * 60_000;
      expect(known.every((item) => item.calls.every((call) => call.endedAt >= NOW - 2 * day))).toBe(true);
    });
  });
});
