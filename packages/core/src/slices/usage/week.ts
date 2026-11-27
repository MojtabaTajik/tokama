// What used each AI CLI's limit, from Tokama's own recorded calls: the weekly window by step, item,
// helper and retry cause; each model's record per step and per agent; and one item's use. A share is
// always a part of that AI CLI's own limit and is told only where the window's use could be split
// between Tokama and the user's other sessions (see split.ts). Shares of different CLIs are never added.
import type { AgentCallUsage, AgentId, AiCliId, CliPlan, ItemId, ItemUsage, StepId, TokenUsage, UsageReport, UsageWindow } from "../../kernel/schemas/index.js";
import { callCost } from "./prices.js";
import { type Retry, type Run, type RunItem, retriesOf, runsOf } from "./runs.js";
import { type CallLogs, type Split, splitLimit, weigher, windowWeight } from "./split.js";
import type { HelperCallRow } from "./summary.js";
import { isWeekly, type PastWindow, windowStart } from "./window.js";

const DAY = 24 * 60 * 60_000;
// A reset time is not exact: the end of one weekly window and the start of the next are this close.
const SAME_MS = 60 * 60_000;
const MAX_STEPS = 100;
const MAX_ITEMS = 50;
const MAX_STEP_ITEMS = 5;
const MAX_HELPERS = 20;
const MAX_CAUSES = 20;
const MAX_MODELS = 20;
const MAX_GROUPS = 100;
/** A model has a record from this many runs. */
export const MIN_RUNS = 5;
const MODEL_DAYS = 90;

export interface WeekInput {
  readonly now: number;
  readonly clis: readonly CliPlan[];
  /** Every item with calls in the last 90 days. */
  readonly items: readonly RunItem[];
  readonly helperCalls: readonly HelperCallRow[];
  /** The weekly windows that are over, by AI CLI. */
  readonly past: Readonly<Partial<Record<AiCliId, readonly PastWindow[]>>>;
  /** The AI CLIs' own logs of their calls, by CLI. */
  readonly logs?: Readonly<Partial<Record<AiCliId, CallLogs>>>;
}

type Week = NonNullable<UsageReport["week"]>;

interface Span {
  readonly cliId: AiCliId;
  readonly from: number;
  readonly to: number;
  readonly limit?: { readonly window: string; readonly startsAt: number; readonly endsAt: number; readonly usedPercent: number };
  readonly split?: Split;
}

interface Tagged {
  readonly call: AgentCallUsage;
  readonly item?: RunItem;
}

const total = (t: TokenUsage): number => t.input + t.output + t.cacheRead + t.cacheWrite;
const round2 = (value: number): number => Math.round(value * 100) / 100;
const cut = (text: string, max: number): string => text.slice(0, max);
const nearly = (a: number, b: number): boolean => Math.abs(a - b) < SAME_MS;

/** The items by title, then id, so rows that weigh the same come out in the same order whatever order the engine listed the items in. */
const inOrder = (items: readonly RunItem[]): RunItem[] => [...items].sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0));

/** Everything Tokama's calls of the input: item calls with their item, then helper calls. */
function taggedOf(input: WeekInput): Tagged[] {
  return [...inOrder(input.items).flatMap((item) => item.calls.map((call) => ({ call, item }))), ...input.helperCalls.map(({ call }) => ({ call }))];
}

const callsIn = (all: readonly Tagged[], cliId: AiCliId, from: number, to: number): Tagged[] => all.filter(({ call }) => call.cliId === cliId && call.endedAt >= from && call.endedAt <= to);

function weeklyOf(plan: CliPlan) {
  return plan.billing === "pay_per_use" ? undefined : plan.windows.find((w) => isWeekly(w) && w.resetsAt !== undefined && windowStart(w) !== undefined);
}

/** The window of an AI CLI, with how it splits: from its weekly window, a past one, or the last 7 days. */
function spanOf(input: WeekInput, all: readonly Tagged[], plan: CliPlan, which: UsageWindow): Span {
  const { now, logs, past } = input;
  const weekly = weeklyOf(plan);
  const currentStart = weekly === undefined ? undefined : windowStart(weekly);
  if (which === "current") {
    if (weekly === undefined || currentStart === undefined) return { cliId: plan.cliId, from: now - 7 * DAY, to: now };
    const split = splitLimit(weekly.usedPercent, windowWeight(callsIn(all, plan.cliId, currentStart, now).map((t) => t.call), logs?.[plan.cliId], currentStart, now));
    return { cliId: plan.cliId, from: currentStart, to: now, limit: { window: weekly.window, startsAt: currentStart, endsAt: weekly.resetsAt!, usedPercent: weekly.usedPercent }, ...(split !== undefined && { split }) };
  }
  // The window that closed right before the running one; without a running one, the newest that closed.
  const entry =
    plan.billing === "pay_per_use"
      ? undefined
      : (past[plan.cliId] ?? []).filter((p) => p.endsAt <= (currentStart ?? now) + SAME_MS && (currentStart === undefined || nearly(p.endsAt, currentStart))).sort((a, b) => b.endsAt - a.endsAt)[0];
  if (entry === undefined) {
    // None is known: the 7 days before the running window, with no limit told.
    const end = currentStart ?? now - 7 * DAY;
    return { cliId: plan.cliId, from: end - 7 * DAY, to: end };
  }
  const split = splitLimit(entry.usedPercent, entry.weight);
  return { cliId: plan.cliId, from: entry.startsAt, to: entry.endsAt, limit: { window: entry.window, startsAt: entry.startsAt, endsAt: entry.endsAt, usedPercent: entry.usedPercent }, ...(split !== undefined && { split }) };
}

/** The weekly windows of an AI CLI that the shares of its runs can be told in: the running one and the past ones that were split. */
function splitSpans(input: WeekInput, all: readonly Tagged[], plan: CliPlan): Span[] {
  const spans: Span[] = [];
  const current = spanOf(input, all, plan, "current");
  if (current.split !== undefined) spans.push(current);
  for (const entry of plan.billing === "pay_per_use" ? [] : (input.past[plan.cliId] ?? [])) {
    const split = splitLimit(entry.usedPercent, entry.weight);
    if (split !== undefined) spans.push({ cliId: plan.cliId, from: entry.startsAt, to: entry.endsAt, limit: { window: entry.window, startsAt: entry.startsAt, endsAt: entry.endsAt, usedPercent: entry.usedPercent }, split });
  }
  return spans;
}

/** What a set of calls took in one span: tokens, a part of Tokama's use, a part of the limit, and for a CLI billed per use, the cost. */
interface Measure {
  readonly tokens: number;
  readonly tokamaPercent: number;
  readonly sharePercent?: number;
  readonly costUsd?: number;
  readonly costEstimated?: boolean;
}

function measurer(span: Span, spanCalls: readonly AgentCallUsage[], perUse: boolean): (calls: readonly AgentCallUsage[]) => Measure {
  const weight = weigher(spanCalls);
  const whole = spanCalls.reduce((sum, call) => sum + weight.of(call), 0);
  return (calls) => {
    let tokens = 0;
    let part = 0;
    let cost = 0;
    let known = false;
    let estimated = false;
    for (const call of calls) {
      tokens += total(call.tokens);
      part += weight.of(call);
      const c = perUse ? callCost(call) : null;
      if (c !== null) {
        known = true;
        cost += c;
        if (!(call.reportedCostUsd !== undefined && call.reportedCostUsd > 0) && c > 0) estimated = true;
      }
    }
    const tokamaPercent = whole > 0 ? Math.min(1000, round2((part / whole) * 100)) : 0;
    const rawShare = span.split !== undefined && weight.priced && whole > 0 ? (span.split.tokamaPercent * part) / whole : undefined;
    const share = rawShare !== undefined && Number.isFinite(rawShare) ? Math.min(1000, round2(rawShare)) : undefined;
    return {
      tokens,
      tokamaPercent,
      ...(share !== undefined && { sharePercent: share }),
      ...(known && { costUsd: cost }),
      ...(known && estimated && { costEstimated: true }),
    };
  };
}

const bySize = (a: { sharePercent?: number | undefined; tokens: number }, b: { sharePercent?: number | undefined; tokens: number }): number => (b.sharePercent ?? 0) - (a.sharePercent ?? 0) || b.tokens - a.tokens;

/**
 * The rows cut to `max`, largest first within each AI CLI. The cut takes the rows of each CLI in
 * turn, so a CLI with many rows never pushes another one out (their shares are parts of different limits).
 */
function capPerCli<T extends { cliId: AiCliId; sharePercent?: number | undefined; tokens: number }>(rows: readonly T[], max: number): T[] {
  const byCli = new Map<AiCliId, T[]>();
  for (const row of rows) byCli.set(row.cliId, [...(byCli.get(row.cliId) ?? []), row]);
  const lists = [...byCli.values()].map((list) => list.sort(bySize));
  const kept = new Set<T>();
  for (let rank = 0; kept.size < max && lists.some((list) => rank < list.length); rank++) {
    for (const list of lists) if (rank < list.length && kept.size < max) kept.add(list[rank]!);
  }
  return lists.flatMap((list) => list.filter((row) => kept.has(row)));
}

function group<T, K>(list: readonly T[], key: (value: T) => string, make: (value: T) => K): Map<string, { head: K; list: T[] }> {
  const groups = new Map<string, { head: K; list: T[] }>();
  for (const value of list) {
    const k = key(value);
    const found = groups.get(k);
    if (found === undefined) groups.set(k, { head: make(value), list: [value] });
    else found.list.push(value);
  }
  return groups;
}

export function buildWeek(input: WeekInput, which: UsageWindow): Week {
  const all = taggedOf(input);
  const ordered = inOrder(input.items);
  const runs = ordered.flatMap(runsOf);
  const retries = ordered.flatMap(retriesOf);
  const limits: Week["limits"] = [];
  const steps: Week["steps"] = [];
  const items: Week["items"] = [];
  const helpers: Week["helpers"] = [];
  const retryRows: Week["retries"] = [];

  for (const plan of input.clis) {
    const span = spanOf(input, all, plan, which);
    const perUse = plan.billing === "pay_per_use";
    const tagged = callsIn(all, plan.cliId, span.from, span.to);
    if (span.limit !== undefined) {
      limits.push({ cliId: plan.cliId, ...span.limit, ...(span.split !== undefined && { tokamaPercent: span.split.tokamaPercent, outsidePercent: span.split.outsidePercent }) });
    }
    if (tagged.length === 0) continue;
    const measure = measurer(span, tagged.map((t) => t.call), perUse);
    const mine = (run: Run) => run.cliId === plan.cliId && run.endedAt >= span.from && run.endedAt <= span.to;
    const spanRuns = runs.filter(mine);

    // Per workflow, step, agent and model.
    const itemCalls = tagged.filter((t): t is Tagged & { item: RunItem } => t.item !== undefined);
    const rows = group(
      itemCalls,
      ({ call, item }) => [item.templateId, call.stepId, call.agentId, call.cliId, call.model].join("\n"),
      ({ call, item }) => ({ templateId: item.templateId, stepId: call.stepId, agentId: call.agentId, model: call.model, stepName: item.steps.find((s) => s.id === call.stepId)?.name ?? call.stepId }),
    );
    for (const { head, list } of rows.values()) {
      const runsOfRow = spanRuns.filter((run) => run.item.templateId === head.templateId && run.step.id === head.stepId && run.agentId === head.agentId && run.model === head.model);
      const perItem = group(list, (t) => t.item.itemId, (t) => t.item);
      const measured = measure(list.map((t) => t.call));
      steps.push({
        templateId: cut(head.templateId, 200),
        stepId: head.stepId,
        stepName: cut(head.stepName, 100),
        agentId: head.agentId,
        cliId: plan.cliId,
        model: cut(head.model, 200),
        runs: runsOfRow.length,
        itemCount: perItem.size,
        ...measured,
        items: [...perItem.values()]
          .map(({ head: item, list: itemList }) => ({
            itemId: item.itemId,
            title: cut(item.title, 200),
            runs: runsOfRow.filter((run) => run.item === item).length,
            ...itemMeasure(measure(itemList.map((t) => t.call))),
          }))
          .sort(bySize)
          .slice(0, MAX_STEP_ITEMS),
      });
    }

    // Per item, over every step.
    for (const { head: item, list } of group(itemCalls, (t) => t.item.itemId, (t) => t.item).values()) {
      items.push({
        itemId: item.itemId,
        title: cut(item.title, 200),
        templateId: cut(item.templateId, 200),
        cliId: plan.cliId,
        runs: spanRuns.filter((run) => run.item === item).length,
        ...itemMeasure(measure(list.map((t) => t.call))),
      });
    }

    // Tokama's own helper calls.
    for (const { head, list } of group(tagged.filter((t) => t.item === undefined), (t) => t.call.model, (t) => t.call.model).values()) {
      const m = measure(list.map((t) => t.call));
      helpers.push({ cliId: plan.cliId, model: cut(head, 200), calls: list.length, tokens: m.tokens, ...(m.sharePercent !== undefined && { sharePercent: m.sharePercent }), ...(m.costUsd !== undefined && { costUsd: m.costUsd }) });
    }

    // What repeated attempts took.
    const spanRetries = retries.filter((r) => r.cliId === plan.cliId && r.endedAt >= span.from && r.endedAt <= span.to);
    if (spanRetries.length > 0) {
      const spent = measure(spanRetries.flatMap((r) => [...r.calls]));
      const causes = group(
        spanRetries.filter((r): r is Retry & { cause: NonNullable<Retry["cause"]> } => r.cause !== undefined),
        (r) => [r.cause.kind, r.cause.kind === "check" ? r.cause.command : "", r.item.repoIds.length === 1 ? r.item.repoIds[0] : "", r.item.templateId, r.step.id, r.agentId].join("\n"),
        (r) => r,
      );
      retryRows.push({
        cliId: plan.cliId,
        tokens: spent.tokens,
        ...(spent.sharePercent !== undefined && { sharePercent: spent.sharePercent }),
        causes: [...causes.values()]
          .map(({ head: r, list }) => {
            const m = measure(list.flatMap((x) => [...x.calls]));
            const repoId = r.item.repoIds.length === 1 ? r.item.repoIds[0] : undefined;
            return {
              kind: r.cause.kind,
              ...(r.cause.kind === "check" && { command: cut(r.cause.command, 500) }),
              ...(repoId !== undefined && { repoId }),
              templateId: cut(r.item.templateId, 200),
              stepId: r.step.id,
              agentId: r.agentId,
              retries: list.length,
              itemCount: new Set(list.map((x) => x.item.itemId)).size,
              tokens: m.tokens,
              ...(m.sharePercent !== undefined && { sharePercent: m.sharePercent }),
              ...(m.costUsd !== undefined && { costUsd: m.costUsd }),
            };
          })
          .sort(bySize)
          .slice(0, MAX_CAUSES),
      });
    }
  }

  return {
    window: which,
    limits: limits.slice(0, 10),
    steps: capPerCli(steps, MAX_STEPS),
    items: capPerCli(items, MAX_ITEMS),
    helpers: capPerCli(helpers, MAX_HELPERS),
    retries: retryRows.slice(0, 10),
  };
}

/** The fields an item row takes from a measure. */
function itemMeasure(m: Measure) {
  return { tokens: m.tokens, ...(m.sharePercent !== undefined && { sharePercent: m.sharePercent }), ...(m.costUsd !== undefined && { costUsd: m.costUsd }) };
}

type ModelRecord = NonNullable<UsageReport["stepModels"]>[number]["models"][number];

/** One model's record over a group of runs. */
function modelRecord(model: string, cliId: AiCliId, runs: readonly Run[], share: (run: Run) => number | undefined, perUse: boolean): ModelRecord {
  const attempts = runs.reduce((sum, run) => sum + run.attempts.length, 0);
  const checked = runs.every((run) => run.firstTry !== undefined);
  const shares = runs.map(share).filter((s): s is number => s !== undefined);
  const costs = perUse ? runs.map((run) => run.calls.map(callCost)).filter((cs) => cs.every((c) => c !== null)).map((cs) => cs.reduce<number>((sum, c) => sum + (c ?? 0), 0)) : [];
  return {
    model: cut(model, 200),
    cliId,
    runs: runs.length,
    ...(checked && { firstTryPassed: runs.filter((run) => run.firstTry === true).length }),
    avgAttempts: round2(attempts / runs.length),
    tokensPerRun: Math.round(runs.reduce((sum, run) => sum + run.calls.reduce((s, call) => s + total(call.tokens), 0), 0) / runs.length),
    // Told from 5 runs that fall in a window with a split, so a few runs never stand for the rest.
    ...(shares.length >= MIN_RUNS && { sharePerRun: round2(shares.reduce((a, b) => a + b, 0) / shares.length) }),
    ...(costs.length > 0 && { costPerRun: costs.reduce((a, b) => a + b, 0) / costs.length }),
    durationMsPerRun: Math.round(runs.reduce((sum, run) => sum + run.durationMs, 0) / runs.length),
  };
}

/**
 * Each model's record per step and per agent over the last 90 days. A model has a record from
 * 5 runs; a step is told only when two models have one, an agent when one has.
 */
export function buildModels(input: WeekInput): Pick<UsageReport, "stepModels" | "agentModels"> {
  const all = taggedOf(input);
  const since = input.now - MODEL_DAYS * DAY;
  const runs = inOrder(input.items).flatMap(runsOf).filter((run) => run.endedAt >= since && run.endedAt <= input.now);
  const spans = new Map(input.clis.map((plan) => [plan.cliId, splitSpans(input, all, plan)] as const));
  const billed = new Map(input.clis.map((plan) => [plan.cliId, plan.billing === "pay_per_use"] as const));
  // The part of the limit a run took: its calls' part of the window it ended in, when that window was split.
  const shares = new Map<AiCliId, ReadonlyMap<Span, (run: Run) => number | undefined>>();
  const shareOf = (run: Run): number | undefined => {
    let byCli = shares.get(run.cliId);
    if (byCli === undefined) {
      byCli = new Map((spans.get(run.cliId) ?? []).map((span) => {
        const measure = measurer(span, callsIn(all, run.cliId, span.from, span.to).map((t) => t.call), false);
        return [span, (r: Run) => measure(r.calls).sharePercent] as const;
      }));
      shares.set(run.cliId, byCli);
    }
    for (const [span, measure] of byCli) if (run.endedAt >= span.from && run.endedAt <= span.to) return measure(run);
    return undefined;
  };

  const models = (list: readonly Run[]): ModelRecord[] =>
    [...group(list, (run) => `${run.cliId}\n${run.model}`, (run) => ({ model: run.model, cliId: run.cliId })).values()]
      .filter(({ list: runsOfModel }) => runsOfModel.length >= MIN_RUNS)
      .map(({ head, list: runsOfModel }) => modelRecord(head.model, head.cliId, runsOfModel, shareOf, billed.get(head.cliId) === true))
      .sort((a, b) => b.runs - a.runs)
      .slice(0, MAX_MODELS);

  const stepModels = [...group(runs, (run) => `${run.item.templateId}\n${run.step.id}`, (run) => ({ templateId: run.item.templateId, stepId: run.step.id as StepId, stepName: run.step.name })).values()]
    .map(({ head, list }) => ({ ...head, templateId: cut(head.templateId, 200), stepName: cut(head.stepName, 100), models: models(list) }))
    .filter((step) => step.models.length >= 2)
    .sort((a, b) => b.models.reduce((s, m) => s + m.runs, 0) - a.models.reduce((s, m) => s + m.runs, 0))
    .slice(0, MAX_GROUPS);
  const agentModels = [...group(runs, (run) => run.agentId, (run) => run.agentId as AgentId).values()]
    .map(({ head, list }) => ({ agentId: head, models: models(list) }))
    .filter((agent) => agent.models.length >= 1)
    .sort((a, b) => b.models.reduce((s, m) => s + m.runs, 0) - a.models.reduce((s, m) => s + m.runs, 0))
    .slice(0, MAX_GROUPS);
  return { stepModels, agentModels };
}

/** What one item used: tokens, its part of each AI CLI's limit, and the attempts that repeated a step. Undefined when it has no calls. */
export function itemUsageOf(input: WeekInput, itemId: ItemId): ItemUsage | undefined {
  const item = input.items.find((i) => i.itemId === itemId);
  if (item === undefined || item.calls.length === 0) return undefined;
  const all = taggedOf(input);
  const tokens = item.calls.reduce((sum, call) => sum + total(call.tokens), 0);

  const shares: NonNullable<ItemUsage["shares"]> = [];
  let cost: number | undefined;
  let estimated = false;
  for (const plan of input.clis) {
    const calls = item.calls.filter((call) => call.cliId === plan.cliId);
    if (calls.length === 0) continue;
    // A part of the limit is told for one window: the latest one the item ran in. Parts of two windows are parts of two limits.
    let share: number | undefined;
    let latest = -1;
    for (const span of splitSpans(input, all, plan)) {
      const inSpan = calls.filter((call) => call.endedAt >= span.from && call.endedAt <= span.to);
      if (inSpan.length === 0 || span.to <= latest) continue;
      const part = measurer(span, callsIn(all, plan.cliId, span.from, span.to).map((t) => t.call), false)(inSpan).sharePercent;
      if (part !== undefined) {
        share = part;
        latest = span.to;
      }
    }
    if (share !== undefined) shares.push({ cliId: plan.cliId, sharePercent: Math.min(1000, round2(share)) });
    if (plan.billing === "pay_per_use") {
      for (const call of calls) {
        const c = callCost(call);
        if (c === null) continue;
        cost = (cost ?? 0) + c;
        if (!(call.reportedCostUsd !== undefined && call.reportedCostUsd > 0) && c > 0) estimated = true;
      }
    }
  }

  const bySteps = group(retriesOf(item), (r) => r.step.id, (r) => r.step.id);
  const retries = [...bySteps.values()].map(({ head, list }) => {
    const spent = list.reduce((sum, r) => sum + r.calls.reduce((s, call) => s + total(call.tokens), 0), 0);
    const failing = list.find((r) => r.cause?.kind === "check");
    return {
      stepId: head,
      attempts: list.map((r) => r.attempt).slice(0, 50),
      tokensPercent: tokens > 0 ? Math.min(100, round2((spent / tokens) * 100)) : 0,
      ...(failing?.cause?.kind === "check" && { failingCheck: cut(failing.cause.command, 500) }),
    };
  });
  return {
    tokens,
    ...(shares.length > 0 && { shares: shares.slice(0, 3) }),
    ...(cost !== undefined && { costUsd: cost, ...(estimated && { costEstimated: true }) }),
    ...(retries.length > 0 && { retries: retries.slice(0, 20) }),
  };
}
