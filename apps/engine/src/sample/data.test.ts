import { parseItemRecord } from "@tokama/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ago, sampleHistory, sampleItems } from "./data.js";

const MINUTE = 60_000;

describe("ago", () => {
  it("is a fixed offset before now", () => {
    const now = new Date(2026, 10, 25, 14, 0, 0).getTime();
    expect(ago(now, 30)).toBe(now - 30 * MINUTE);
    expect(ago(now, 180)).toBe(now - 180 * MINUTE);
  });
});

describe("sample items", () => {
  let zone: string | undefined;
  beforeEach(() => {
    zone = process.env["TZ"];
  });
  afterEach(() => {
    if (zone === undefined) delete process.env["TZ"];
    else process.env["TZ"] = zone;
  });

  // The same shape at any hour and in any zone, also in the first hours after midnight, where the
  // oldest items fall into yesterday. Just after 00:00 the items once came out with no time at all.
  const NOWS = [
    ["00:00", 0, 0],
    ["00:05", 0, 5],
    ["01:30", 1, 30],
    ["12:00", 12, 0],
  ] as const;
  const ZONES = ["UTC", "Europe/Amsterdam"] as const;
  const BASE_NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
  const BASE_AGES = sampleItems(BASE_NOW).map((item) => BASE_NOW - item.createdAt);

  it.each(ZONES.flatMap((zoneName) => NOWS.map(([label, hour, minute]) => [zoneName, label, hour, minute] as const)))("in %s at %s: valid, with the same ages as at noon", (zoneName, _label, hour, minute) => {
    process.env["TZ"] = zoneName;
    expect(new Date(2026, 10, 25).getTimezoneOffset()).toBe(zoneName === "UTC" ? 0 : -60);
    // The local wall-clock time of the zone, on a day without a clock change.
    const now = new Date(2026, 10, 25, hour, minute, 0).getTime();
    const items = sampleItems(now);
    expect(items.map((item) => now - item.createdAt)).toEqual(BASE_AGES);
    for (const item of items) {
      const parsed = parseItemRecord(item);
      expect(parsed.ok, `${item.id}: ${JSON.stringify(parsed.ok ? [] : parsed.error.issues)}`).toBe(true);
      expect(item.createdAt).toBeLessThan(now);
    }
    // The finished item's first step waited for approval, and said so.
    const waited = items.flatMap((item) => item.steps.map((step) => step["waitedMs"])).filter((ms): ms is number => typeof ms === "number");
    expect(waited.length).toBeGreaterThan(0);
    for (const ms of waited) expect(ms).toBeGreaterThan(0);
  });

  it("seed what the agents said, valid, in every size: points, a must-read plan and write-up, one line, first lines", () => {
    type Said = Record<string, unknown>;
    const saids = [...sampleItems(BASE_NOW), ...sampleHistory(BASE_NOW, 5)].flatMap((item): Said[] => {
      const parsed = parseItemRecord(item);
      expect(parsed.ok, `${item.id}: ${JSON.stringify(parsed.ok ? [] : parsed.error.issues)}`).toBe(true);
      const steps = item.steps as unknown as { attempts?: { said?: Said }[] }[];
      const found: Said[] = [];
      for (const step of steps) for (const attempt of step.attempts ?? []) if (attempt.said !== undefined) found.push(attempt.said);
      return found;
    });
    expect(saids.map((said) => said["headline"])).toHaveLength(5);
    expect(saids.filter((said) => said["readMinutes"] !== undefined)).toHaveLength(2);
    expect(saids.filter((said) => said["source"] === "first_lines")).toHaveLength(1);
    expect(saids.filter((said) => said["source"] === "headline" && (said["points"] as unknown[]).length === 0 && said["readMinutes"] === undefined)).toHaveLength(1);
    expect(saids.filter((said) => (said["points"] as unknown[]).length === 3)).toHaveLength(1);
  });

  it("keep their order and their offsets", () => {
    const now = new Date(2026, 10, 25, 0, 5, 0).getTime();
    expect(ago(now, 6)).toBeGreaterThan(ago(now, 41));
    expect(ago(now, 41)).toBeGreaterThan(ago(now, 180));
    expect(BASE_AGES).toContain(180 * MINUTE);
    expect(BASE_AGES).toContain(2 * MINUTE);
  });
});
