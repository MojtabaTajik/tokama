import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CliPlanSchema, UsageReportSchema, type AgentCallUsage, type ItemId } from "../../kernel/schemas/index.js";
import { callCost, choosePlan, FRESH_MS, localDate, priceOf, PRICES_AS_OF, rangeStart, summarizeUsage, tokenCost, type UsageRow } from "./index.js";

// Times are local, so the tests do not depend on the machine's time zone.
const NOW = new Date(2025, 9, 20, 15, 0).getTime();
const at = (daysAgo: number, hour: number) => new Date(2025, 9, 20 - daysAgo, hour, 0).getTime();
const ITEM_A = "item_0190a000-0000-7000-8000-00000000000a" as ItemId;
const ITEM_B = "item_0190a000-0000-7000-8000-00000000000b" as ItemId;
const MILLION = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };

let calls = 0;
function call(fields: Partial<AgentCallUsage> & { endedAt: number }): AgentCallUsage {
  calls++;
  return {
    callId: `call_0190a000-0000-7000-8000-${String(calls).padStart(12, "0")}` as AgentCallUsage["callId"],
    stepId: "build" as AgentCallUsage["stepId"],
    attempt: 1,
    agentId: "architect" as AgentCallUsage["agentId"],
    cliId: "claude-code",
    model: "claude-opus-5-5",
    outcome: "completed",
    startedAt: fields.endedAt - 60_000,
    tokens: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 0 },
    ...fields,
  };
}
const row = (itemId: ItemId, templateId: string, usage: AgentCallUsage, title = itemId === ITEM_A ? "Add order export" : "Slow query"): UsageRow => ({ itemId, title, templateId, call: usage });

describe("prices", () => {
  it("prices a model by its exact id, ignoring a provider prefix, a context tag and a date", () => {
    expect(tokenCost("claude-opus-5-5", MILLION)).toBe(4);
    expect(tokenCost("claude-opus-5", MILLION)).toBe(5);
    expect(tokenCost("us.anthropic.claude-sonnet-4-6", MILLION)).toBe(3);
    expect(tokenCost("claude-opus-5-5[1m]", MILLION)).toBe(4);
    expect(tokenCost("claude-haiku-4-5-20251001", MILLION)).toBe(1);
    expect(tokenCost("claude-opus-5-5", { input: 0, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 })).toBeCloseTo(20 + 0.2 + 5, 10);
  });

  it("never guesses: an alias, a near name and a local model have no price", () => {
    for (const model of ["opus", "claude-opus-5-55", "claude-opus", "qwen3-coder:30b", "constructor"]) expect(priceOf(model)).toBeUndefined();
    expect(PRICES_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("estimates a call: local costs nothing, the CLI's figure wins, else the table, else unknown", () => {
    expect(callCost(call({ endedAt: NOW, cliId: "ollama", model: "qwen3-coder:30b", reportedCostUsd: 0.03 }))).toBe(0);
    expect(callCost(call({ endedAt: NOW, reportedCostUsd: 0.42 }))).toBe(0.42);
    // A crash result's zeroed cost is not believed for a call that used tokens.
    expect(callCost(call({ endedAt: NOW, reportedCostUsd: 0, tokens: MILLION }))).toBe(4);
    expect(callCost(call({ endedAt: NOW, reportedCostUsd: 0, model: "opus" }))).toBeNull();
    expect(callCost(call({ endedAt: NOW, reportedCostUsd: 0, model: "opus", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }))).toBe(0);
    expect(callCost(call({ endedAt: NOW, tokens: MILLION }))).toBe(4);
    expect(callCost(call({ endedAt: NOW, models: { "claude-opus-5-5": MILLION, "claude-haiku-5-5": MILLION } }))).toBeCloseTo(4.1, 10);
    expect(callCost(call({ endedAt: NOW, models: { "claude-opus-5-5": MILLION, "mystery-model": MILLION } }))).toBeNull();
    expect(callCost(call({ endedAt: NOW, model: "opus" }))).toBeNull();
  });
});

describe("summarizeUsage", () => {
  const rows = [
    row(ITEM_A, "plan-and-build", call({ endedAt: at(0, 10), reportedCostUsd: 1 })),
    row(ITEM_A, "plan-and-build", call({ endedAt: at(0, 11), agentId: "reviewer" as never, cliId: "codex-cli", model: "gpt-5-codex" })),
    row(ITEM_B, "db-slow-query", call({ endedAt: at(2, 9), cliId: "ollama", model: "qwen3-coder:30b", tokens: { input: 5000, output: 500, cacheRead: 0, cacheWrite: 0 } })),
    // Outside a 14-day range.
    row(ITEM_B, "db-slow-query", call({ endedAt: at(20, 9), reportedCostUsd: 99 })),
  ];

  it("has every day of the range, oldest first, with each workflow's tokens, cost and items", () => {
    const report = summarizeUsage({ rows, range: 14, now: NOW, clis: [] });
    expect(UsageReportSchema.safeParse(report).success).toBe(true);
    expect(report.days).toHaveLength(14);
    expect(report.days[0]?.date).toBe("2025-10-07");
    expect(report.days.at(-1)).toEqual({
      date: "2025-10-20",
      workflows: [{ templateId: "plan-and-build", tokens: 2300, costUsd: 1, items: [{ itemId: ITEM_A, title: "Add order export" }], itemCount: 1 }],
    });
    expect(report.days.at(-3)?.workflows).toEqual([{ templateId: "db-slow-query", tokens: 5500, costUsd: 0, items: [{ itemId: ITEM_B, title: "Slow query" }], itemCount: 1 }]);
    expect(report.days.at(-2)?.workflows).toEqual([]);
  });

  it("totals the range, counts calls nothing could price, and leaves their cost out", () => {
    const report = summarizeUsage({ rows, range: 14, now: NOW, clis: [] });
    expect(report.totals).toEqual({ tokens: { input: 5200, output: 600, cacheRead: 2000, cacheWrite: 0 }, costUsd: 1, calls: 3, unpricedCalls: 1 });
    expect(report.workflows).toEqual([
      { templateId: "db-slow-query", tokens: 5500, costUsd: 0, calls: 1 },
      { templateId: "plan-and-build", tokens: 2300, costUsd: 1, calls: 2 },
    ]);
    expect(summarizeUsage({ rows, range: 30, now: NOW, clis: [] }).totals.calls).toBe(4);
  });

  it("lists items by tokens with each agent once, their wall time, and whether they ran only locally", () => {
    const report = summarizeUsage({ rows, range: 14, now: NOW, clis: [] });
    expect(report.items).toEqual([
      expect.objectContaining({ itemId: ITEM_B, local: true, costUsd: 0, durationMs: 60_000, agents: [{ agentId: "architect", cliId: "ollama" }] }),
      expect.objectContaining({
        itemId: ITEM_A,
        local: false,
        costUsd: 1,
        durationMs: 120_000,
        agents: [
          { agentId: "architect", cliId: "claude-code" },
          { agentId: "reviewer", cliId: "codex-cli" },
        ],
      }),
    ]);
  });

  it("shows a day's five items with the most tokens, and how many there were", () => {
    const many = Array.from({ length: 7 }, (_, n) => {
      const itemId = `item_0190a000-0000-7000-8000-00000000010${n}` as ItemId;
      return row(itemId, "plan-and-build", call({ endedAt: at(0, 9), tokens: { input: n, output: 0, cacheRead: 0, cacheWrite: 0 } }), `Item ${n}`);
    });
    const day = summarizeUsage({ rows: many, range: 14, now: NOW, clis: [] }).days.at(-1)?.workflows[0];
    expect(day?.itemCount).toBe(7);
    expect(day?.items.map((item) => item.title)).toEqual(["Item 6", "Item 5", "Item 4", "Item 3", "Item 2"]);
  });

  it("is empty but complete with no calls", () => {
    const report = summarizeUsage({ rows: [], range: 90, now: NOW, clis: [] });
    expect(report.days).toHaveLength(90);
    expect(report.totals).toEqual({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: null, calls: 0, unpricedCalls: 0 });
  });

  it("counts days in local time", () => {
    expect(localDate(new Date(2025, 0, 5, 23, 59).getTime())).toBe("2025-01-05");
    expect(rangeStart(NOW, 14)).toBe(new Date(2025, 9, 7).getTime());
  });
});

describe("local days in a zone with a DST change", () => {
  // The days are local: a call late in the evening in New York is already the next day in UTC.
  // Run in a fixed zone, so the test fails if the code counts UTC days, whatever the machine's zone.
  const saved = process.env["TZ"];
  beforeAll(() => {
    process.env["TZ"] = "America/New_York";
  });
  afterAll(() => {
    if (saved === undefined) delete process.env["TZ"];
    else process.env["TZ"] = saved;
  });

  it("puts a late-evening call on its local day and has every day of a range that crosses the change", () => {
    const now = new Date(2025, 10, 20, 15, 0).getTime();
    const late = new Date(2025, 10, 1, 23, 30).getTime();
    expect(new Date(late).getUTCDate()).toBe(2);
    expect(localDate(late)).toBe("2025-11-01");
    const report = summarizeUsage({ rows: [row(ITEM_A, "plan-and-build", call({ endedAt: late }))], range: 90, now, clis: [] });
    const dates = report.days.map((day) => day.date);
    expect(dates).toHaveLength(90);
    expect(new Set(dates).size).toBe(90);
    expect(dates.at(-1)).toBe("2025-11-20");
    expect(dates).toContain("2025-11-02");
    expect(report.days.find((day) => day.date === "2025-11-01")?.workflows).toHaveLength(1);
    expect(report.days.find((day) => day.date === "2025-11-02")?.workflows).toEqual([]);
  });
});

describe("choosePlan", () => {
  const window = (usedPercent: number, resetsAt?: number) => ({ window: "five_hour", usedPercent, ...(resetsAt !== undefined && { resetsAt }) });
  const later = NOW + 3_600_000;

  it("takes the CLI's answer first, then a run's windows, then the cache", () => {
    const request = { source: "request" as const, reading: { windows: [window(36, later)], asOf: NOW - 60_000, plan: "max", extraUsage: "off" as const } };
    const run = { source: "run" as const, reading: { windows: [window(40, later)], asOf: NOW - 30_000 } };
    const cache = { source: "cache" as const, reading: { windows: [window(20, later)], asOf: NOW - 10_000 } };
    expect(choosePlan("claude-code", [cache, run, request], NOW, "2.1.332")).toEqual({
      cliId: "claude-code",
      version: "2.1.332",
      windows: [window(36, later)],
      source: "request",
      asOf: NOW - 60_000,
      plan: "max",
      extraUsage: "off",
    });
    expect(choosePlan("claude-code", [{ source: "request", problem: "no answer" }, cache, run], NOW)).toMatchObject({ source: "run", windows: [window(40, later)] });
  });

  it("passes over an old reading for a fresh one, and uses the newest when none is fresh", () => {
    const old = { source: "request" as const, reading: { windows: [window(36, later)], asOf: NOW - FRESH_MS - 1 } };
    const fresh = { source: "cache" as const, reading: { windows: [window(50, later)], asOf: NOW - 5_000 } };
    expect(choosePlan("claude-code", [old, fresh], NOW)).toMatchObject({ source: "cache" });
    const older = { source: "cache" as const, reading: { windows: [window(50, later)], asOf: NOW - 3 * FRESH_MS } };
    expect(choosePlan("claude-code", [old, older], NOW)).toMatchObject({ source: "request", asOf: NOW - FRESH_MS - 1 });
  });

  it("cuts a run's windows to the report's limits: share, name and count", () => {
    const windows = Array.from({ length: 25 }, (_, n) => ({ window: n === 0 ? "x".repeat(100) : `w${n}`, usedPercent: n === 1 ? 5000 : n === 2 ? -3 : 10 }));
    const plan = choosePlan("claude-code", [{ source: "run", reading: { windows, asOf: NOW } }], NOW);
    expect(plan.windows).toHaveLength(20);
    expect(plan.windows[0]?.window).toHaveLength(64);
    expect([plan.windows[1]?.usedPercent, plan.windows[2]?.usedPercent]).toEqual([1000, 0]);
    expect(CliPlanSchema.safeParse(plan).success).toBe(true);
  });

  it("keeps a limit's scope, group, severity, state and share, cut to the report's limits", () => {
    const scoped = { window: "weekly_scoped", usedPercent: Number.NaN, scope: "F".repeat(80), group: "g".repeat(40), severity: "normal", active: false, sharePercent: 250 };
    const plan = choosePlan("claude-code", [{ source: "request", reading: { windows: [scoped, { window: "session", usedPercent: 12, sharePercent: -5 }], asOf: NOW } }], NOW);
    expect(plan.windows).toEqual([
      { window: "weekly_scoped", usedPercent: 0, scope: "F".repeat(64), group: "g".repeat(32), severity: "normal", active: false, sharePercent: 100 },
      { window: "session", usedPercent: 12, sharePercent: 0 },
    ]);
    expect(CliPlanSchema.safeParse(plan).success).toBe(true);
  });

  it("drops windows past their reset time, and says unknown with the first problem when nothing is left", () => {
    const reset = { source: "run" as const, reading: { windows: [window(99, NOW - 1)], asOf: NOW - 60_000 } };
    expect(choosePlan("claude-code", [{ source: "request", problem: "Claude Code is not installed." }, reset], NOW)).toEqual({
      cliId: "claude-code",
      windows: [],
      note: "Claude Code is not installed.",
    });
    expect(choosePlan("codex-cli", [], NOW)).toEqual({ cliId: "codex-cli", windows: [], note: expect.stringMatching(/No source/) });
  });
});
