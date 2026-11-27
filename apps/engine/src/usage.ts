// The usage query: recorded calls rolled up by day, workflow and item, and each AI CLI's plan
// windows from its sources in order: the CLI's answer to a usage request, the last rate-limit
// event of a call Tokama ran, the CLI's cached copy.
//
// A usage request starts a short-lived CLI process, so it never runs per query: a query that
// finds the last request older than `requestEveryMs` starts one in the background and answers
// with what is known now; when the answer comes, `onChange` tells clients to ask again.
import {
  type AiCliAdapter,
  aiCliAdapters,
  type AiCliId,
  choosePlan,
  type CliPlan,
  type Clock,
  type HelperCallRow,
  type LogScan,
  type PlanCandidate,
  type PlanReading,
  rangeStart,
  type Result,
  type StoredItem,
  summarizeUsage,
  type UsageEntry,
  type UsageRange,
  type UsageReport,
  type UsageRow,
  type UsageScope,
} from "@tokama/core";
import { cliName } from "./real/clis.js";

/**
 * One row per call that ended at or after `since`, oldest first (equal times by call id). The
 * calls are the ones the item logs hold; a deleted item has none.
 */
export function usageRowsOf(items: readonly Pick<StoredItem, "id" | "title" | "templateRef" | "repoIds" | "calls" | "deleted">[], since: number): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const item of items) {
    if (item.deleted) continue;
    const repoId = item.repoIds[0];
    for (const call of item.calls ?? []) {
      if (call.endedAt >= since) rows.push({ itemId: item.id, title: item.title, templateId: item.templateRef, ...(repoId !== undefined && { repoId }), call });
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
  /**
   * Tokama's helper calls that ended at or after `since`: the report counts them in its totals and
   * lists them in `helpers`. In the `all` scope, Claude Code's logs hold the Claude Code ones too:
   * the report skips those from `logs.coveredFrom()` on, so they are never counted twice.
   */
  readonly helperCalls?: (since: number) => readonly HelperCallRow[];
  /** Default: 5 minutes. */
  readonly requestEveryMs?: number;
  /** The other AI CLIs' plans. Default: each says it has no source yet. */
  readonly otherClis?: (now: number) => readonly CliPlan[];
  /** Claude Code's usage from its own logs, for the `all` scope. Absent: the logs are not read. */
  readonly logs?: {
    refresh(): void;
    status(): LogScan;
    entries(since: number): readonly UsageEntry[];
    /** From when the logs hold Claude Code's calls; undefined while they hold none. */
    coveredFrom(): number | undefined;
  };
}

const NO_LOGS: LogScan = { state: "unavailable", filesDone: 0, filesTotal: 0, note: "This engine does not read Claude Code's logs." };

const REQUEST_EVERY_MS = 5 * 60_000;
// The cache is a large config file; read it at most this often.
const CACHE_EVERY_MS = 60_000;
// Rate-limit events older than this are not looked for.
const RUN_LOOKBACK_MS = 8 * 24 * 60 * 60_000;

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

  async report(range: UsageRange, scope: UsageScope = "tokama"): Promise<UsageReport> {
    const now = this.deps.clock.now();
    const planned = this.list.filter((adapter) => adapter.plan !== undefined).map((adapter) => adapter.id);
    for (const cliId of planned) this.requestIfDue(cliId, now);
    const since = Math.min(rangeStart(now, range), now - RUN_LOOKBACK_MS);
    const rows = this.deps.rows(since);
    const plans: CliPlan[] = [];
    for (const cliId of planned) plans.push(choosePlan(cliId, await this.candidates(cliId, rows, now), now, this.stateOf(cliId).version));
    const clis = [...plans, ...(this.deps.otherClis?.(now) ?? NOT_YET.filter((plan) => !planned.includes(plan.cliId)))];
    const helperCalls = this.deps.helperCalls?.(since) ?? [];
    if (scope === "tokama") return summarizeUsage({ rows, helperCalls, range, now, clis, scope });
    const logs = this.deps.logs;
    logs?.refresh();
    const logsFrom = logs?.coveredFrom();
    return summarizeUsage({
      rows,
      helperCalls,
      range,
      now,
      clis,
      scope,
      logs: logs?.entries(rangeStart(now, range)) ?? [],
      ...(logsFrom !== undefined && { logsFrom }),
      scan: logs?.status() ?? NO_LOGS,
    });
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
