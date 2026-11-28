import { type ChangeSummary, parseItemRecord, risk } from "@tokama/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ago, sampleChangedItems, sampleHistory, sampleItems } from "./data.js";

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
    expect(saids.map((said) => said["headline"])).toHaveLength(9);
    // The plan and the plan it replaced, the write-up and the Ask answer.
    expect(saids.filter((said) => said["readMinutes"] !== undefined)).toHaveLength(4);
    // Two plans with their choices, reach and risks, and one plan whose agent left them out.
    expect(saids.filter((said) => said["plan"] !== undefined)).toHaveLength(3);
    expect(saids.filter((said) => said["source"] === "first_lines")).toHaveLength(1);
    expect(saids.filter((said) => said["source"] === "headline" && said["plan"] === undefined && said["review"] === undefined && (said["points"] as unknown[]).length === 0 && said["readMinutes"] === undefined)).toHaveLength(1);
    // A review that asked for changes with two must-fix lines; an investigation with evidence and a next step; an answer with evidence and no next step.
    expect(saids.filter((said) => (said["review"] as { mustFix: unknown[] } | undefined)?.mustFix.length === 2)).toHaveLength(1);
    const found = saids.flatMap((said) => (said["findings"] === undefined ? [] : [said["findings"] as { evidence: unknown[]; next?: string }]));
    expect(found.map((findings) => [findings.evidence.length, findings.next !== undefined]).sort()).toEqual([[2, false], [3, true]]);
    expect(saids.filter((said) => (said["points"] as unknown[]).length === 3)).toHaveLength(1);
  });

  it("seed a change and the risk the engine's rules give it: low, high on dependencies, not rated for binary files", () => {
    const rated = [...sampleItems(BASE_NOW), ...sampleChangedItems(BASE_NOW)].filter((item) => item["risk"] !== undefined);
    expect(rated.map((item) => (item["risk"] as { level: string }).level).sort()).toEqual(["high", "low", "not_rated"]);
    for (const item of rated) {
      const parsed = parseItemRecord(item);
      expect(parsed.ok, `${item.id}: ${JSON.stringify(parsed.ok ? [] : parsed.error.issues)}`).toBe(true);
      // The facts the engine would have stored: every check of the item passed, and the sample has no second agent's review.
      const checks = item.steps.flatMap((step) => ((step.attempts ?? []) as unknown as { checks: { passed: boolean }[] }[]).flatMap((attempt) => attempt.checks));
      const facts = { change: item["change"] as ChangeSummary, checked: checks.length > 0 && checks.every((check) => check.passed), lastVerdict: undefined, secondReview: false, lastAttempt: false, protectedApproved: false };
      expect(risk(facts), item.id).toEqual(item["risk"]);
    }
  });

  it("keep their order and their offsets", () => {
    const now = new Date(2026, 10, 25, 0, 5, 0).getTime();
    expect(ago(now, 6)).toBeGreaterThan(ago(now, 41));
    expect(ago(now, 41)).toBeGreaterThan(ago(now, 180));
    expect(BASE_AGES).toContain(180 * MINUTE);
    expect(BASE_AGES).toContain(2 * MINUTE);
  });
});
