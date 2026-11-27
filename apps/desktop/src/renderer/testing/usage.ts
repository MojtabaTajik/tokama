// Usage reports shaped like the fake engine's, at NOW (local times, so the tests do not depend on
// the machine's time zone). `planReport` is the page's main state: Claude Code on a Max plan whose
// weekly limit runs out before it resets, Codex CLI on pace, and Ollama without a plan. The others
// are the states the page draws beside it. model.test.ts checks every one against the engine schema.
import type { UsageReport } from "@tokama/core";
import { ITEMS, NOW } from "./sample.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const local = (day: number, hour: number, minute = 0) => new Date(2025, 9, day, hour, minute).getTime();
const tokens = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({ input, output, cacheRead, cacheWrite });

/** The value without the named keys: a field the state does not have is absent, not undefined. */
const omit = (value: object, ...keys: string[]): Record<string, unknown> => Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

const BUILD = { templateId: "builtin/plan-and-build", stepId: "build", agentId: "local-builder" };
const weeklyStart = local(16, 9);
const weeklyEnd = local(23, 9);
// 82% used 102 hours into a 168-hour window: the limit runs out at 100 hours / 0.82 in.
const runsOutAt = weeklyStart + Math.round((102 * HOUR * 100) / 82);

const claudeWindows = [
  { window: "session", usedPercent: 36, resetsAt: local(20, 17, 10), startsAt: local(20, 12, 10), forecast: { atResetPercent: 63.5 } },
  { window: "weekly_all", usedPercent: 82, resetsAt: weeklyEnd, startsAt: weeklyStart, forecast: { atResetPercent: 135.06, runsOutAt } },
  { window: "weekly_scoped", usedPercent: 47, resetsAt: weeklyEnd, startsAt: weeklyStart, scope: "Fable", sharePercent: 50, forecast: { atResetPercent: 77.4 } },
];

const claudeCode = { cliId: "claude-code", windows: claudeWindows, source: "request", asOf: NOW - 2 * MINUTE, plan: "max", version: "2.1.331", extraUsage: "off", billing: "plan" };
const codexCli = {
  cliId: "codex-cli",
  windows: [{ window: "seven_day", usedPercent: 30, resetsAt: local(25, 6), startsAt: local(18, 6), forecast: { atResetPercent: 88.4 } }],
  source: "request",
  asOf: NOW - 34 * MINUTE,
  plan: "plus",
  version: "0.169.0",
  billing: "plan",
};
const ollama = { cliId: "ollama", windows: [], note: "Local models have no plan limit." };

const item = (id: string, title: string, runs: number, shareTokens: number, sharePercent?: number) => ({ itemId: id, title, runs, tokens: shareTokens, ...(sharePercent !== undefined && { sharePercent }) });

const week = {
  window: "current",
  limits: [
    { cliId: "claude-code", window: "weekly_all", startsAt: weeklyStart, endsAt: weeklyEnd, usedPercent: 82, tokamaPercent: 62, outsidePercent: 20 },
    { cliId: "codex-cli", window: "seven_day", startsAt: local(18, 6), endsAt: local(25, 6), usedPercent: 30, tokamaPercent: 22, outsidePercent: 8 },
  ],
  steps: [
    {
      templateId: "builtin/plan-and-build",
      stepId: "review",
      stepName: "Review",
      agentId: "reviewer",
      cliId: "codex-cli",
      model: "gpt-5",
      runs: 21,
      itemCount: 12,
      tokens: 1_900_000,
      tokamaPercent: 66,
      sharePercent: 14.5,
      items: [item(ITEMS.verifying.id, ITEMS.verifying.title, 3, 400_000, 3.1)],
    },
    {
      templateId: "builtin/plan-and-build",
      stepId: "build",
      stepName: "Build",
      agentId: "local-builder",
      cliId: "claude-code",
      model: "sonnet",
      runs: 19,
      itemCount: 12,
      tokens: 3_000_000,
      tokamaPercent: 40,
      sharePercent: 24.8,
      items: [item(ITEMS.verifying.id, ITEMS.verifying.title, 3, 500_000, 5.1), item(ITEMS.working.id, ITEMS.working.title, 2, 300_000, 3.9), item(ITEMS.queued.id, ITEMS.queued.title, 1, 100_000, 1.8)],
    },
    {
      templateId: "builtin/plan-and-build",
      stepId: "plan",
      stepName: "Plan",
      agentId: "architect",
      cliId: "claude-code",
      model: "opus",
      runs: 14,
      itemCount: 12,
      tokens: 2_100_000,
      tokamaPercent: 30,
      sharePercent: 18.6,
      items: [],
    },
    {
      templateId: "builtin/emergency-investigator",
      stepId: "triage",
      stepName: "Triage",
      agentId: "local-builder",
      cliId: "ollama",
      model: "qwen3-coder:30b",
      runs: 6,
      itemCount: 3,
      tokens: 404_000,
      tokamaPercent: 100,
      items: [item(ITEMS.needsYou.id, ITEMS.needsYou.title, 2, 200_000)],
    },
  ],
  items: [
    { ...item(ITEMS.verifying.id, ITEMS.verifying.title, 6, 900_000, 8.2), templateId: "builtin/plan-and-build", cliId: "claude-code" },
    { ...item(ITEMS.needsYou.id, ITEMS.needsYou.title, 2, 200_000), templateId: "builtin/emergency-investigator", cliId: "ollama" },
  ],
  helpers: [{ cliId: "claude-code", model: "haiku", calls: 38, tokens: 120_000, sharePercent: 1 }],
  retries: [
    {
      cliId: "claude-code",
      tokens: 700_000,
      sharePercent: 14,
      causes: [
        { kind: "check", command: "pnpm test", repoId: "orders-api", ...BUILD, retries: 9, itemCount: 5, tokens: 400_000, sharePercent: 8 },
        { kind: "check", command: "pnpm e2e", repoId: "checkout-web", ...BUILD, retries: 4, itemCount: 2, tokens: 200_000, sharePercent: 4 },
        { kind: "review", ...BUILD, retries: 3, itemCount: 3, tokens: 100_000, sharePercent: 2 },
      ],
    },
  ],
};

const model = (name: string, cliId: string, runs: number, firstTryPassed: number, avgAttempts: number, sharePerRun: number, minutes: number) => ({
  model: name,
  cliId,
  runs,
  firstTryPassed,
  avgAttempts,
  tokensPerRun: Math.round(sharePerRun * 90_000),
  sharePerRun,
  durationMsPerRun: minutes * MINUTE,
});

const stepModels = [
  { templateId: "builtin/plan-and-build", stepId: "build", stepName: "Build", models: [model("sonnet", "claude-code", 46, 36, 1.3, 0.9, 11), model("opus", "claude-code", 12, 11, 1.1, 2.2, 14)] },
  { templateId: "builtin/quick-change", stepId: "change", stepName: "Change", models: [model("sonnet", "claude-code", 31, 27, 1.2, 0.4, 5), model("haiku", "claude-code", 9, 6, 1.6, 0.2, 6)] },
];

const agentModels = [
  { agentId: "local-builder", models: [model("sonnet", "claude-code", 58, 47, 1.3, 0.8, 11), model("opus", "claude-code", 12, 11, 1.1, 2.2, 14)] },
  { agentId: "reviewer", models: [model("gpt-5", "codex-cli", 21, 21, 1, 0.7, 4)] },
];

export const planReport = {
  asOf: NOW,
  pricesAsOf: "2026-11-03",
  clis: [claudeCode, codexCli, ollama],
  today: {
    items: [
      { itemId: ITEMS.verifying.id, title: ITEMS.verifying.title, agents: [{ agentId: "architect", cliId: "claude-code" }, { agentId: "reviewer", cliId: "codex-cli" }], tokens: 141_000, durationMs: 26 * MINUTE },
      { itemId: ITEMS.needsYou.id, title: ITEMS.needsYou.title, agents: [{ agentId: "local-builder", cliId: "claude-code" }], tokens: 63_000, durationMs: 18 * MINUTE },
    ],
    itemCount: 2,
    tokens: tokens(171_000, 23_000, 48_000, 0),
    durationMs: 44 * MINUTE,
  },
  week,
  stepModels,
  agentModels,
} as unknown as UsageReport;

/** The same, with Claude Code's weekly limit reached. */
export const atLimit = {
  ...planReport,
  clis: [{ ...claudeCode, windows: [claudeWindows[0], { window: "weekly_all", usedPercent: 100, resetsAt: weeklyEnd, startsAt: weeklyStart }] }, codexCli, ollama],
  week: { ...week, limits: [{ ...week.limits[0], usedPercent: 100, tokamaPercent: 78, outsidePercent: 22 }, week.limits[1]] },
} as unknown as UsageReport;

/** No limit reading yet: shares are of Tokama's own use, and no split or forecast is told. */
export const noReading = {
  ...planReport,
  clis: [{ cliId: "claude-code", windows: [], billing: "plan" }, { cliId: "codex-cli", windows: [] }, ollama],
  week: {
    ...week,
    limits: [],
    steps: week.steps.map((step) => omit(step, "sharePercent")),
    helpers: week.helpers.map((helper) => omit(helper, "sharePercent")),
    retries: week.retries.map((retry) => ({ ...omit(retry, "sharePercent"), causes: retry.causes.map((cause) => omit(cause, "sharePercent")) })),
  },
  stepModels: stepModels.map((group) => ({ ...group, models: group.models.map((record) => omit(record, "sharePerRun")) })),
} as unknown as UsageReport;

/** An API key: money in place of limit share; one call was priced from the table. */
export const payPerUse = {
  ...planReport,
  clis: [{ cliId: "claude-code", windows: [], billing: "pay_per_use", source: "run", asOf: NOW - MINUTE }, ollama],
  week: {
    window: "current",
    limits: [],
    steps: [
      { ...omit(week.steps[1]!, "sharePercent"), costUsd: 16.1 },
      { ...omit(week.steps[2]!, "sharePercent"), costUsd: 11.4 },
      { ...omit(week.steps[0]!, "sharePercent"), cliId: "claude-code", model: "claude-sonnet-5-5", costUsd: 2.7, costEstimated: true },
    ],
    items: [],
    helpers: [],
    retries: [],
  },
  stepModels: stepModels.map((group) => ({ ...group, models: group.models.map((record) => ({ ...omit(record, "sharePerRun"), costPerRun: 0.35 })) })),
  agentModels: undefined,
} as unknown as UsageReport;

/** Too few runs to compare models: the section and the agents' records are left out. */
export const fewRuns = { ...planReport, stepModels: undefined, agentModels: undefined } as unknown as UsageReport;

/** Nothing ran this week: limits and the forecast still show. */
export const quiet = {
  ...planReport,
  week: { window: "current", limits: week.limits.map((limit) => omit(limit, "tokamaPercent", "outsidePercent")), steps: [], items: [], helpers: [], retries: [] },
  stepModels: undefined,
  agentModels: undefined,
} as unknown as UsageReport;
