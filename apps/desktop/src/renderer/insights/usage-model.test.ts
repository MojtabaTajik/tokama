import { describe, expect, it } from "vitest";
import { NOW, setup } from "../testing/sample.js";
import { atLimit, noReading, payPerUse, planReport } from "../testing/usage.js";
import { formatDuration } from "../format/duration.js";
import { stamp } from "../format/time.js";
import {
  ageText,
  attemptsText,
  cliAlert,
  formatCost,
  formatTokens,
  headlineFacts,
  headlineOf,
  LEVEL_TONE,
  LEVEL_WORD,
  levelOf,
  limitName,
  limitShare,
  railBadge,
  resetWhen,
  shareText,
  toolColour,
  usageTools,
  usePercent,
  windowLabel,
  windowShort,
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

  it("names each limit as the Limits list shows it", () => {
    expect(
      [{ window: "five_hour" }, { window: "session" }, { window: "seven_day" }, { window: "weekly_all" }, { window: "weekly_scoped", scope: "Fable" }, { window: "weekly_scoped" }, { window: "odd_one" }].map(limitName),
    ).toEqual(["Session · 5 hours", "Session · 5 hours", "Weekly", "Weekly · all models", "Weekly · Fable", "Weekly · scoped", "odd one"]);
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
  const MIN = MINUTE;

  it("writes a time today as the clock, and another day with its weekday and date", () => {
    expect(stamp(at(20, 17, 10), NOW)).toBe("17:10");
    expect(stamp(at(23, 9), NOW)).toBe("Thu 23 Oct 09:00");
  });

  it("says how old the data is only once it is more than a few minutes old", () => {
    expect(ageText(NOW - 2 * MINUTE, NOW)).toBeUndefined();
    expect(ageText(NOW - 34 * MINUTE, NOW)).toBe("data 34 m old");
    expect(ageText(NOW - 3 * 24 * 60 * MINUTE, NOW)).toBe("data 3 d 00 h old");
  });

  it("writes billions, and picks the unit after rounding so no value reads 1000k or 1000M", () => {
    expect([950, 1234, 163_000, 2_412_000, 24_000_000].map(formatTokens)).toEqual(["950", "1.2k", "163k", "2.41M", "24.0M"]);
    expect([999_499, 999_950, 9_999_999, 99_950_000, 420_000_000, 999_999_500, 2_339_500_000, 99_960_000_000].map(formatTokens)).toEqual(["999k", "1.00M", "10.0M", "100M", "420M", "1.00B", "2.34B", "100B"]);
  });

  it("writes money with the estimate sign only when the price came from the table", () => {
    expect([formatCost(16.1), formatCost(0), formatCost(1234.5), formatCost(2.7, true)]).toEqual(["$16.10", "$0.00", "$1,235", "≈ $2.70"]);
  });

  it("writes a part of a limit with a tilde, one decimal under 10, and a part of use as a whole percent", () => {
    expect([27, 5.1, 0.94, 0.02, 99.6, 8, 1.04].map(limitShare)).toEqual(["~27%", "~5.1%", "~0.9%", "<0.1%", "~100%", "~8%", "~1%"]);
    expect([39, 0.3, 0].map(usePercent)).toEqual(["39%", "<1%", "0%"]);
  });

  it("counts down to a reset in minutes, hours or days, and says when it is", () => {
    expect([-5 * MIN, 38 * MIN, 161 * MIN, (42 * 60 + 5) * MIN].map((ms) => formatDuration(ms, "minutes"))).toEqual(["0 m", "38 m", "2 h 41 m", "1 d 18 h"]);
    const now = new Date(2025, 9, 20, 15, 0).getTime();
    expect(resetWhen(new Date(2025, 9, 20, 17, 10).getTime(), now)).toBe("at 17:10");
    expect(resetWhen(new Date(2025, 9, 23, 9, 0).getTime(), now)).toBe("Thu 09:00");
    expect(resetWhen(new Date(2025, 9, 29, 9, 0).getTime(), now)).toBe("Wed 29 Oct 09:00");
  });

  it("names a workflow by the setup, else by the last part of its key", () => {
    expect(workflowName("orders-api/old-flow", setup)).toBe("old-flow");
    expect(workflowName("builtin/plan-and-build", setup)).toBe("Plan and build");
  });

  it("lists attempts in words", () => {
    expect([[2], [2, 3], [2, 3, 4]].map(attemptsText)).toEqual(["Attempt 2", "Attempts 2 and 3", "Attempts 2, 3 and 4"]);
  });
});

describe("the first sentence", () => {
  it("is about the limit that runs out first at its pace", () => {
    const headline = headlineOf(planReport.clis, NOW, undefined);
    expect(headline).toMatchObject({ kind: "runs_out", plan: { cliId: "claude-code" }, window: { window: "weekly_all" } });
    expect(headlineFacts(headline!, planReport.clis, NOW)).toBe("Max plan · 82% used with 2 d 18 h to go · resets Thu 09:00 · this week's pace is 19% a day · about 1 d 19 h short · Codex CLI is on pace to stay under");
  });

  it("is about the picked tool only, and on pace when nothing runs out", () => {
    expect(headlineOf(planReport.clis, NOW, "codex-cli")).toMatchObject({ kind: "on_pace", plan: { cliId: "codex-cli" } });
    expect(headlineOf(planReport.clis, NOW, "ollama")).toBeUndefined();
  });

  it("names a reached limit before one that runs out", () => {
    expect(headlineOf(atLimit.clis, NOW, undefined)).toMatchObject({ kind: "at_limit", window: { window: "weekly_all" } });
  });

  it("is none without a reading, and none for a tool billed per use", () => {
    expect(headlineOf(noReading.clis, NOW, undefined)).toBeUndefined();
    expect(headlineOf(payPerUse.clis, NOW, undefined)).toBeUndefined();
  });
});

describe("AI tools", () => {
  it("offers the tools the setup finds installed and any that has a reading or runs, in the app's order", () => {
    expect(usageTools(planReport, setup)).toEqual(["claude-code", "codex-cli", "ollama"]);
    const quietReport = { ...planReport, clis: planReport.clis.map((cli) => ({ cliId: cli.cliId, windows: [] })), week: { ...planReport.week!, steps: [], helpers: [] } };
    expect(usageTools(quietReport, setup)).toEqual([]);
    const installed = { ...setup, health: { ...setup.health, clis: [{ cliId: "claude-code" as const, installed: true, loggedIn: true }, { cliId: "codex-cli" as const, installed: false, loggedIn: false }] } };
    expect(usageTools(quietReport, installed)).toEqual(["claude-code"]);
  });

  it("colours a tool by its place in the list, never by an amount", () => {
    const tools = ["claude-code", "codex-cli", "ollama"] as const;
    expect(tools.map((id) => toolColour(id, tools))).toEqual(["var(--tag-sky)", "var(--tag-sand)", "var(--tag-clay)"]);
    expect(toolColour("ollama", ["claude-code"])).toBe("var(--chart-other)");
  });
});
