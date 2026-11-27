// The usage report: each AI CLI's plan, today's calls, what used each limit in a week and each
// model's record, from the recorded calls. Days are the engine's local days, the same machine the
// desktop app runs on.
import type { AgentCallUsage, CliPlan, HelperId, ItemId, TokenUsage, UsageReport, UsageWindow } from "../../kernel/schemas/index.js";
import { PRICES_AS_OF } from "./prices.js";
import { buildModels, buildWeek, type WeekInput } from "./week.js";

/** One recorded call with the item it belongs to. */
export interface UsageRow {
  readonly itemId: ItemId;
  readonly title: string;
  readonly call: AgentCallUsage;
}

/** One recorded call of a Tokama helper (no item): `call.stepId` is the helper's id. */
export interface HelperCallRow {
  readonly helperId: HelperId;
  readonly call: AgentCallUsage;
}

export interface SummaryInput {
  readonly rows: readonly UsageRow[];
  /** Tokama's helper calls. They count in today's figures but in no item. */
  readonly helperCalls?: readonly HelperCallRow[];
  readonly now: number;
  readonly clis: readonly CliPlan[];
  /**
   * With it, the report also has the `week` block and the model records. `items` are the items with
   * calls in the last 90 days, `past` the weekly windows that are over, `logs` the AI CLIs' own
   * records of their calls (to split a limit between Tokama and everything else on the machine).
   */
  readonly week?: Pick<WeekInput, "items" | "past" | "logs"> & { readonly window?: UsageWindow };
}

const TODAY_ITEMS = 5;
const MAX_AGENTS = 20;
const NO_TOKENS: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const add = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});
const totalTokens = (t: TokenUsage): number => t.input + t.output + t.cacheRead + t.cacheWrite;

/** `YYYY-MM-DD` of the local day `at` falls in. */
export function localDate(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function summarizeUsage({ rows, helperCalls = [], now, clis, week }: SummaryInput): UsageReport {
  const todayDate = localDate(now);
  const isToday = (call: AgentCallUsage) => call.endedAt <= now && localDate(call.endedAt) === todayDate;

  type TodayItem = { itemId: ItemId; title: string; agents: Map<string, AgentCallUsage["cliId"]>; tokens: number; durationMs: number };
  const todayItems = new Map<ItemId, TodayItem>();
  let todayTokens = NO_TOKENS;
  let todayMs = 0;
  for (const { itemId, title, call } of rows) {
    if (!isToday(call)) continue;
    const item = todayItems.get(itemId) ?? { itemId, title, agents: new Map(), tokens: 0, durationMs: 0 };
    if (!item.agents.has(call.agentId)) item.agents.set(call.agentId, call.cliId);
    item.tokens += totalTokens(call.tokens);
    item.durationMs += call.endedAt - call.startedAt;
    todayItems.set(itemId, item);
    todayTokens = add(todayTokens, call.tokens);
    todayMs += call.endedAt - call.startedAt;
  }
  for (const { call } of helperCalls) {
    if (!isToday(call)) continue;
    todayTokens = add(todayTokens, call.tokens);
    todayMs += call.endedAt - call.startedAt;
  }

  const weekInput: WeekInput | undefined = week && { now, clis, helperCalls, items: week.items, past: week.past, ...(week.logs !== undefined && { logs: week.logs }) };
  // The report keeps at most 20 agents per item.
  const agentList = (agents: Map<string, AgentCallUsage["cliId"]>) => [...agents].slice(0, MAX_AGENTS).map(([agentId, cliId]) => ({ agentId: agentId as AgentCallUsage["agentId"], cliId }));
  return {
    asOf: now,
    pricesAsOf: PRICES_AS_OF,
    clis: [...clis],
    today: {
      items: [...todayItems.values()]
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, TODAY_ITEMS)
        .map(({ agents, ...item }) => ({ ...item, agents: agentList(agents) })),
      itemCount: todayItems.size,
      tokens: todayTokens,
      durationMs: todayMs,
    },
    ...(weekInput !== undefined && { week: buildWeek(weekInput, week?.window ?? "current"), ...buildModels(weekInput) }),
  };
}
