// The rows of "What uses the weekly limits": the report's steps, grouped as the person chose, each
// measured in the one thing that means something for its AI tool: a part of the tool's own limit,
// a part of Tokama's use (no split known), money (pay per use) or tokens (a local model, which has
// no limit). Shares of different tools are never added: a workflow that ran on two tools is two rows.
import type { AiCliId, CliPlan, Setup, UsageReport } from "@tokama/core";
import { cliName } from "../model.js";
import { formatCost, formatTokens, isPayPerUse, limitShare, usePercent, workflowName } from "./usage-model.js";

type Week = NonNullable<UsageReport["week"]>;
type StepRow = Week["steps"][number];

export type Group = "step" | "workflow" | "item";
/** What a row is measured in. */
export type Unit = "limit" | "use" | "cost" | "tokens";

export interface Measure {
  readonly unit: Unit;
  /** The number the bar and the order follow. */
  readonly value: number;
  readonly text: string;
}

export interface SubRow extends Measure {
  readonly itemId: string;
  readonly title: string;
  readonly facts: string;
}

export interface Row extends Measure {
  readonly key: string;
  readonly kind: "step" | "workflow" | "item" | "helpers" | "outside";
  readonly cliId: AiCliId;
  readonly name: string;
  /** The agents of the row, each once: one for a step, several for a workflow or an item. */
  readonly agentIds?: readonly string[];
  readonly model?: string;
  readonly itemId?: string;
  readonly facts: string;
  readonly items?: readonly SubRow[];
  /** Items past the five listed: how many, and what they took together. */
  readonly more?: { readonly count: number; readonly text: string };
}

export interface Ranking {
  readonly header: string;
  readonly rows: readonly Row[];
  /** The longest bar of each kind of row: shares, money and tokens are never on one scale. */
  readonly scale: { readonly percent: number; readonly cost: number; readonly tokens: number };
}

/** A share of a limit and a part of use are both percents; money and tokens are each their own kind. */
export const kindOf = (unit: Unit): "percent" | "cost" | "tokens" => (unit === "limit" || unit === "use" ? "percent" : unit);
const KIND_ORDER = { percent: 0, cost: 1, tokens: 2 } as const;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const runsFacts = (runs: number, itemCount: number): string => `${plural(runs, "run")} · ${plural(itemCount, "item")}`;

interface Source {
  readonly cliId: AiCliId;
  readonly tokens: number;
  readonly tokamaPercent?: number;
  readonly sharePercent?: number | undefined;
  readonly costUsd?: number | undefined;
  readonly costEstimated?: boolean | undefined;
}

/** What a row of this tool is measured in, and how it reads. */
export function measure(source: Source, plan: CliPlan | undefined): Measure {
  if (isPayPerUse(plan) && source.costUsd !== undefined) return { unit: "cost", value: source.costUsd, text: formatCost(source.costUsd, source.costEstimated) };
  if (source.cliId === "ollama" || isPayPerUse(plan)) return { unit: "tokens", value: source.tokens, text: formatTokens(source.tokens) };
  if (source.sharePercent !== undefined) return { unit: "limit", value: source.sharePercent, text: limitShare(source.sharePercent) };
  const part = source.tokamaPercent ?? 0;
  return { unit: "use", value: part, text: usePercent(part) };
}

const sum = (rows: readonly (number | undefined)[]): number => rows.reduce<number>((total, value) => total + (value ?? 0), 0);
const known = (values: readonly (number | undefined)[]): number | undefined => (values.some((value) => value !== undefined) ? sum(values) : undefined);

function stepRow(step: StepRow, plan: CliPlan | undefined, setup: Setup | undefined): Row {
  const own = measure(step, plan);
  const itemMeasure = (item: StepRow["items"][number]): Measure =>
    measure({ cliId: step.cliId, tokens: item.tokens, sharePercent: item.sharePercent, costUsd: item.costUsd, costEstimated: step.costEstimated, tokamaPercent: step.tokens > 0 ? (step.tokamaPercent * item.tokens) / step.tokens : 0 }, plan);
  const items = step.items.map((item): SubRow => ({ ...itemMeasure(item), itemId: item.itemId, title: item.title, facts: plural(item.runs, "run") }));
  const left = step.itemCount - step.items.length;
  const rest = Math.max(0, own.value - sum(items.map((item) => item.value)));
  const restText = own.unit === "tokens" ? formatTokens(Math.round(rest)) : own.unit === "limit" ? limitShare(rest) : own.unit === "use" ? usePercent(rest) : formatCost(rest, step.costEstimated);
  return {
    ...own,
    key: `step:${step.templateId}:${step.stepId}:${step.agentId}:${step.cliId}:${step.model}`,
    kind: "step",
    cliId: step.cliId,
    name: `${workflowName(step.templateId, setup)} · ${step.stepName}`,
    agentIds: [step.agentId],
    model: step.model,
    facts: runsFacts(step.runs, step.itemCount),
    items,
    ...(left > 0 && { more: { count: left, text: restText } }),
  };
}

function workflowRows(steps: readonly StepRow[], plans: ReadonlyMap<AiCliId, CliPlan>, setup: Setup | undefined): Row[] {
  const groups = new Map<string, StepRow[]>();
  for (const step of steps) groups.set(`${step.templateId}\n${step.cliId}`, [...(groups.get(`${step.templateId}\n${step.cliId}`) ?? []), step]);
  return [...groups.values()].map((group): Row => {
    const first = group[0]!;
    const own = measure(
      {
        cliId: first.cliId,
        tokens: sum(group.map((step) => step.tokens)),
        tokamaPercent: sum(group.map((step) => step.tokamaPercent)),
        sharePercent: group.every((step) => step.sharePercent !== undefined) ? sum(group.map((step) => step.sharePercent)) : undefined,
        costUsd: known(group.map((step) => step.costUsd)),
        costEstimated: group.some((step) => step.costEstimated === true),
      },
      plans.get(first.cliId),
    );
    return {
      ...own,
      key: `workflow:${first.templateId}:${first.cliId}`,
      kind: "workflow",
      cliId: first.cliId,
      name: workflowName(first.templateId, setup),
      agentIds: [...new Set(group.map((step) => step.agentId))],
      facts: runsFacts(sum(group.map((step) => step.runs)), Math.max(...group.map((step) => step.itemCount))),
    };
  });
}

/** The ranking for the picked AI tool (all tools when `only` is undefined) and grouping. */
export function rankingOf(week: Week, clis: readonly CliPlan[], group: Group, only: AiCliId | undefined, setup: Setup | undefined): Ranking {
  const plans = new Map(clis.map((plan) => [plan.cliId, plan]));
  const shown = (cliId: AiCliId) => only === undefined || cliId === only;
  const rows: Row[] = [];
  if (group === "step") rows.push(...week.steps.filter((step) => shown(step.cliId)).map((step) => stepRow(step, plans.get(step.cliId), setup)));
  if (group === "workflow") rows.push(...workflowRows(week.steps.filter((step) => shown(step.cliId)), plans, setup));
  if (group === "item") {
    for (const item of week.items.filter((entry) => shown(entry.cliId))) {
      // Without a split, an item's part of Tokama's use of its tool is its part of the tokens.
      const toolTokens = week.steps.filter((step) => step.cliId === item.cliId).reduce((total, step) => total + step.tokens, 0);
      rows.push({
        ...measure({ cliId: item.cliId, tokens: item.tokens, sharePercent: item.sharePercent, costUsd: item.costUsd, tokamaPercent: toolTokens > 0 ? (item.tokens / toolTokens) * 100 : 0 }, plans.get(item.cliId)),
        key: `item:${item.itemId}:${item.cliId}`,
        kind: "item",
        cliId: item.cliId,
        name: item.title,
        itemId: item.itemId,
        agentIds: item.agents,
        facts: plural(item.runs, "run"),
      });
    }
  }
  for (const helper of week.helpers.filter((entry) => shown(entry.cliId))) {
    const own = measure({ cliId: helper.cliId, tokens: helper.tokens, sharePercent: helper.sharePercent, costUsd: helper.costUsd }, plans.get(helper.cliId));
    // Helpers have no part of Tokama's use told: tokens say what they took.
    const text = own.unit === "use" ? { unit: "tokens" as const, value: 0, text: formatTokens(helper.tokens) } : own;
    rows.push({ ...text, key: `helpers:${helper.cliId}:${helper.model}`, kind: "helpers", cliId: helper.cliId, name: "Tokama helpers", model: helper.model, facts: plural(helper.calls, "call") });
  }
  // Shares of a limit first, then money, then tokens (a local model has no limit): a number is only ranked against numbers of its own kind.
  rows.sort((a, b) => KIND_ORDER[kindOf(a.unit)] - KIND_ORDER[kindOf(b.unit)] || b.value - a.value || (a.key < b.key ? -1 : 1));
  const outside = week.limits.filter((limit) => shown(limit.cliId) && limit.outsidePercent !== undefined && !isPayPerUse(plans.get(limit.cliId)));
  for (const limit of outside) {
    rows.push({
      unit: "limit",
      value: limit.outsidePercent!,
      text: limitShare(limit.outsidePercent!),
      key: `outside:${limit.cliId}`,
      kind: "outside",
      cliId: limit.cliId,
      name: `Outside Tokama · ${cliName(limit.cliId)}`,
      facts: "your own sessions",
    });
  }
  const measured = rows.filter((row) => row.kind !== "outside");
  const limited = measured.some((row) => row.unit !== "tokens") || outside.length > 0;
  const has = (unit: Unit) => measured.some((row) => row.unit === unit);
  const header = (has("limit") || outside.length > 0) && has("cost") ? "Used" : has("limit") || outside.length > 0 ? "Weekly limit" : has("cost") ? "Cost" : has("use") ? "Of Tokama's use" : "Tokens";
  const shownRows = rows.map((row): Row => {
    // Next to rows with a limit, a row without one says so instead of showing tokens; a part of use says "of use".
    if (limited && row.unit === "tokens" && row.cliId === "ollama") return { ...row, text: "no limit" };
    if (header === "Weekly limit" && row.unit === "use") return { ...row, text: `${row.text} of use` };
    return row;
  });
  const max = (kind: "percent" | "cost" | "tokens") => Math.max(0, ...rows.filter((row) => kindOf(row.unit) === kind).map((row) => row.value));
  return { header, rows: shownRows, scale: { percent: max("percent"), cost: max("cost"), tokens: max("tokens") } };
}
