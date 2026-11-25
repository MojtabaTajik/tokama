// A usage report shaped like the fake engine's: 14 days ending at NOW over the test setup's
// workflows, Claude Code well inside its limits, Codex CLI near its weekly limit and Ollama
// without a plan. `allReport` is the same range counted over every Claude Code call on this
// machine. Local times, so the tests do not depend on the machine's time zone.
// model.test.ts checks it against the engine schema.
import type { UsageReport } from "@tokama/core";
import { ITEMS, NOW } from "./sample.js";

const MINUTE = 60_000;
const local = (day: number, hour: number, minute = 0) => new Date(2025, 9, day, hour, minute).getTime();
const date = (day: number) => `2025-10-${String(day).padStart(2, "0")}`;
const tokens = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({ input, output, cacheRead, cacheWrite });

const day = (n: number, workflows: UsageReport["days"][number]["workflows"]) => ({ date: date(n), workflows });
const exportItem = { itemId: ITEMS.verifying.id, title: ITEMS.verifying.title };
const outage = { itemId: ITEMS.needsYou.id, title: ITEMS.needsYou.title };

export const usageReport = {
  range: 14,
  asOf: NOW,
  pricesAsOf: "2026-11-03",
  clis: [
    {
      cliId: "claude-code",
      windows: [
        { window: "five_hour", usedPercent: 36, resetsAt: local(20, 17, 10) },
        { window: "seven_day", usedPercent: 58, resetsAt: local(23, 9) },
      ],
      source: "request",
      asOf: NOW - 2 * MINUTE,
      plan: "max",
      version: "2.1.331",
      extraUsage: "off",
    },
    { cliId: "codex-cli", windows: [{ window: "seven_day", usedPercent: 84, resetsAt: local(25, 6) }], source: "request", asOf: NOW - 34 * MINUTE, version: "0.169.0" },
    { cliId: "ollama", windows: [], note: "Local models have no plan limit." },
  ],
  days: [
    ...Array.from({ length: 12 }, (_, i) =>
      day(7 + i, i % 3 === 0 ? [{ templateId: "builtin/plan-and-build", tokens: 120_000 + i * 1000, costUsd: 2 + i / 10, items: [exportItem], itemCount: 1 }] : []),
    ),
    day(19, [{ templateId: "builtin/emergency-investigator", tokens: 90_000, costUsd: 0, items: [outage], itemCount: 1 }]),
    day(20, [
      { templateId: "builtin/plan-and-build", tokens: 186_000, costUsd: 3.1, items: [exportItem], itemCount: 1 },
      { templateId: "builtin/emergency-investigator", tokens: 114_000, costUsd: 0.4, items: [outage], itemCount: 1 },
    ]),
  ],
  workflows: [
    { templateId: "builtin/plan-and-build", tokens: 692_000, costUsd: 11.7, calls: 9 },
    { templateId: "builtin/emergency-investigator", tokens: 204_000, costUsd: 0.4, calls: 5 },
  ],
  items: [
    {
      itemId: ITEMS.verifying.id,
      title: ITEMS.verifying.title,
      templateId: "builtin/plan-and-build",
      agents: [
        { agentId: "architect", cliId: "claude-code" },
        { agentId: "reviewer", cliId: "codex-cli" },
      ],
      tokens: tokens(40_000, 23_000, 100_000, 0),
      durationMs: 29 * MINUTE,
      costUsd: 3.1,
      local: false,
    },
    {
      itemId: ITEMS.needsYou.id,
      title: ITEMS.needsYou.title,
      templateId: "builtin/emergency-investigator",
      agents: [{ agentId: "local-builder", cliId: "ollama" }],
      tokens: tokens(90_000, 28_000, 0, 0),
      durationMs: 41 * MINUTE,
      costUsd: 0,
      local: true,
    },
  ],
  today: {
    items: [
      { itemId: ITEMS.verifying.id, title: ITEMS.verifying.title, agents: [{ agentId: "architect", cliId: "claude-code" }, { agentId: "reviewer", cliId: "codex-cli" }], tokens: 141_000, durationMs: 26 * MINUTE },
      { itemId: ITEMS.needsYou.id, title: ITEMS.needsYou.title, agents: [{ agentId: "local-builder", cliId: "claude-code" }], tokens: 63_000, durationMs: 18 * MINUTE },
    ],
    itemCount: 2,
    tokens: tokens(171_000, 23_000, 48_000, 0),
    durationMs: 44 * MINUTE,
  },
  totals: { tokens: tokens(300_000, 96_000, 500_000, 0), costUsd: 12.1, calls: 14, unpricedCalls: 2 },
  scope: "tokama",
  tokenSummary: { processed: 896_000, cachedInput: 500_000, cachedInputPercent: 62.5, uncachedInput: 300_000, output: 96_000, cacheSavingsUsd: 2.25, cacheSavingsFactor: 10 },
  models: [
    { model: "claude-opus-5-5", cliId: "claude-code", tokens: 692_000, costUsd: 11.7, sharePercent: 96.7 },
    { model: "gpt-5-codex", cliId: "codex-cli", tokens: 86_000, costUsd: 0.4, sharePercent: 3.3 },
    { model: "qwen3-coder:30b", cliId: "ollama", tokens: 118_000, costUsd: null, sharePercent: null },
  ],
  repos: [
    { repoId: "orders-api", tokens: 692_000, costUsd: 11.7 },
    { repoId: "checkout-web", tokens: 204_000, costUsd: 0.4 },
  ],
} as unknown as UsageReport;

/** Every Claude Code call on this machine from its logs, plus Tokama's calls on other CLIs. */
export const allReport = {
  ...usageReport,
  scope: "all",
  days: usageReport.days.map((d) => ({ ...d, tokens: 160_000_000, costUsd: 120 })),
  totals: { tokens: tokens(38_600_000, 6_900_000, 2_290_000_000, 4_000_000), costUsd: 1755, calls: 24_400, unpricedCalls: 0 },
  tokenSummary: { processed: 2_339_500_000, cachedInput: 2_290_000_000, cachedInputPercent: 98.2, uncachedInput: 42_600_000, output: 6_900_000, cacheSavingsUsd: 6180, cacheSavingsFactor: 4.5 },
  models: [
    { model: "claude-opus-5-5", cliId: "claude-code", tokens: 1_020_000_000, costUsd: 1120, sharePercent: 63.8 },
    { model: "claude-sonnet-5-5", cliId: "claude-code", tokens: 1_210_000_000, costUsd: 541, sharePercent: 30.8 },
    { model: "claude-haiku-5-5", cliId: "claude-code", tokens: 110_000_000, costUsd: 94, sharePercent: 5.4 },
  ],
  repos: [
    { repoId: "orders-api", tokens: 1_210_000_000, costUsd: 905 },
    { repoId: "checkout-web", tokens: 710_000_000, costUsd: 534 },
    { repoId: null, tokens: 420_000_000, costUsd: 316 },
  ],
  scan: { state: "ready", filesDone: 684, filesTotal: 684, asOf: NOW },
} as unknown as UsageReport;

/** The same report with Claude Code's `limits` list: session, weekly, and a weekly limit for one model. */
export const limitsReport = {
  ...usageReport,
  clis: usageReport.clis.map((cli) =>
    cli.cliId === "claude-code"
      ? {
          ...cli,
          windows: [
            { window: "session", usedPercent: 63, resetsAt: local(20, 17, 10), group: "session", severity: "normal", active: true },
            { window: "weekly_all", usedPercent: 41, resetsAt: local(23, 9), group: "weekly", severity: "normal", active: false },
            { window: "weekly_scoped", usedPercent: 0, resetsAt: local(23, 9), scope: "Fable", group: "weekly", severity: "normal", active: false, sharePercent: 50 },
          ],
        }
      : cli,
  ),
} as unknown as UsageReport;
