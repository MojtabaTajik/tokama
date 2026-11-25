// A usage report shaped like the fake engine's: 14 days ending at NOW over the test setup's
// workflows, Claude Code well inside its limits, Codex CLI near its weekly limit and Ollama
// without a plan. Local times, so the tests do not depend on the machine's time zone.
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
  totals: { tokens: tokens(300_000, 96_000, 500_000, 0), costUsd: 12.1, calls: 14, unpricedCalls: 2 },
} as unknown as UsageReport;
