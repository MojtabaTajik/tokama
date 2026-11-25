// The usage report: the recorded calls of the range rolled up by day, workflow and item, with
// estimated costs. Days are the engine's local days, the same machine the desktop app runs on.
import type { AgentCallUsage, CliPlan, ItemId, LogScan, RepoId, TokenUsage, UsageRange, UsageReport, UsageScope } from "../../kernel/schemas/index.js";
import { breakdown, callEntries, type UsageEntry } from "./breakdown.js";
import { callCost, PRICES_AS_OF } from "./prices.js";

/** One recorded call with the item it belongs to. */
export interface UsageRow {
  readonly itemId: ItemId;
  readonly title: string;
  /** The workflow key exactly as the item record carries it. */
  readonly templateId: string;
  /** The item's first repo. */
  readonly repoId?: RepoId;
  readonly call: AgentCallUsage;
}

export interface SummaryInput {
  readonly rows: readonly UsageRow[];
  readonly range: UsageRange;
  readonly now: number;
  readonly clis: readonly CliPlan[];
  /**
   * With a scope, the report also has per-day totals, the token summary and the model and repo
   * tables for it. In the `all` scope, `logs` holds Claude Code's usage from its own logs, which
   * include the Claude Code calls Tokama ran from `logsFrom` on: those rows are not counted again.
   * Earlier ones (Claude Code deletes old logs), or all of them without `logsFrom`, still count.
   */
  readonly scope?: UsageScope;
  readonly logs?: readonly UsageEntry[];
  readonly logsFrom?: number;
  readonly scan?: LogScan;
}

const DAY_ITEMS = 5;
const TOP_ITEMS = 50;
const NO_TOKENS: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const add = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});
export const totalTokens = (t: TokenUsage): number => t.input + t.output + t.cacheRead + t.cacheWrite;
/** Null stays null only while nothing is known; a known part counts. */
const addCost = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : a + b);

/** `YYYY-MM-DD` of the local day `at` falls in. */
export function localDate(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Midnight, local time, of the first day of a range that ends today. */
export function rangeStart(now: number, range: UsageRange): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (range - 1)).getTime();
}

export function summarizeUsage({ rows, range, now, clis, scope, logs = [], logsFrom, scan }: SummaryInput): UsageReport {
  const start = rangeStart(now, range);
  const inRange = rows.filter((row) => row.call.endedAt >= start && row.call.endedAt <= now);

  // Every day of the range, oldest first, so a quiet day is still a column.
  const dates: string[] = [];
  const first = new Date(start);
  for (let i = 0; i < range; i++) dates.push(localDate(new Date(first.getFullYear(), first.getMonth(), first.getDate() + i).getTime()));

  type Group = { tokens: number; costUsd: number | null; items: Map<ItemId, { title: string; tokens: number }> };
  const byDay = new Map<string, Map<string, Group>>(dates.map((date) => [date, new Map()]));
  const byWorkflow = new Map<string, { tokens: number; costUsd: number | null; calls: number }>();
  type ItemTotal = { itemId: ItemId; title: string; templateId: string; agents: Map<string, AgentCallUsage["cliId"]>; tokens: TokenUsage; durationMs: number; costUsd: number | null; local: boolean };
  const byItem = new Map<ItemId, ItemTotal>();
  let tokens = NO_TOKENS;
  let costUsd: number | null = null;
  let unpricedCalls = 0;

  for (const { itemId, title, templateId, call } of inRange) {
    const total = totalTokens(call.tokens);
    const cost = callCost(call);
    if (cost === null) unpricedCalls++;
    tokens = add(tokens, call.tokens);
    costUsd = addCost(costUsd, cost);

    const day = byDay.get(localDate(call.endedAt));
    if (day !== undefined) {
      const group = day.get(templateId) ?? { tokens: 0, costUsd: null, items: new Map() };
      group.tokens += total;
      group.costUsd = addCost(group.costUsd, cost);
      const item = group.items.get(itemId) ?? { title, tokens: 0 };
      item.tokens += total;
      group.items.set(itemId, item);
      day.set(templateId, group);
    }

    const workflow = byWorkflow.get(templateId) ?? { tokens: 0, costUsd: null, calls: 0 };
    workflow.tokens += total;
    workflow.costUsd = addCost(workflow.costUsd, cost);
    workflow.calls++;
    byWorkflow.set(templateId, workflow);

    const item = byItem.get(itemId) ?? { itemId, title, templateId, agents: new Map(), tokens: NO_TOKENS, durationMs: 0, costUsd: null, local: true };
    if (!item.agents.has(call.agentId)) item.agents.set(call.agentId, call.cliId);
    item.tokens = add(item.tokens, call.tokens);
    item.durationMs += call.endedAt - call.startedAt;
    item.costUsd = addCost(item.costUsd, cost);
    item.local &&= call.cliId === "ollama";
    byItem.set(itemId, item);
  }

  const byTokens = <T extends { tokens: number }>(a: T, b: T) => b.tokens - a.tokens;
  const totals = { tokens, costUsd, calls: inRange.length, unpricedCalls };
  const report: UsageReport = {
    range,
    asOf: now,
    pricesAsOf: PRICES_AS_OF,
    clis: [...clis],
    days: dates.map((date) => ({
      date,
      workflows: [...(byDay.get(date) ?? new Map<string, Group>())].map(([templateId, group]) => {
        const items = [...group.items].map(([itemId, item]) => ({ itemId, ...item })).sort(byTokens);
        return { templateId, tokens: group.tokens, costUsd: group.costUsd, items: items.slice(0, DAY_ITEMS).map(({ itemId, title }) => ({ itemId, title })), itemCount: items.length };
      }),
    })),
    workflows: [...byWorkflow].map(([templateId, w]) => ({ templateId, ...w })).sort(byTokens),
    items: [...byItem.values()]
      .sort((a, b) => totalTokens(b.tokens) - totalTokens(a.tokens))
      .slice(0, TOP_ITEMS)
      .map(({ agents, ...item }) => ({ ...item, agents: [...agents].map(([agentId, cliId]) => ({ agentId: agentId as AgentCallUsage["agentId"], cliId })) })),
    totals,
  };
  if (scope === undefined) return report;

  const days = new Set(dates);
  const entries =
    scope === "tokama"
      ? inRange.flatMap((row) => callEntries(row, localDate(row.call.endedAt)))
      : [
          ...logs.filter((entry) => days.has(entry.day)),
          ...inRange
            .filter((row) => row.call.cliId !== "claude-code" || logsFrom === undefined || row.call.endedAt < logsFrom)
            .flatMap((row) => callEntries(row, localDate(row.call.endedAt))),
        ];
  const parts = breakdown(entries);
  return {
    ...report,
    scope,
    days: report.days.map((day) => {
      const part = parts.days.get(day.date);
      return { ...day, tokens: part?.tokens ?? 0, costUsd: part?.costUsd ?? null };
    }),
    // Tokama's own totals keep each call's cost exactly as the call has it.
    totals: scope === "tokama" ? totals : parts.totals,
    tokenSummary: parts.tokenSummary,
    models: parts.models,
    repos: parts.repos,
    ...(scan !== undefined && { scan }),
  };
}
