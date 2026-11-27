// The lists of "What uses the weekly limits": one list per AI tool, each with its own measure, bar
// scale and order, because a bar and a sort only mean something inside one measure. A tool's rows
// (the report's steps, grouped as the person chose) are measured in the one thing that means
// something for the tool: a part of its own limit, a part of Tokama's use (no split known), money
// (pay per use) or tokens (a local model, which has no limit). Rows of two tools never share a list.
import type { AiCliId, CliPlan, Setup, UsageReport } from "@tokama/core";
import { cliName } from "../model.js";
import { formatCost, formatTokens, isPayPerUse, limitShare, liveWindows, usePercent, workflowName } from "./usage-model.js";

type Week = NonNullable<UsageReport["week"]>;
type StepRow = Week["steps"][number];

export type Group = "step" | "workflow" | "item";
/** What a row is measured in. */
export type Unit = "limit" | "use" | "cost" | "tokens";

/** A list shows this many rows, then "Show all". */
export const LIST_ROWS = 8;

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
  /** The model's full id, for a step or helpers row. */
  readonly model?: string;
  readonly itemId?: string;
  readonly facts: string;
  readonly items?: readonly SubRow[];
  /** Items past the five listed: how many, and what they took together. */
  readonly more?: { readonly count: number; readonly text: string };
}

/** What the heading line of a list says: where the limit stands, or why there is none. */
export type Heading =
  | { readonly kind: "split"; readonly tokama: number; readonly outside: number; readonly left: number }
  | { readonly kind: "text"; readonly text: string };

export interface ToolList {
  readonly cliId: AiCliId;
  readonly heading: Heading;
  /** The column head of the measure: "Weekly limit", "Of Tokama's use", "Tokens", "Cost". */
  readonly header: string;
  /** Every row of the tool, most first; the list shows the first `LIST_ROWS` until asked for all. */
  readonly rows: readonly Row[];
  /** "Outside Tokama": the last row, on the list's bar scale. */
  readonly outside?: Row;
  /** The longest bar of the list, outside row included. */
  readonly scale: number;
}

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
    measure({ cliId: step.cliId, tokens: item.tokens, sharePercent: item.sharePercent, costUsd: item.costUsd, costEstimated: step.costEstimated, tokamaPercent: item.tokamaPercent }, plan);
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

function workflowRows(steps: readonly StepRow[], plan: CliPlan | undefined, setup: Setup | undefined): Row[] {
  const groups = new Map<string, StepRow[]>();
  for (const step of steps) groups.set(step.templateId, [...(groups.get(step.templateId) ?? []), step]);
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
      plan,
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

/** The heading of a tool's list: the split bar when Tokama knows its part of the limit, else one sentence saying why not. */
function headingOf(plan: CliPlan | undefined, cliId: AiCliId, limit: Week["limits"][number] | undefined): Heading {
  if (limit?.tokamaPercent !== undefined && limit.outsidePercent !== undefined) {
    return { kind: "split", tokama: limit.tokamaPercent, outside: limit.outsidePercent, left: Math.max(0, 100 - limit.usedPercent) };
  }
  if (cliId === "ollama") return { kind: "text", text: "no plan limits · rows count tokens" };
  if (isPayPerUse(plan)) return { kind: "text", text: "billed per use · rows show what each call cost" };
  const used = limit?.usedPercent ?? liveWindows(plan, Number.MIN_SAFE_INTEGER).find((w) => w.window === "weekly_all" || w.window === "seven_day")?.usedPercent;
  const where = used === undefined ? "no limit reading yet" : `weekly limit ${Math.round(used)}% used`;
  return { kind: "text", text: `${where} · Tokama's part of it is not known for this tool, so rows are a share of what Tokama used on it` };
}

const HEADERS: Readonly<Record<Unit, string>> = { limit: "Weekly limit", use: "Of Tokama's use", cost: "Cost", tokens: "Tokens" };

/** How soon a tool's limit runs out: a limit already reached first, then the earliest run-out, then the rest; tools without a limit last. */
function urgency(plan: CliPlan | undefined, cliId: AiCliId, now: number): number {
  if (cliId === "ollama") return 3e15;
  if (isPayPerUse(plan)) return 2e15;
  const windows = liveWindows(plan, now);
  if (windows.some((w) => w.usedPercent >= 100)) return -1;
  const runsOut = windows.flatMap((w) => (w.forecast?.runsOutAt === undefined ? [] : [w.forecast.runsOutAt]));
  return runsOut.length > 0 ? Math.min(...runsOut) : 1e15;
}

/** The lists for the picked AI tool (all tools when `only` is undefined), most urgent tool first. */
export function listsOf(week: Week, clis: readonly CliPlan[], group: Group, only: AiCliId | undefined, setup: Setup | undefined, now: number): ToolList[] {
  const plans = new Map(clis.map((plan) => [plan.cliId, plan]));
  const cliIds = new Set<AiCliId>([...week.steps.map((s) => s.cliId), ...week.items.map((i) => i.cliId), ...week.helpers.map((h) => h.cliId)]);
  const lists: ToolList[] = [];
  for (const cliId of [...cliIds].filter((id) => only === undefined || id === only)) {
    const plan = plans.get(cliId);
    const steps = week.steps.filter((step) => step.cliId === cliId);
    const rows: Row[] = [];
    if (group === "step") rows.push(...steps.map((step) => stepRow(step, plan, setup)));
    if (group === "workflow") rows.push(...workflowRows(steps, plan, setup));
    if (group === "item") {
      for (const item of week.items.filter((entry) => entry.cliId === cliId)) {
        rows.push({
          ...measure({ cliId, tokens: item.tokens, sharePercent: item.sharePercent, costUsd: item.costUsd, tokamaPercent: item.tokamaPercent }, plan),
          key: `item:${item.itemId}`,
          kind: "item",
          cliId,
          name: item.title,
          itemId: item.itemId,
          agentIds: item.agents,
          facts: plural(item.runs, "run"),
        });
      }
    }
    for (const helper of week.helpers.filter((entry) => entry.cliId === cliId)) {
      rows.push({
        ...measure({ cliId, tokens: helper.tokens, sharePercent: helper.sharePercent, costUsd: helper.costUsd, tokamaPercent: helper.tokamaPercent }, plan),
        key: `helpers:${cliId}:${helper.model}`,
        kind: "helpers",
        cliId,
        name: "Tokama helpers",
        model: helper.model,
        facts: plural(helper.calls, "call"),
      });
    }
    rows.sort((a, b) => b.value - a.value || (a.key < b.key ? -1 : 1));
    const limit = week.limits.find((entry) => entry.cliId === cliId);
    const outside: Row | undefined =
      limit?.outsidePercent === undefined || isPayPerUse(plan)
        ? undefined
        : { unit: "limit", value: limit.outsidePercent, text: limitShare(limit.outsidePercent), key: `outside:${cliId}`, kind: "outside", cliId, name: "Outside Tokama", facts: "your own sessions" };
    if (rows.length === 0 && outside === undefined) continue;
    lists.push({
      cliId,
      heading: headingOf(plan, cliId, limit),
      header: HEADERS[(rows[0] ?? outside)!.unit],
      rows,
      ...(outside !== undefined && { outside }),
      scale: Math.max(0, ...rows.map((row) => row.value), outside?.value ?? 0),
    });
  }
  return lists.sort((a, b) => urgency(plans.get(a.cliId), a.cliId, now) - urgency(plans.get(b.cliId), b.cliId, now) || cliName(a.cliId).localeCompare(cliName(b.cliId)));
}
