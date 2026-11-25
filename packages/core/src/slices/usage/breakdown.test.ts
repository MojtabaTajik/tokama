import { describe, expect, it } from "vitest";
import { UsageReportSchema, type AgentCallUsage, type ItemId, type RepoId } from "../../kernel/schemas/index.js";
import { breakdown, callEntries, pricedEntry, summarizeUsage, type UsageEntry, type UsageRow } from "./index.js";

// Times are local, so the tests do not depend on the machine's time zone.
const NOW = new Date(2025, 9, 20, 15, 0).getTime();
const at = (daysAgo: number, hour: number) => new Date(2025, 9, 20 - daysAgo, hour, 0).getTime();
const ITEM = "item_0190a000-0000-7000-8000-00000000000a" as ItemId;
const ORDERS = "orders-api" as RepoId;
const BILLING = "billing" as RepoId;
const M = 1_000_000;
const tokens = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({ input, output, cacheRead, cacheWrite });

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
    tokens: tokens(100, 50, 1000, 0),
    ...fields,
  };
}
const row = (usage: AgentCallUsage, repoId?: RepoId): UsageRow => ({ itemId: ITEM, title: "Add order export", templateId: "plan-and-build", ...(repoId !== undefined && { repoId }), call: usage });
const entry = (fields: Partial<UsageEntry> & Pick<UsageEntry, "model" | "tokens">): UsageEntry =>
  pricedEntry({ day: "2025-10-20", cliId: "claude-code", repoId: null, calls: 1, ...fields });

describe("breakdown", () => {
  it("sums the token summary: processed, cached share, uncached input, output", () => {
    const parts = breakdown([entry({ model: "claude-opus-5-5", tokens: tokens(100, 300, 800, 100) })]);
    expect(parts.tokenSummary).toMatchObject({ processed: 1300, cachedInput: 800, cachedInputPercent: 80, uncachedInput: 200, output: 300 });
  });

  it("prices the cache savings from the table's input and cache-read prices", () => {
    // Opus 5.5: input $4, cache read $0.20 per million. Sonnet 5.5: $2 and $0.10. Both 20x cheaper.
    const parts = breakdown([entry({ model: "claude-opus-5-5", tokens: tokens(0, 0, M, 0) }), entry({ model: "claude-sonnet-5-5", tokens: tokens(0, 0, M, 0) })]);
    expect(parts.tokenSummary.cacheSavingsUsd).toBeCloseTo(3.8 + 1.9, 10);
    expect(parts.tokenSummary.cacheSavingsFactor).toBeCloseTo(20, 10);
    // Opus 5: $5 and $0.50, 10x. Weighted by cached tokens' cost: (5 + 4) / (0.5 + 0.2).
    expect(breakdown([entry({ model: "claude-opus-5", tokens: tokens(0, 0, M, 0) }), entry({ model: "claude-opus-5-5", tokens: tokens(0, 0, M, 0) })]).tokenSummary.cacheSavingsFactor).toBeCloseTo(9 / 0.7, 10);
  });

  it("has no savings figure when nothing has a price, and no share of input when there is no input", () => {
    const parts = breakdown([entry({ model: "mystery-model", tokens: tokens(0, 10, 0, 0) })]);
    expect(parts.tokenSummary).toMatchObject({ cachedInputPercent: 0, cacheSavingsUsd: null, cacheSavingsFactor: null });
    expect(parts.totals).toEqual({ tokens: tokens(0, 10, 0, 0), costUsd: null, calls: 1, unpricedCalls: 1 });
    expect(breakdown([]).tokenSummary).toEqual({ processed: 0, cachedInput: 0, cachedInputPercent: 0, uncachedInput: 0, output: 0, cacheSavingsUsd: null, cacheSavingsFactor: null });
  });

  it("lists models by cost with their share of the priced cost, unpriced ones last", () => {
    const parts = breakdown([
      entry({ model: "claude-sonnet-5-5", tokens: tokens(M, 0, 0, 0) }),
      entry({ model: "claude-opus-5-5", tokens: tokens(M, 0, 0, 0) }),
      entry({ model: "claude-opus-5-5", tokens: tokens(M, 0, 0, 0), day: "2025-10-19" }),
      entry({ model: "mystery-model", tokens: tokens(5 * M, 0, 0, 0) }),
      entry({ model: "qwen3-coder:30b", cliId: "ollama", tokens: tokens(M, 0, 0, 0) }),
    ]);
    expect(parts.models).toEqual([
      { model: "claude-opus-5-5", cliId: "claude-code", tokens: 2 * M, costUsd: 8, sharePercent: 80 },
      { model: "claude-sonnet-5-5", cliId: "claude-code", tokens: M, costUsd: 2, sharePercent: 20 },
      { model: "qwen3-coder:30b", cliId: "ollama", tokens: M, costUsd: 0, sharePercent: 0 },
      { model: "mystery-model", cliId: "claude-code", tokens: 5 * M, costUsd: null, sharePercent: null },
    ]);
  });

  it("lists repos by tokens, with work outside the configured repos as null", () => {
    const parts = breakdown([
      entry({ model: "claude-opus-5-5", tokens: tokens(M, 0, 0, 0), repoId: ORDERS }),
      entry({ model: "claude-opus-5-5", tokens: tokens(3 * M, 0, 0, 0) }),
      entry({ model: "claude-opus-5-5", tokens: tokens(M, 0, 0, 0), repoId: ORDERS }),
      entry({ model: "mystery-model", tokens: tokens(M, 0, 0, 0), repoId: BILLING }),
    ]);
    expect(parts.repos).toEqual([
      { repoId: null, tokens: 3 * M, costUsd: 12 },
      { repoId: ORDERS, tokens: 2 * M, costUsd: 8 },
      { repoId: BILLING, tokens: M, costUsd: null },
    ]);
  });

  it("shares a call's own cost over its models in proportion to their table price", () => {
    const usage = call({ endedAt: NOW, reportedCostUsd: 1, tokens: tokens(2 * M, 0, 0, 0), models: { "claude-opus-5-5": tokens(M, 0, 0, 0), "claude-haiku-5-5": tokens(M, 0, 0, 0) } });
    const entries = callEntries(row(usage, ORDERS), "2025-10-20");
    expect(entries.map((e) => [e.model, e.calls, e.repoId])).toEqual([
      ["claude-opus-5-5", 1, ORDERS],
      ["claude-haiku-5-5", 0, ORDERS],
    ]);
    expect(entries[0]?.costUsd).toBeCloseTo(4 / 4.1, 10);
    expect(entries[1]?.costUsd).toBeCloseTo(0.1 / 4.1, 10);
    expect(callEntries(row(call({ endedAt: NOW, reportedCostUsd: 0.42 })), "2025-10-20")).toEqual([expect.objectContaining({ model: "claude-opus-5-5", costUsd: 0.42, calls: 1, repoId: null })]);
  });
});

describe("summarizeUsage with a scope", () => {
  const rows = [
    row(call({ endedAt: at(0, 10), reportedCostUsd: 1, tokens: tokens(100, 50, 1000, 0) }), ORDERS),
    row(call({ endedAt: at(1, 10), cliId: "ollama", model: "qwen3-coder:30b", tokens: tokens(5000, 500, 0, 0) }), ORDERS),
  ];
  const logs = [
    entry({ model: "claude-opus-5-5", tokens: tokens(M, 0, 0, 0), repoId: ORDERS }),
    entry({ model: "claude-sonnet-5-5", tokens: tokens(0, 0, M, 0), day: "2025-10-18" }),
    // Outside a 14-day range.
    entry({ model: "claude-opus-5-5", tokens: tokens(M, 0, 0, 0), day: "2025-09-01" }),
  ];

  it("leaves the report as it was without a scope", () => {
    const report = summarizeUsage({ rows, range: 14, now: NOW, clis: [], logs });
    expect(report).not.toHaveProperty("scope");
    expect(report).not.toHaveProperty("models");
    expect(report.days.at(-1)).not.toHaveProperty("tokens");
  });

  it("counts Tokama's calls in the tokama scope, with their own totals", () => {
    const report = summarizeUsage({ rows, range: 14, now: NOW, clis: [], scope: "tokama", logs });
    expect(UsageReportSchema.safeParse(report).success).toBe(true);
    expect(report.scope).toBe("tokama");
    expect(report.totals).toEqual({ tokens: tokens(5100, 550, 1000, 0), costUsd: 1, calls: 2, unpricedCalls: 0 });
    expect(report.days.at(-1)).toMatchObject({ tokens: 1150, costUsd: 1 });
    expect(report.days.at(-2)).toMatchObject({ tokens: 5500, costUsd: 0 });
    expect(report.days.at(-3)).toMatchObject({ tokens: 0, costUsd: null });
    expect(report.repos).toEqual([{ repoId: ORDERS, tokens: 6650, costUsd: 1 }]);
    expect(report.models?.map((m) => m.model)).toEqual(["claude-opus-5-5", "qwen3-coder:30b"]);
  });

  it("counts the logs and Tokama's calls on other CLIs in the all scope, never Tokama's Claude Code calls twice", () => {
    const scan = { state: "ready" as const, filesDone: 3, filesTotal: 3, asOf: NOW };
    const report = summarizeUsage({ rows, range: 14, now: NOW, clis: [], scope: "all", logs, logsFrom: at(13, 0), scan });
    expect(UsageReportSchema.safeParse(report).success).toBe(true);
    expect(report.totals).toEqual({ tokens: tokens(M + 5000, 500, M, 0), costUsd: 4 + 0.1, calls: 3, unpricedCalls: 0 });
    expect(report.days.at(-1)).toMatchObject({ tokens: M, costUsd: 4 });
    expect(report.days.at(-3)).toMatchObject({ tokens: M, costUsd: expect.closeTo(0.1, 10) });
    expect(report.repos).toEqual([
      { repoId: ORDERS, tokens: M + 5500, costUsd: 4 },
      { repoId: null, tokens: M, costUsd: expect.closeTo(0.1, 10) },
    ]);
    expect(report.scan).toEqual(scan);
    // Tokama's workflows and items stay Tokama's, whatever the scope.
    expect(report.workflows).toEqual([{ templateId: "plan-and-build", tokens: 6650, costUsd: 1, calls: 2 }]);
  });

  it("counts Tokama's Claude Code calls the logs do not hold: before they start, or all without logs", () => {
    // The logs hold Claude Code's calls from yesterday 12:00 on; today's call is in them, the call
    // two days ago is not.
    const tokamaRows = [row(call({ endedAt: at(0, 10), tokens: tokens(M, 0, 0, 0) }), ORDERS), row(call({ endedAt: at(2, 10), tokens: tokens(M, 0, 0, 0) }), ORDERS)];
    const covered = summarizeUsage({ rows: tokamaRows, range: 14, now: NOW, clis: [], scope: "all", logs: [], logsFrom: at(1, 12) });
    expect(covered.totals).toMatchObject({ calls: 1, tokens: tokens(M, 0, 0, 0), costUsd: 4 });
    expect(covered.days.at(-3)).toMatchObject({ tokens: M });
    const none = summarizeUsage({ rows: tokamaRows, range: 14, now: NOW, clis: [], scope: "all", logs: [] });
    expect(none.totals).toMatchObject({ calls: 2, costUsd: 8 });
  });
});
