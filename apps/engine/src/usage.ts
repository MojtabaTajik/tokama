// The usage query: what used each AI CLI's limit, retries, each model's record, today's calls, and
// each CLI's plan windows from its sources in order: the CLI's answer to a usage request, the last
// rate-limit event of a call Tokama ran, the CLI's cached copy.
//
// A usage request starts a short-lived CLI process, so it never runs per query: a query that
// finds the last request older than `requestEveryMs` starts one in the background and answers
// with what is known now; when the answer comes, `onChange` tells clients to ask again.
import {
  type AiCliAdapter,
  aiCliAdapters,
  type AiCliId,
  type CallLogs,
  choosePlan,
  type CliPlan,
  type Clock,
  closedWindows,
  type HelperCallRow,
  type ItemId,
  type ItemUsage,
  itemUsageOf,
  keepPast,
  parseTemplateRecord,
  type PastWindow,
  type PlanCandidate,
  type PlanReading,
  PRICES_AS_OF,
  type Result,
  type RunItem,
  type StoredItem,
  summarizeUsage,
  type TemplateStepDef,
  type TokenUsage,
  type UsageReport,
  type UsageRow,
  type UsageWindow,
  type WindowReading,
  windowWeight,
} from "@tokama/core";
import { cliName } from "./real/clis.js";

// The parsed steps of template records, by the record's hash, so a query does not parse them again.
const STEP_CACHE_LIMIT = 200;
const stepCache = new Map<string, ReadonlyMap<string, Pick<TemplateStepDef, "name" | "agentId" | "doneWhen">>>();

function templateSteps(item: Pick<StoredItem, "template">) {
  const cached = stepCache.get(item.template.sha256);
  if (cached !== undefined) return cached;
  const parsed = parseTemplateRecord(item.template.record);
  const steps = new Map((parsed.ok ? parsed.value.steps : []).map((step) => [step.id as string, { name: step.name, agentId: step.agentId, doneWhen: step.doneWhen }]));
  if (stepCache.size >= STEP_CACHE_LIMIT) stepCache.clear();
  stepCache.set(item.template.sha256, steps);
  return steps;
}

/**
 * The items with at least one call that ended at or after `since`, as the report reads them: each
 * step with its name, agent and rule from the template record the item started with (a record that
 * cannot be read leaves them out, and the step is told by its id), its attempts and their checks, and
 * every call of the item. A deleted item has none.
 */
export function usageItemsOf(items: readonly Pick<StoredItem, "id" | "title" | "templateRef" | "template" | "repoIds" | "steps" | "calls" | "deleted">[], since: number): RunItem[] {
  const result: RunItem[] = [];
  for (const item of items) {
    const calls = item.calls ?? [];
    if (item.deleted || !calls.some((call) => call.endedAt >= since)) continue;
    const defs = templateSteps(item);
    result.push({
      itemId: item.id,
      title: item.title,
      templateId: item.templateRef,
      repoIds: item.repoIds,
      calls,
      steps: item.steps.map((step) => {
        const def = defs.get(step.id);
        return {
          id: step.id,
          name: def?.name ?? step.id,
          ...(def !== undefined && { agentId: def.agentId, doneWhen: def.doneWhen }),
          attempts: step.attempts.map((attempt) => ({
            attempt: attempt.attempt,
            ...(attempt.result !== undefined && { result: attempt.result }),
            startedAt: attempt.startedAt,
            ...(attempt.endedAt !== undefined && { endedAt: attempt.endedAt }),
            checks: attempt.checks.map(({ command, passed }) => ({ command, passed })),
          })),
        };
      }),
    });
  }
  return result;
}

/**
 * One row per call that ended at or after `since`, oldest first (equal times by call id). The
 * calls are the ones the item logs hold; a deleted item has none.
 */
export function usageRowsOf(items: readonly Pick<StoredItem, "id" | "title" | "templateRef" | "calls" | "deleted">[], since: number): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const item of items) {
    if (item.deleted) continue;
    for (const call of item.calls ?? []) {
      if (call.endedAt >= since) rows.push({ itemId: item.id, title: item.title, templateId: item.templateRef, call });
    }
  }
  return rows.sort((a, b) => a.call.endedAt - b.call.endedAt || (a.call.callId < b.call.callId ? -1 : a.call.callId > b.call.callId ? 1 : 0));
}

/** One source of an AI CLI's plan windows. */
export type PlanSource = () => Promise<Result<PlanReading & { readonly version?: string }, string>>;

/** The plan sources of one AI CLI. */
export interface CliPlanSources {
  /** Asks the CLI itself. Absent: never asked, e.g. in local-only use. */
  readonly request?: PlanSource;
  /** Reads the CLI's cached copy of its last answer. */
  readonly cache?: PlanSource;
}

/** The plan sources by CLI. A CLI without an entry has none, and its windows come from its calls only. */
export type PlanSources = Partial<Record<AiCliId, CliPlanSources>>;

export interface UsageDeps {
  /** The recorded calls that ended at or after `since`. */
  readonly rows: (since: number) => readonly UsageRow[];
  /** Keeps the last answer to a usage request; absent when nothing is stored. */
  readonly samples?: {
    get(cliId: AiCliId): PlanReading | undefined;
    save(cliId: AiCliId, reading: PlanReading): void;
  };
  readonly sources: PlanSources;
  /** The AI CLIs that report a plan, in this order. Default: the adapters of this build that have a `plan`. */
  readonly adapters?: readonly AiCliAdapter[];
  readonly clock: Clock;
  readonly onChange: () => void;
  readonly log?: (message: string) => void;
  /** Tokama's helper calls that ended at or after `since`: they count in today's figures and in the limit's use. */
  readonly helperCalls?: (since: number) => readonly HelperCallRow[];
  /** Default: 5 minutes. */
  readonly requestEveryMs?: number;
  /** The other AI CLIs' plans. Default: each says it has no source yet. */
  readonly otherClis?: (now: number) => readonly CliPlan[];
  /**
   * An AI CLI's usage from its own logs, to split a limit between Tokama and the user's other
   * sessions. Absent: the logs are not read.
   */
  readonly logs?: {
    /** The AI CLI the logs are of. */
    readonly cliId: AiCliId;
    refresh(): void;
    /** The last scan that ended read every log and found logs; the split needs it. */
    complete(): boolean;
    /** The tokens the logs hold between two times, per model. */
    totals(from: number, to: number): readonly { readonly model: string; readonly tokens: TokenUsage }[];
    /** From when the logs hold the CLI's calls; undefined while they hold none. */
    coveredFrom(): number | undefined;
  };
  /**
   * The items with calls that ended at or after `since`, with their attempts: what the report's
   * `week` block and the model records are made from. Absent: the report has neither.
   */
  readonly items?: (since: number) => readonly RunItem[];
  /** Keeps the weekly windows that ended. Absent: they are kept in memory only. */
  readonly history?: {
    get(cliId: AiCliId): readonly PastWindow[];
    save(cliId: AiCliId, windows: readonly PastWindow[]): void;
  };
}

const REQUEST_EVERY_MS = 5 * 60_000;
// The cache is a large config file; read it at most this often.
const CACHE_EVERY_MS = 60_000;
// Calls older than this are not looked at: rate-limit events, runs and the model records.
const LOOKBACK_MS = 90 * 24 * 60 * 60_000;

/** Codex CLI and Ollama have no plan source yet; they say so instead of showing numbers. */
const NOT_YET: readonly CliPlan[] = [
  { cliId: "codex-cli", windows: [], note: "Codex CLI plan usage comes with its adapter." },
  { cliId: "ollama", windows: [], note: "Local models have no plan limit." },
];

/** The plan sources of each adapter in `list` that has some. `signal` stops a usage request in flight, e.g. at engine shutdown. */
export function planSources(list: readonly AiCliAdapter[] = aiCliAdapters, signal?: AbortSignal): PlanSources {
  const sources: Partial<Record<AiCliId, CliPlanSources>> = {};
  for (const { id, plan } of list) {
    if (plan === undefined) continue;
    const request = plan.request?.bind(plan);
    const cache = plan.cache?.bind(plan);
    sources[id] = { ...(request !== undefined && { request: () => request(signal) }), ...(cache !== undefined && { cache: () => cache() }) };
  }
  return sources;
}

/** What the service keeps for one AI CLI. */
interface CliState {
  requestedAt?: number;
  requesting?: Promise<void>;
  requestProblem?: string;
  version?: string;
  cached?: { at: number; result: Promise<PlanCandidate> };
  memorySample?: PlanReading;
  /** The weekly windows that ended, when nothing stores them. */
  memoryHistory?: readonly PastWindow[];
}

export class UsageService {
  private readonly states = new Map<AiCliId, CliState>();

  constructor(private readonly deps: UsageDeps) {}

  private get list(): readonly AiCliAdapter[] {
    return this.deps.adapters ?? aiCliAdapters;
  }

  private stateOf(cliId: AiCliId): CliState {
    let state = this.states.get(cliId);
    if (state === undefined) this.states.set(cliId, (state = {}));
    return state;
  }

  async report(window: UsageWindow = "current"): Promise<UsageReport> {
    const { now, rows, clis, helperCalls, week } = await this.read();
    return summarizeUsage({ rows, helperCalls, now, clis, ...(week !== undefined && { week: { ...week, window } }) });
  }

  /** What one item used: tokens, its part of each AI CLI's limit, and the steps it ran again. Undefined when the engine has no calls of it. */
  async itemUsage(itemId: ItemId): Promise<ItemUsage | undefined> {
    // Opening an item asks the CLI for nothing, scans nothing and writes nothing: it uses what the usage page last read.
    const { now, clis, helperCalls, week } = await this.read(true);
    return week === undefined ? undefined : itemUsageOf({ now, clis, helperCalls, ...week }, itemId);
  }

  /** The inputs of a report: the plans, the recorded calls and the weekly windows that ended. */
  private async read(passive = false) {
    const now = this.deps.clock.now();
    const planned = this.list.filter((adapter) => adapter.plan !== undefined).map((adapter) => adapter.id);
    if (!passive) for (const cliId of planned) this.requestIfDue(cliId, now);
    const since = now - LOOKBACK_MS;
    const rows = this.deps.rows(since);
    const plans: CliPlan[] = [];
    for (const cliId of planned) plans.push(choosePlan(cliId, await this.candidates(cliId, rows, now), now, this.stateOf(cliId).version));
    const clis = [...plans, ...(this.deps.otherClis?.(now) ?? NOT_YET.filter((plan) => !planned.includes(plan.cliId)))];
    const helperCalls = this.deps.helperCalls?.(since) ?? [];
    // A scan of the logs starts when the last one is old; a query never waits for it.
    if (!passive) this.deps.logs?.refresh();
    const items = this.deps.items?.(since);
    if (items === undefined) return { now, rows, clis, helperCalls, week: undefined };
    if (!passive) for (const cliId of planned) this.recordHistory(cliId, [...this.readingsOf(cliId), ...rows.flatMap((row) => (row.call.cliId === cliId && row.call.plan !== undefined ? [{ at: row.call.plan.at, windows: row.call.plan.windows }] : []))], now, { items, helperCalls });
    const logs = this.callLogs();
    return {
      now,
      rows,
      clis,
      helperCalls,
      week: { items, past: Object.fromEntries(planned.map((cliId) => [cliId, this.history(cliId)])), ...(logs !== undefined && { logs }) },
    };
  }

  /** What the AI CLI's own logs say, in the form the split reads. */
  private callLogs(): Partial<Record<AiCliId, CallLogs>> | undefined {
    const logs = this.deps.logs;
    if (logs === undefined) return undefined;
    const ofCli: CallLogs = { totals: (from, to) => logs.totals(from, to), coveredFrom: logs.coveredFrom(), ready: logs.complete() };
    return { [logs.cliId]: ofCli };
  }

  private readingsOf(cliId: AiCliId): WindowReading[] {
    const sample = this.deps.samples?.get(cliId) ?? this.stateOf(cliId).memorySample;
    return sample === undefined ? [] : [{ at: sample.asOf, windows: sample.windows }];
  }

  private history(cliId: AiCliId): readonly PastWindow[] {
    return this.deps.history?.get(cliId) ?? this.stateOf(cliId).memoryHistory ?? [];
  }

  /**
   * Keeps the weekly windows the readings show as over: the first reading of a later reset closes
   * one. A window's weight (what Tokama's calls and everything else weighed) is fixed when it
   * closes, because the AI CLI deletes old logs; one that could not be weighed then, e.g. while the
   * logs were first read, is tried again.
   */
  private recordHistory(cliId: AiCliId, readings: readonly WindowReading[], now: number, data?: { items: readonly RunItem[]; helperCalls: readonly HelperCallRow[] }): void {
    const items = data?.items ?? this.deps.items?.(now - LOOKBACK_MS);
    if (items === undefined) return;
    const known = this.history(cliId);
    const logsFrom = this.callLogs()?.[cliId]?.coveredFrom;
    // A window the logs do not reach back to can never be weighed: it is not tried again.
    const waiting = [...closedWindows(readings, known), ...known.filter((window) => window.weight === undefined && (logsFrom === undefined || logsFrom <= window.startsAt))];
    if (waiting.length === 0) return;
    const helperCalls = data?.helperCalls ?? this.deps.helperCalls?.(now - LOOKBACK_MS) ?? [];
    const calls = [...items.flatMap((item) => item.calls), ...helperCalls.map((helper) => helper.call)].filter((call) => call.cliId === cliId);
    const logs = this.callLogs()?.[cliId];
    const weighed = waiting.map((window): PastWindow => {
      const weight = windowWeight(calls.filter((call) => call.endedAt >= window.startsAt && call.endedAt <= window.endsAt), logs, window.startsAt, window.endsAt);
      return weight === undefined ? window : { ...window, weight, pricesAsOf: PRICES_AS_OF };
    });
    const next = keepPast([...known.filter((window) => !waiting.includes(window)), ...weighed]);
    if (JSON.stringify(next) === JSON.stringify(keepPast(known))) return;
    if (this.deps.history !== undefined) this.deps.history.save(cliId, next);
    else this.stateOf(cliId).memoryHistory = next;
  }

  /** Waits for a usage request in flight; for tests and shutdown. */
  async settled(): Promise<void> {
    await Promise.all([...this.states.values()].map((state) => state.requesting));
  }

  private async candidates(cliId: AiCliId, rows: readonly UsageRow[], now: number): Promise<PlanCandidate[]> {
    const state = this.stateOf(cliId);
    const candidates: PlanCandidate[] = [];
    const sample = this.deps.samples?.get(cliId) ?? state.memorySample;
    if (sample !== undefined) candidates.push({ source: "request", reading: sample });
    else if (state.requestProblem !== undefined) candidates.push({ source: "request", problem: state.requestProblem });

    const run = rows
      .filter((row) => row.call.cliId === cliId && row.call.plan !== undefined)
      .map((row) => row.call.plan!)
      .sort((a, b) => b.at - a.at)[0];
    if (run !== undefined) candidates.push({ source: "run", reading: { windows: run.windows, asOf: run.at } });

    const cache = this.deps.sources[cliId]?.cache;
    if (cache !== undefined) {
      if (state.cached === undefined || now - state.cached.at > CACHE_EVERY_MS) {
        state.cached = { at: now, result: cache().then((read): PlanCandidate => (read.ok ? { source: "cache", reading: read.value } : { source: "cache", problem: read.error })) };
      }
      candidates.push(await state.cached.result);
    }
    return candidates;
  }

  private requestIfDue(cliId: AiCliId, now: number): void {
    const request = this.deps.sources[cliId]?.request;
    const state = this.stateOf(cliId);
    if (request === undefined || state.requesting !== undefined) return;
    if (state.requestedAt !== undefined && now - state.requestedAt < (this.deps.requestEveryMs ?? REQUEST_EVERY_MS)) return;
    const name = cliName(cliId, this.list);
    state.requestedAt = now;
    state.requesting = request()
      .then((answer) => {
        if (answer.ok) {
          const { version, ...reading } = answer.value;
          if (version !== undefined) state.version = version;
          delete state.requestProblem;
          // The answer replaces the last one: a window it shows as over is closed before the last one is gone.
          const previous = this.deps.samples?.get(cliId) ?? state.memorySample;
          if (previous !== undefined) this.recordHistory(cliId, [{ at: previous.asOf, windows: previous.windows }, { at: reading.asOf, windows: reading.windows }], this.deps.clock.now());
          state.memorySample = reading;
          this.deps.samples?.save(cliId, reading);
        } else {
          state.requestProblem = answer.error;
          this.deps.log?.(`${name} usage request: ${answer.error}`);
        }
      })
      .catch((error: unknown) => {
        state.requestProblem = `The usage request failed: ${String(error)}`;
        this.deps.log?.(`${name} usage request: ${state.requestProblem}`);
      })
      .finally(() => {
        delete state.requesting;
        this.deps.onChange();
      });
  }
}
