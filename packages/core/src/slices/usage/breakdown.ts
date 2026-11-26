// The parts of the usage report that cover a scope: totals per day, a token summary, and tables
// per model and per repo. They work on entries: a scope's usage cut by day, model and repo, from
// Tokama's recorded calls or from another record of a CLI's calls such as its session logs.
import type { AiCliId, RepoId, TokenSummary, TokenUsage, UsageReport } from "../../kernel/schemas/index.js";
import { callCost, priceOf, tokenCost } from "./prices.js";
import type { UsageRow } from "./summary.js";

/** Usage of one model on one day in one repo. */
export interface UsageEntry {
  /** Local `YYYY-MM-DD`. */
  readonly day: string;
  readonly model: string;
  readonly cliId: AiCliId;
  /** Null: outside the configured repos. */
  readonly repoId: RepoId | null;
  readonly tokens: TokenUsage;
  /** Null when nothing could price it. */
  readonly costUsd: number | null;
  /** Agent calls, or logged messages. */
  readonly calls: number;
}

export interface Breakdown {
  readonly days: ReadonlyMap<string, { readonly tokens: number; readonly costUsd: number | null }>;
  readonly totals: UsageReport["totals"];
  readonly tokenSummary: TokenSummary;
  readonly models: NonNullable<UsageReport["models"]>;
  readonly repos: NonNullable<UsageReport["repos"]>;
}

const NO_TOKENS: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const MAX_MODELS = 50;
const MAX_REPOS = 100;

const add = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});
const sum = (t: TokenUsage): number => t.input + t.output + t.cacheRead + t.cacheWrite;
const addCost = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : a + b);

/** An entry priced from the price table: the way to price usage no CLI priced itself. */
export function pricedEntry(entry: Omit<UsageEntry, "costUsd">): UsageEntry {
  return { ...entry, costUsd: entry.cliId === "ollama" ? 0 : (tokenCost(entry.model, entry.tokens) ?? null) };
}

/**
 * One recorded call as entries, one per model it used, so the models add up to the call. The
 * call's cost (the CLI's figure when it gave one) is shared out in proportion to the table price
 * of each model's tokens; when the call has no cost, each model has its table price or none.
 */
export function callEntries(row: Pick<UsageRow, "call" | "repoId">, day: string): UsageEntry[] {
  const { call } = row;
  const repoId = row.repoId ?? null;
  const models = Object.entries(call.models ?? {});
  if (models.length <= 1) {
    const [model, tokens] = models[0] ?? [call.model, call.tokens];
    return [{ day, model, cliId: call.cliId, repoId, tokens, costUsd: callCost(call), calls: 1 }];
  }
  const cost = callCost(call);
  // The call counts once, on its first model.
  const entries = models.map(([model, tokens], n) => pricedEntry({ day, model, cliId: call.cliId, repoId, tokens, calls: n === 0 ? 1 : 0 }));
  if (cost === null) return entries;
  const table = entries.reduce((total, entry) => total + (entry.costUsd ?? 0), 0);
  const all = entries.reduce((total, entry) => total + sum(entry.tokens), 0);
  return entries.map((entry) => ({ ...entry, costUsd: table > 0 ? (cost * (entry.costUsd ?? 0)) / table : all > 0 ? (cost * sum(entry.tokens)) / all : 0 }));
}

export function breakdown(entries: readonly UsageEntry[]): Breakdown {
  const days = new Map<string, { tokens: number; costUsd: number | null }>();
  const models = new Map<string, { model: string; cliId: AiCliId; tokens: number; costUsd: number | null }>();
  const repos = new Map<RepoId | null, { tokens: number; costUsd: number | null }>();
  let tokens = NO_TOKENS;
  let costUsd: number | null = null;
  let calls = 0;
  let unpricedCalls = 0;
  let priced = false;
  let savings = 0;
  let atInputPrice = 0;
  let atCachePrice = 0;

  for (const entry of entries) {
    const total = sum(entry.tokens);
    tokens = add(tokens, entry.tokens);
    costUsd = addCost(costUsd, entry.costUsd);
    calls += entry.calls;
    if (entry.costUsd === null) unpricedCalls += entry.calls;

    const day = days.get(entry.day) ?? { tokens: 0, costUsd: null };
    day.tokens += total;
    day.costUsd = addCost(day.costUsd, entry.costUsd);
    days.set(entry.day, day);

    const modelKey = `${entry.cliId}\n${entry.model}`;
    const model = models.get(modelKey) ?? { model: entry.model, cliId: entry.cliId, tokens: 0, costUsd: null };
    model.tokens += total;
    model.costUsd = addCost(model.costUsd, entry.costUsd);
    models.set(modelKey, model);

    const repo = repos.get(entry.repoId) ?? { tokens: 0, costUsd: null };
    repo.tokens += total;
    repo.costUsd = addCost(repo.costUsd, entry.costUsd);
    repos.set(entry.repoId, repo);

    const price = entry.cliId === "ollama" ? undefined : priceOf(entry.model);
    if (price !== undefined) {
      priced = true;
      savings += (entry.tokens.cacheRead * (price.input - price.cacheRead)) / 1_000_000;
      atInputPrice += entry.tokens.cacheRead * price.input;
      atCachePrice += entry.tokens.cacheRead * price.cacheRead;
    }
  }

  const input = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  const pricedCost = [...models.values()].reduce((total, model) => total + (model.costUsd ?? 0), 0);
  return {
    days,
    totals: { tokens, costUsd, calls, unpricedCalls },
    tokenSummary: {
      processed: sum(tokens),
      cachedInput: tokens.cacheRead,
      cachedInputPercent: input === 0 ? 0 : (tokens.cacheRead / input) * 100,
      uncachedInput: tokens.input + tokens.cacheWrite,
      output: tokens.output,
      cacheSavingsUsd: priced ? savings : null,
      cacheSavingsFactor: atCachePrice > 0 ? atInputPrice / atCachePrice : null,
    },
    models: [...models.values()]
      .map((model) => ({ ...model, sharePercent: model.costUsd === null ? null : pricedCost > 0 ? (model.costUsd / pricedCost) * 100 : 0 }))
      .sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.tokens - a.tokens)
      .slice(0, MAX_MODELS),
    repos: [...repos]
      .map(([repoId, repo]) => ({ repoId, ...repo }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, MAX_REPOS),
  };
}
