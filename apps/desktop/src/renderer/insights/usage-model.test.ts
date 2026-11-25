import { describe, expect, it } from "vitest";
import { NOW, setup } from "../testing/sample.js";
import { allReport, usageReport } from "../testing/usage.js";
import {
  ageText,
  cardLabel,
  chartModel,
  cliAlert,
  formatClock,
  formatCost,
  formatDuration,
  formatTokens,
  formatUsd,
  countdown,
  niceMax,
  railBadge,
  resetWhen,
  scanText,
  share,
  tickLabel,
  shareText,
  windowLabel,
  windowShort,
  levelOf,
  LEVEL_TONE,
  LEVEL_WORD,
  tokamaTotals,
  workflowName,
} from "./usage-model.js";

const MINUTE = 60_000;
const at = (day: number, hour: number, minute = 0) => new Date(2025, 9, day, hour, minute).getTime();

describe("plan window words", () => {
  it("names the windows and limits Claude Code reports, and any other by its own name", () => {
    const names = ["five_hour", "seven_day", "seven_day_opus", "session", "weekly_all", "weekly_scoped", "monthly_extra"].map((window) => windowLabel({ window }));
    expect(names).toEqual(["5-hour window", "Weekly window", "Weekly · Opus", "Session window", "Weekly window", "Scoped weekly window", "monthly extra"]);
    expect([windowLabel({ window: "weekly_scoped", scope: "Fable" }), windowShort({ window: "weekly_scoped", scope: "Fable" }), windowShort({ window: "session" })]).toEqual(["Fable weekly window", "Fable weekly", "Session"]);
  });

  it("says how much of the weekly limit a scoped limit may use", () => {
    expect([shareText({ sharePercent: 49.6 }), shareText({})]).toEqual(["50% share of the weekly limit", undefined]);
  });

  it("levels the rail badge by the shown number, as the meter does", () => {
    const plan = (usedPercent: number) => ({ cliId: "claude-code" as const, windows: [{ window: "session", usedPercent }] });
    expect([79.4, 79.6, 99.4, 99.6].map((p) => cliAlert(plan(p), undefined, 0))).toEqual([undefined, "near_limit", "near_limit", "limit"]);
  });

  it("levels a window: ok under 60%, high to 79%, near its limit from 80%, at it from 100%, each above ok with a word", () => {
    const levels = [0, 59.9, 60, 79.9, 80, 99, 100, 130].map(levelOf);
    expect(levels).toEqual(["ok", "ok", "high", "high", "near", "near", "limit", "limit"]);
    expect(levels.map((level) => [LEVEL_TONE[level], LEVEL_WORD[level]])).toEqual([
      ["pass", undefined],
      ["pass", undefined],
      ["warn", "high"],
      ["warn", "high"],
      ["fail", "! near limit"],
      ["fail", "! near limit"],
      ["fail", "✕ at limit"],
      ["fail", "✕ at limit"],
    ]);
  });

  it("puts a login problem before the windows, and badges the rail with ✕ before !", () => {
    const near = { cliId: "codex-cli" as const, windows: [{ window: "seven_day", usedPercent: 84 }] };
    expect(cliAlert(near, undefined, NOW)).toBe("near_limit");
    expect(cliAlert(near, { cliId: "codex-cli", kind: "logged_out" }, NOW)).toBe("logged_out");
    expect(cliAlert({ ...near, windows: [{ window: "five_hour", usedPercent: 100 }] }, undefined, NOW)).toBe("limit");
    expect(cliAlert({ cliId: "claude-code", windows: [] }, undefined, NOW)).toBeUndefined();
    // A window at its limit whose reset time has passed no longer alerts, even if the report is old.
    expect(cliAlert({ ...near, windows: [{ window: "five_hour", usedPercent: 100, resetsAt: NOW - 1 }] }, undefined, NOW)).toBeUndefined();
    expect(railBadge([undefined, "near_limit"])).toEqual({ symbol: "!", tone: "warn" });
    expect(railBadge(["near_limit", "logged_out"])).toEqual({ symbol: "✕", tone: "fail" });
    expect(railBadge([undefined, undefined])).toBeUndefined();
  });
});

describe("times and numbers", () => {
  it("writes a time today as the clock, and another day with its weekday and date", () => {
    expect(formatClock(at(20, 17, 10), NOW)).toBe("17:10");
    expect(formatClock(at(23, 9), NOW)).toBe("Thu 23 Oct 09:00");
  });

  it("says how old the data is only once it is more than a few minutes old", () => {
    expect(ageText(NOW - 2 * MINUTE, NOW)).toBeUndefined();
    expect(ageText(NOW - 34 * MINUTE, NOW)).toBe("data 34 min old");
    expect(formatDuration(3 * 24 * 60 * MINUTE)).toBe("3 days");
  });

  it("formats tokens compactly and costs as estimates, unknown when nothing was priced", () => {
    expect([formatTokens(950), formatTokens(1234), formatTokens(163_000), formatTokens(2_412_000), formatTokens(24_000_000)]).toEqual(["950", "1.2k", "163k", "2.41M", "24.0M"]);
    expect([formatCost(3.1), formatCost(0), formatCost(12.1), formatCost(1234.5), formatCost(null)]).toEqual(["≈ $3.10", "≈ $0.00", "≈ $12.10", "≈ $1,235", "unknown"]);
    expect([share(62, 100), share(0.1, 100), share(0, 100), share(5, 0)]).toEqual([62, 1, 0, 0]);
  });
});

describe("chartModel", () => {
  it("has a column per day with segments in the setup's workflow order, whatever their size", () => {
    const model = chartModel(usageReport, "tokens", setup);
    expect(model.columns).toHaveLength(14);
    expect(model.series).toEqual(["builtin/emergency-investigator", "builtin/plan-and-build"]);
    const today = model.columns.at(-1)!;
    expect(today).toMatchObject({ date: "2025-10-20", weekday: "Mon", day: "20", total: 300_000 });
    expect(today.segments.map((s) => s.templateId)).toEqual(["builtin/emergency-investigator", "builtin/plan-and-build"]);
    expect(model.max).toBe(500_000);
    expect(model.ticks).toEqual([0, 125_000, 250_000, 375_000, 500_000]);
  });

  it("stacks estimated cost the same way, and puts workflows the setup no longer lists last", () => {
    const cost = chartModel(usageReport, "cost", setup);
    expect(cost.columns.at(-1)?.total).toBeCloseTo(3.5, 10);
    expect(cost.max).toBe(5);
    expect(chartModel(usageReport, "tokens", undefined).series).toEqual(["builtin/emergency-investigator", "builtin/plan-and-build"]);
    expect(workflowName("orders-api/old-flow", setup)).toBe("old-flow");
    expect(workflowName("builtin/plan-and-build", setup)).toBe("Plan and build");
  });

  it("rounds the axis top up to 1, 2, 2.5 or 5 times a power of ten, and labels ticks per measure", () => {
    expect([niceMax(0), niceMax(3), niceMax(180), niceMax(2_400), niceMax(4_800), niceMax(9_100)]).toEqual([1, 5, 200, 2_500, 5_000, 10_000]);
    expect([tickLabel(0, "tokens"), tickLabel(250_000, "tokens"), tickLabel(2.5, "cost"), tickLabel(5, "cost")]).toEqual(["0", "250k", "$2.50", "$5"]);
  });
});

describe("Usage v2 words and numbers", () => {
  const MIN = 60_000;

  it("writes billions, and picks the unit after rounding so no value reads 1000k or 1000M", () => {
    expect([999_499, 999_950, 9_999_999, 99_950_000, 420_000_000, 999_999_500, 2_339_500_000, 99_960_000_000].map(formatTokens)).toEqual([
      "999k",
      "1.00M",
      "10.0M",
      "100M",
      "420M",
      "1.00B",
      "2.34B",
      "100B",
    ]);
  });

  it("writes a table cost without the estimate sign, and unknown without a price", () => {
    expect([formatUsd(3.1), formatUsd(1755), formatUsd(null)]).toEqual(["$3.10", "$1,755", "unknown"]);
  });

  it("names each limit as its card shows it", () => {
    expect(
      [{ window: "five_hour" }, { window: "session" }, { window: "seven_day" }, { window: "weekly_all" }, { window: "weekly_scoped", scope: "Fable" }, { window: "weekly_scoped" }, { window: "odd_one" }].map(cardLabel),
    ).toEqual(["Session · 5 hours", "Session · 5 hours", "Weekly", "Weekly · all models", "Weekly · Fable", "Weekly · scoped", "odd one"]);
  });

  it("counts down to a reset in minutes, hours or days, and says when it is", () => {
    expect([countdown(-5 * MIN), countdown(38 * MIN), countdown(161 * MIN), countdown((42 * 60 + 5) * MIN)]).toEqual(["0m", "38m", "2h 41m", "1d 18h"]);
    const now = new Date(2025, 9, 20, 15, 0).getTime();
    expect(resetWhen(new Date(2025, 9, 20, 17, 10).getTime(), now)).toBe("at 17:10");
    expect(resetWhen(new Date(2025, 9, 23, 9, 0).getTime(), now)).toBe("Thu 09:00");
    expect(resetWhen(new Date(2025, 9, 29, 9, 0).getTime(), now)).toBe("Wed 29 Oct 09:00");
  });

  it("totals Tokama's own calls in either scope", () => {
    expect(tokamaTotals(usageReport)).toEqual({ tokens: 896_000, costUsd: 12.1, unpricedCalls: 2 });
    expect(tokamaTotals(allReport)).toEqual({ tokens: 896_000, costUsd: 12.1, unpricedCalls: 0 });
    expect(tokamaTotals({ ...allReport, workflows: allReport.workflows.map((w) => ({ ...w, costUsd: null })) })).toMatchObject({ costUsd: null });
  });

  it("shows the first log scan's progress and why the logs cannot be read, and nothing else", () => {
    expect(scanText(undefined)).toBeUndefined();
    expect(scanText({ state: "ready", filesDone: 9, filesTotal: 9 })).toBeUndefined();
    expect(scanText({ state: "scanning", filesDone: 3, filesTotal: 9 })).toBe("Reading Claude Code logs… 3 of 9 files");
    expect(scanText({ state: "scanning", filesDone: 3, filesTotal: 9, asOf: 1 })).toBeUndefined();
    expect(scanText({ state: "unavailable", filesDone: 0, filesTotal: 0, note: "No logs folder." })).toBe("No logs folder.");
    expect(scanText({ state: "unavailable", filesDone: 0, filesTotal: 0 })).toBeUndefined();
  });
});
