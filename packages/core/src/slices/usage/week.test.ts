import { describe, expect, it } from "vitest";
import { CliPlanSchema, UsageReportSchema, type AgentCallUsage, type CliPlan, type RepoId, type UsageReport } from "../../kernel/schemas/index.js";
import type { RunItem } from "./runs.js";
import type { CallLogs } from "./split.js";
import { summarizeUsage, type SummaryInput } from "./summary.js";
import { itemUsageOf } from "./week.js";
import type { PastWindow } from "./window.js";
import { attempt, call, DAY, HOUR, item, MILLION, NOW, step } from "./testing/items.js";

// The weekly window started 5 days ago and resets in 2.
const WEEK_START = NOW - 5 * DAY;
const plan = (usedPercent: number, over: Partial<CliPlan> = {}): CliPlan => ({
  cliId: "claude-code",
  windows: [{ window: "weekly_all", usedPercent, resetsAt: NOW + 2 * DAY }],
  billing: "plan",
  source: "request",
  asOf: NOW,
  ...over,
});
const perUse: CliPlan = { cliId: "claude-code", windows: [], billing: "pay_per_use", source: "request", asOf: NOW };
const OPUS_ALL: CallLogs["totals"] = () => [{ model: "claude-opus-5-5", tokens: { ...MILLION, input: 4_000_000 } }];
const logs = (over: Partial<CallLogs> = {}): CallLogs => ({ totals: OPUS_ALL, coveredFrom: WEEK_START - DAY, ready: true, ...over });

/** An item with one Build step that passed first try: one million opus tokens, weight 4. */
function buildItem(endedAt: number, over: Partial<AgentCallUsage> = {}, repoIds: RepoId[] = ["orders-api" as RepoId]) {
  return item([step("build", "checks pass", [attempt(1, "passed", endedAt, [["pnpm test", true]])])], [call({ stepId: "build", attempt: 1, endedAt, model: "claude-opus-5-5", tokens: MILLION, ...over })], { repoIds });
}

function report(items: RunItem[], clis: CliPlan[], extra: Partial<NonNullable<SummaryInput["week"]>> = {}, helperCalls: SummaryInput["helperCalls"] = []): UsageReport {
  const out = summarizeUsage({ rows: [], helperCalls, range: 90, now: NOW, clis, week: { items, past: {}, logs: { "claude-code": logs() }, ...extra } });
  expect(UsageReportSchema.safeParse(out).success).toBe(true);
  return out;
}

const keysOf = (value: unknown, found = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) for (const v of value) keysOf(v, found);
  else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      found.add(k);
      keysOf(v, found);
    }
  }
  return found;
};

describe("the week block", () => {
  it("splits the weekly window between Tokama and everything else, and the rows add up to Tokama's part", () => {
    // Two builds weigh 4 and 12 of the 32 the logs hold; 60% is used: Tokama 30%, the user's own sessions 30%.
    const items = [buildItem(NOW - 4 * DAY), buildItem(NOW - 2 * DAY, { tokens: { ...MILLION, input: 3_000_000 } })];
    const { week } = report(items, [plan(60)], { logs: { "claude-code": logs({ totals: () => [{ model: "claude-opus-5-5", tokens: { ...MILLION, input: 8_000_000 } }] }) } });
    expect(week?.window).toBe("current");
    expect(week?.limits).toEqual([{ cliId: "claude-code", window: "weekly_all", startsAt: WEEK_START, endsAt: NOW + 2 * DAY, usedPercent: 60, tokamaPercent: 30, outsidePercent: 30 }]);
    expect(week?.steps).toHaveLength(1);
    expect(week?.steps[0]).toMatchObject({ stepId: "build", stepName: "Build", agentId: "builder", model: "claude-opus-5-5", runs: 2, itemCount: 2, tokens: 4_000_000, tokamaPercent: 100, sharePercent: 30 });
    expect(week?.steps[0]?.items.map((i) => [i.runs, i.sharePercent])).toEqual([[1, 22.5], [1, 7.5]]);
  });

  it("tells outside use when the logs hold more than Tokama ran", () => {
    const { week } = report([buildItem(NOW - DAY)], [plan(80)], { logs: { "claude-code": logs({ totals: () => [{ model: "claude-opus-5-5", tokens: { ...MILLION, input: 4_000_000 } }] }) } });
    // Tokama's call weighs 4 of the 16 logged.
    expect(week?.limits[0]).toMatchObject({ usedPercent: 80, tokamaPercent: 20, outsidePercent: 60 });
    expect(week?.steps[0]?.sharePercent).toBe(20);
  });

  it("holds over the limit: at 105% the two parts add up to 105", () => {
    const { week } = report([buildItem(NOW - DAY)], [plan(105)]);
    const limit = week?.limits[0];
    expect((limit?.tokamaPercent ?? 0) + (limit?.outsidePercent ?? 0)).toBeCloseTo(105, 5);
  });

  it("tells no split under 10 points, for the current window and the previous one", () => {
    const current = report([buildItem(NOW - DAY)], [plan(9.9)]).week;
    expect(current?.limits[0]).toEqual({ cliId: "claude-code", window: "weekly_all", startsAt: WEEK_START, endsAt: NOW + 2 * DAY, usedPercent: 9.9 });
    expect(current?.steps[0]).not.toHaveProperty("sharePercent");
    expect(current?.steps[0]).toMatchObject({ tokamaPercent: 100 });
    expect(report([buildItem(NOW - DAY)], [plan(10)]).week?.limits[0]).toHaveProperty("tokamaPercent");

    const past = (usedPercent: number): PastWindow => ({ window: "weekly_all", startsAt: WEEK_START - 7 * DAY, endsAt: WEEK_START, usedPercent, weight: { tokama: 4, all: 8 }, pricesAsOf: "2025-10-01" });
    const before = (usedPercent: number) => summarizeUsage({ rows: [], range: 90, now: NOW, clis: [plan(30)], week: { window: "previous", items: [buildItem(WEEK_START - 3 * DAY)], past: { "claude-code": [past(usedPercent)] } } }).week;
    expect(before(9.9)?.limits[0]).not.toHaveProperty("tokamaPercent");
    expect(before(10)?.limits[0]).toMatchObject({ tokamaPercent: 5, outsidePercent: 5 });
  });

  it("tells no split while the logs are being read, or when they begin after the window", () => {
    for (const over of [{ ready: false }, { coveredFrom: WEEK_START + HOUR }, { coveredFrom: undefined }]) {
      const { week } = report([buildItem(NOW - DAY)], [plan(60)], { logs: { "claude-code": logs(over) } });
      expect(week?.limits[0]).not.toHaveProperty("tokamaPercent");
      expect(week?.steps[0]).not.toHaveProperty("sharePercent");
    }
  });

  it("covers the window before: its limit and use from the stored list, and its calls from their own time", () => {
    const past: PastWindow = { window: "weekly_all", startsAt: WEEK_START - 7 * DAY, endsAt: WEEK_START + 1000, usedPercent: 40, weight: { tokama: 4, all: 8 }, pricesAsOf: "2025-10-01" };
    const items = [buildItem(WEEK_START - 3 * DAY), buildItem(NOW - DAY)];
    const { week } = summarizeUsage({ rows: [], range: 90, now: NOW, clis: [plan(60)], week: { window: "previous", items, past: { "claude-code": [past] } } });
    expect(week?.window).toBe("previous");
    expect(week?.limits).toEqual([{ cliId: "claude-code", window: "weekly_all", startsAt: past.startsAt, endsAt: past.endsAt, usedPercent: 40, tokamaPercent: 20, outsidePercent: 20 }]);
    expect(week?.steps).toHaveLength(1);
    expect(week?.steps[0]).toMatchObject({ runs: 1, sharePercent: 20 });
    expect(week?.items).toHaveLength(1);
  });

  it("keeps the previous window's frozen weight when the price table has changed since", () => {
    // The window closed with Tokama at half of the weight under old prices; the rows' parts follow today's weights.
    const past: PastWindow = { window: "weekly_all", startsAt: WEEK_START - 7 * DAY, endsAt: WEEK_START, usedPercent: 50, weight: { tokama: 1, all: 2 }, pricesAsOf: "2024-01-01" };
    const cheap = buildItem(WEEK_START - 3 * DAY, { model: "claude-haiku-5-5" });
    const dear = buildItem(WEEK_START - 2 * DAY);
    const { week } = summarizeUsage({ rows: [], range: 90, now: NOW, clis: [plan(60)], week: { window: "previous", items: [cheap, dear], past: { "claude-code": [past] } } });
    expect(week?.limits[0]).toMatchObject({ tokamaPercent: 25, outsidePercent: 25 });
    // 0.1 and 4 of 4.1: 25% of the limit shared in that proportion.
    const shares = Object.fromEntries((week?.steps ?? []).map((row) => [row.model, row.sharePercent]));
    expect(shares["claude-opus-5-5"]).toBeCloseTo(24.39, 2);
    expect(shares["claude-haiku-5-5"]).toBeCloseTo(0.61, 2);
  });

  it("uses the last 7 days for a CLI with no weekly window, and tells no limit for it", () => {
    const local = { cliId: "ollama" as const, windows: [] };
    const items = [
      item([step("fix", "agent finishes", [attempt(1, "passed", NOW - 2 * DAY)])], [call({ stepId: "fix", attempt: 1, endedAt: NOW - 2 * DAY, cliId: "ollama", model: "qwen3-coder:30b" })]),
      item([step("fix", "agent finishes", [attempt(1, "passed", NOW - 9 * DAY)])], [call({ stepId: "fix", attempt: 1, endedAt: NOW - 9 * DAY, cliId: "ollama", model: "qwen3-coder:30b" })]),
    ];
    const { week } = report(items, [local]);
    expect(week?.limits).toEqual([]);
    expect(week?.steps).toHaveLength(1);
    expect(week?.steps[0]).toMatchObject({ cliId: "ollama", runs: 1, tokens: 11_000, tokamaPercent: 100 });
    expect(week?.steps[0]).not.toHaveProperty("sharePercent");
  });

  it("never adds the shares of two CLIs: each row is a part of its own CLI's limit", () => {
    const codex = item([step("review", "reviewer approves", [attempt(1, "passed", NOW - DAY)], "reviewer")], [call({ stepId: "review", attempt: 1, endedAt: NOW - DAY, cliId: "codex-cli", agentId: "reviewer" as never, model: "gpt-5-codex", reportedCostUsd: 2 })]);
    const codexPlan: CliPlan = { cliId: "codex-cli", windows: [{ window: "seven_day", usedPercent: 41, resetsAt: NOW + 3 * DAY }], billing: "plan", source: "request", asOf: NOW };
    const { week } = report([buildItem(NOW - DAY), codex], [plan(60), codexPlan]);
    // Codex CLI keeps no logs here: it has a limit row, and its rows say their part of Tokama's use only.
    expect(week?.limits.map((l) => [l.cliId, l.usedPercent, "tokamaPercent" in l])).toEqual([["claude-code", 60, true], ["codex-cli", 41, false]]);
    const codexRow = week?.steps.find((row) => row.cliId === "codex-cli");
    expect(codexRow).toMatchObject({ tokamaPercent: 100 });
    expect(codexRow).not.toHaveProperty("sharePercent");
    const claudeShare = week?.steps.filter((row) => row.cliId === "claude-code").reduce((sum, row) => sum + (row.sharePercent ?? 0), 0);
    expect(claudeShare).toBeLessThanOrEqual(60);
  });

  it("tells no part of the limit for a model no price knows, and ranks by tokens then", () => {
    const { week } = report([buildItem(NOW - DAY, { model: "mystery-model" })], [plan(60)]);
    expect(week?.limits[0]).not.toHaveProperty("tokamaPercent");
    expect(week?.steps[0]).not.toHaveProperty("sharePercent");
    expect(week?.steps[0]?.tokamaPercent).toBe(100);
  });

  it("counts helper calls in the window, and lists them apart", () => {
    const helper = { helperId: "suggest-checks" as const, call: call({ stepId: "suggest-checks", attempt: 1, endedAt: NOW - HOUR, model: "claude-haiku-5-5", tokens: MILLION }) };
    const { week } = report([buildItem(NOW - DAY)], [plan(60)], {}, [helper]);
    expect(week?.helpers).toEqual([expect.objectContaining({ cliId: "claude-code", model: "claude-haiku-5-5", calls: 1, tokens: 1_000_000 })]);
    expect(week?.steps).toHaveLength(1);
  });

  it("gives the same rows, in the same order, whatever order the items come in", () => {
    // Two workflows that used the same tokens: only the items' own order could tell them apart.
    const a = item([step("build", "checks pass", [attempt(1, "passed", NOW - DAY)])], [call({ stepId: "build", attempt: 1, endedAt: NOW - DAY, model: "claude-opus-5-5", tokens: MILLION })], { title: "A change", templateId: "builtin/quick-fix" });
    const b = item([step("fix", "agent finishes", [attempt(1, "passed", NOW - DAY)])], [call({ stepId: "fix", attempt: 1, endedAt: NOW - DAY, model: "claude-opus-5-5", tokens: MILLION })], { title: "B change", templateId: "builtin/quick-change" });
    const forward = report([a, b], [plan(9)]).week;
    expect(report([b, a], [plan(9)]).week).toEqual(forward);
    expect(forward?.steps.map((row) => row.templateId)).toEqual(["builtin/quick-fix", "builtin/quick-change"]);
  });

  it("is absent without items, and the old blocks stay", () => {
    const old = summarizeUsage({ rows: [], range: 14, now: NOW, clis: [] });
    expect(old).not.toHaveProperty("week");
    expect(old).not.toHaveProperty("stepModels");
    expect(old).not.toHaveProperty("agentModels");
  });
});

describe("cost", () => {
  const cost = (value: unknown) => keysOf(value).has("costUsd");

  it("is left out of every new block for a plan user, however the price table prices", () => {
    const items = [buildItem(NOW - DAY, { reportedCostUsd: 3 })];
    const out = report(items, [plan(60)]);
    expect(cost(out.week)).toBe(false);
    expect(cost(out.stepModels)).toBe(false);
    expect(cost(out.agentModels)).toBe(false);
    expect(keysOf(out.week).has("costEstimated")).toBe(false);
    expect(itemUsageOf({ now: NOW, clis: [plan(60)], items, helperCalls: [], past: {} }, items[0]!.itemId)).not.toHaveProperty("costUsd");
  });

  it("is the CLI's figure for a pay-per-use login, estimated from the price table when the CLI gave none, with no limit, forecast or share", () => {
    const told = buildItem(NOW - 2 * DAY, { reportedCostUsd: 1.5 });
    const guessed = buildItem(NOW - DAY);
    const { week } = report([told, guessed], [perUse]);
    expect(week?.limits).toEqual([]);
    expect(keysOf(week).has("sharePercent")).toBe(false);
    expect(keysOf(week).has("tokamaPercent")).toBe(true);
    const row = week?.steps[0];
    expect(row?.costUsd).toBeCloseTo(5.5, 10);
    expect(row?.costEstimated).toBe(true);
    expect(week?.steps[0]?.items.map((i) => i.costUsd).sort()).toEqual([1.5, 4]);
    const exact = report([told], [perUse]).week?.steps[0];
    expect(exact?.costUsd).toBe(1.5);
    expect(exact).not.toHaveProperty("costEstimated");
  });
});

describe("retries", () => {
  it("rolls up the attempts that ran a step again by what failed, in the CLI's own part", () => {
    const failThenPass = (repoIds: RepoId[], command: string, base: number) =>
      item(
        [step("build", "checks pass", [attempt(1, "failed", base, [[command, false]]), attempt(2, "passed", base + HOUR, [[command, true]])])],
        [call({ stepId: "build", attempt: 1, endedAt: base, model: "claude-opus-5-5", tokens: MILLION }), call({ stepId: "build", attempt: 2, endedAt: base + HOUR, model: "claude-opus-5-5", tokens: MILLION })],
        { repoIds },
      );
    const sentBack = item(
      [step("build", "checks pass", [attempt(1, "passed", NOW - 4 * DAY, [["pnpm test", true]]), attempt(2, "passed", NOW - 3 * DAY, [["pnpm test", true]])]), step("review", "reviewer approves", [attempt(1, "failed", NOW - 4 * DAY + HOUR)], "reviewer")],
      [
        call({ stepId: "build", attempt: 1, endedAt: NOW - 4 * DAY, model: "claude-opus-5-5", tokens: MILLION }),
        call({ stepId: "review", attempt: 1, endedAt: NOW - 4 * DAY + HOUR, agentId: "reviewer" as never, model: "claude-opus-5-5", tokens: MILLION }),
        call({ stepId: "build", attempt: 2, endedAt: NOW - 3 * DAY, model: "claude-opus-5-5", tokens: MILLION }),
      ],
    );
    const unattributed = item([step("fix", "agent finishes", [attempt(1, "failed", NOW - 2 * DAY), attempt(2, "passed", NOW - 2 * DAY + HOUR)])], [call({ stepId: "fix", attempt: 1, endedAt: NOW - 2 * DAY, model: "claude-opus-5-5", tokens: MILLION }), call({ stepId: "fix", attempt: 2, endedAt: NOW - 2 * DAY + HOUR, model: "claude-opus-5-5", tokens: MILLION })]);
    const { week } = report(
      [
        failThenPass(["orders-api" as RepoId], "pnpm test", NOW - 5 * DAY + HOUR),
        failThenPass(["orders-api" as RepoId], "pnpm test", NOW - 3 * DAY),
        failThenPass(["checkout-web" as RepoId, "orders-api" as RepoId], "pnpm e2e", NOW - DAY),
        sentBack,
        unattributed,
      ],
      [plan(80)],
      { logs: { "claude-code": logs({ totals: () => [{ model: "claude-opus-5-5", tokens: { ...MILLION, input: 40_000_000 } }] }) } },
    );
    const [claude] = week?.retries ?? [];
    expect(claude?.cliId).toBe("claude-code");
    // Five retries of one million tokens each: three after a failed check, one after a send-back, one under no cause.
    expect(claude?.tokens).toBe(5_000_000 + 0);
    const causes = claude?.causes.map((c) => [c.kind, c.command, c.repoId, c.stepId, c.retries, c.itemCount]);
    expect(causes).toEqual(
      expect.arrayContaining([
        ["check", "pnpm test", "orders-api", "build", 2, 2],
        ["check", "pnpm e2e", undefined, "build", 1, 1],
        ["review", undefined, "orders-api", "build", 1, 1],
      ]),
    );
    expect(claude?.causes).toHaveLength(3);
    // The unattributed retry is in the total only.
    const causeTokens = claude?.causes.reduce((sum, c) => sum + c.tokens, 0);
    expect((claude?.tokens ?? 0) - (causeTokens ?? 0)).toBe(1_000_000);
  });
});

describe("the model records", () => {
  /** `count` items that pass Build on the first try, on `model`. */
  const runs = (model: string, count: number, agentId = "builder", first = true) =>
    Array.from({ length: count }, (_, n) => {
      const endedAt = NOW - (n + 1) * HOUR;
      return item(
        [step("build", "checks pass", first ? [attempt(1, "passed", endedAt, [["pnpm test", true]])] : [attempt(1, "failed", endedAt - 5 * 60_000, [["pnpm test", false]]), attempt(2, "passed", endedAt, [["pnpm test", true]])], agentId)],
        [call({ stepId: "build", attempt: 1, endedAt: endedAt - (first ? 0 : 5 * 60_000), model, agentId: agentId as never }), ...(first ? [] : [call({ stepId: "build", attempt: 2, endedAt, model, agentId: agentId as never })])],
      );
    });

  it("tells a model from its fifth run, and a step when two models have one", () => {
    const four = report([...runs("claude-sonnet-5-5", 5), ...runs("claude-opus-5-5", 4)], [plan(60)]);
    expect(four.stepModels).toEqual([]);
    const five = report([...runs("claude-sonnet-5-5", 5), ...runs("claude-opus-5-5", 5)], [plan(60)]);
    expect(five.stepModels).toHaveLength(1);
    expect(five.stepModels?.[0]).toMatchObject({ stepId: "build", stepName: "Build", templateId: "builtin/plan-and-build" });
    expect(five.stepModels?.[0]?.models.map((m) => [m.model, m.runs])).toEqual([["claude-sonnet-5-5", 5], ["claude-opus-5-5", 5]]);
  });

  it("keeps a model with enough runs beside one without, but the step needs two models with enough", () => {
    const out = report([...runs("claude-sonnet-5-5", 8), ...runs("claude-opus-5-5", 5), ...runs("claude-haiku-5-5", 4)], [plan(60)]);
    expect(out.stepModels?.[0]?.models.map((m) => m.model)).toEqual(["claude-sonnet-5-5", "claude-opus-5-5"]);
    expect(report([...runs("claude-sonnet-5-5", 8), ...runs("claude-opus-5-5", 4)], [plan(60)]).stepModels).toEqual([]);
  });

  it("counts first tries, attempts, tokens and time per run", () => {
    const out = report([...runs("claude-sonnet-5-5", 6), ...runs("claude-opus-5-5", 5, "builder", false)], [plan(60)]);
    const [sonnet, opus] = out.stepModels?.[0]?.models ?? [];
    expect(sonnet).toMatchObject({ runs: 6, firstTryPassed: 6, avgAttempts: 1, tokensPerRun: 11_000, durationMsPerRun: 600_000 });
    expect(opus).toMatchObject({ runs: 5, firstTryPassed: 0, avgAttempts: 2, tokensPerRun: 22_000 });
  });

  it("tells an agent with one model from its fifth run, and leaves out the first-try fact for a step without checks", () => {
    const out = report(runs("claude-sonnet-5-5", 5, "reviewer"), [plan(60)]);
    expect(out.stepModels).toEqual([]);
    expect(out.agentModels).toEqual([{ agentId: "reviewer", models: [expect.objectContaining({ model: "claude-sonnet-5-5", runs: 5, firstTryPassed: 5 })] }]);
    expect(report(runs("claude-sonnet-5-5", 4, "reviewer"), [plan(60)]).agentModels).toEqual([]);
    const noChecks = Array.from({ length: 5 }, (_, n) => item([step("fix", "agent finishes", [attempt(1, "passed", NOW - (n + 1) * HOUR)])], [call({ stepId: "fix", attempt: 1, endedAt: NOW - (n + 1) * HOUR })]));
    expect(report(noChecks, [plan(60)]).agentModels?.[0]?.models[0]).not.toHaveProperty("firstTryPassed");
  });

  it("looks back 90 days only", () => {
    const old = [...runs("claude-sonnet-5-5", 5), ...runs("claude-opus-5-5", 5)].map((i) => ({ ...i, steps: i.steps.map((s) => ({ ...s, attempts: s.attempts.map((a) => ({ ...a, endedAt: NOW - 91 * DAY })) })) }));
    expect(report(old, [plan(60)]).stepModels).toEqual([]);
  });

  it("tells the share of the limit a run took only from five runs in windows that were split, and the cost only for a login billed per use", () => {
    const items = [...runs("claude-sonnet-5-5", 5), ...runs("claude-opus-5-5", 5)];
    const out = report(items, [plan(60)]);
    expect(out.stepModels?.[0]?.models.every((m) => typeof m.sharePerRun === "number")).toBe(true);
    expect(keysOf(out.stepModels).has("costPerRun")).toBe(false);
    const billed = report(items, [perUse]);
    expect(keysOf(billed.stepModels).has("sharePerRun")).toBe(false);
    expect(billed.stepModels?.[0]?.models.every((m) => typeof m.costPerRun === "number")).toBe(true);
  });
});

describe("an item's use", () => {
  it("is its tokens, its part of each CLI's limit and the steps it repeated, with the failing check", () => {
    const base = NOW - 2 * DAY;
    const retried = item(
      [step("build", "checks pass", [attempt(1, "failed", base, [["pnpm test", false]]), attempt(2, "passed", base + HOUR, [["pnpm test", true]])])],
      [call({ stepId: "build", attempt: 1, endedAt: base, model: "claude-opus-5-5", tokens: MILLION }), call({ stepId: "build", attempt: 2, endedAt: base + HOUR, model: "claude-opus-5-5", tokens: MILLION })],
    );
    const other = buildItem(NOW - DAY, { tokens: { ...MILLION, input: 2_000_000 } });
    const input = { now: NOW, clis: [plan(80)], items: [retried, other], helperCalls: [], past: {}, logs: { "claude-code": logs({ totals: () => [{ model: "claude-opus-5-5", tokens: { ...MILLION, input: 5_000_000 } }] }) } };
    const usage = itemUsageOf(input, retried.itemId);
    // 8 of 20 logged weight is this item's: 80% used, so 32%; its part of Tokama's use is 8 of 16.
    expect(usage).toEqual({ tokens: 2_000_000, shares: [{ cliId: "claude-code", sharePercent: 32 }], retries: [{ stepId: "build", attempts: [2], tokensPercent: 50, failingCheck: "pnpm test" }] });
    expect(itemUsageOf(input, "item_0190a000-0000-7000-8000-ffffffffffff" as never)).toBeUndefined();
    expect(itemUsageOf({ ...input, items: [item([], [])] }, input.items[0]!.itemId)).toBeUndefined();
  });

  it("says the cost for a CLI billed per use, estimated when the CLI gave none", () => {
    const one = buildItem(NOW - DAY);
    expect(itemUsageOf({ now: NOW, clis: [perUse], items: [one], helperCalls: [], past: {} }, one.itemId)).toEqual({ tokens: 1_000_000, costUsd: 4, costEstimated: true });
  });
});

describe("the plan of a CLI", () => {
  it("is a plan the report can carry whole", () => {
    expect(CliPlanSchema.safeParse(plan(60)).success).toBe(true);
  });
});
