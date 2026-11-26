// The usage query: recorded calls rolled up by day, workflow and item, and each AI CLI's plan
// windows from its sources in order: the CLI's answer to a usage request, the last rate-limit
// event of a call Tokama ran, the CLI's cached copy.
//
// A usage request starts a short-lived CLI process, so it never runs per query: a query that
// finds the last request older than `requestEveryMs` starts one in the background and answers
// with what is known now; when the answer comes, `onChange` tells clients to ask again.
import {
  adapters,
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
  summarizeUsage,
  type UsageEntry,
  type UsageRange,
  type UsageReport,
  type UsageRow,
  type UsageScope,
} from "@tokama/core";

/** One source of Claude Code's plan windows. */
export type PlanSource = () => Promise<Result<PlanReading & { readonly version?: string }, string>>;

export interface PlanSources {
  /** Asks the CLI itself (Claude Code's `get_usage`). Absent: never asked, e.g. in local-only use. */
  readonly request?: PlanSource;
  /** Reads the CLI's cached copy of its last answer. */
  readonly cache?: PlanSource;
}

export interface UsageDeps {
  /** The recorded calls that ended at or after `since`. */
  readonly rows: (since: number) => readonly UsageRow[];
  /** Keeps the last answer to a usage request; absent when nothing is stored. */
  readonly samples?: {
    get(cliId: AiCliId): PlanReading | undefined;
    save(cliId: AiCliId, reading: PlanReading): void;
  };
  readonly sources: PlanSources;
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

/**
 * Claude Code's own sources, looked up by name: the adapter may have been removed. `signal` stops
 * a usage request in flight, e.g. at engine shutdown.
 */
export function claudePlanSources(signal?: AbortSignal): PlanSources {
  const factories: Record<string, unknown> = { ...adapters };
  const request = factories["requestClaudePlan"] as ((options: { signal?: AbortSignal }) => ReturnType<PlanSource>) | undefined;
  const cache = factories["readClaudePlanCache"] as (() => ReturnType<PlanSource>) | undefined;
  return { ...(request !== undefined && { request: () => request(signal === undefined ? {} : { signal }) }), ...(cache !== undefined && { cache: () => cache() }) };
}

export class UsageService {
  private requestedAt: number | undefined;
  private requesting: Promise<void> | undefined;
  private requestProblem: string | undefined;
  private version: string | undefined;
  private cached: { at: number; result: Promise<PlanCandidate> } | undefined;
  private memorySample: PlanReading | undefined;

  constructor(private readonly deps: UsageDeps) {}

  async report(range: UsageRange, scope: UsageScope = "tokama"): Promise<UsageReport> {
    const now = this.deps.clock.now();
    this.requestIfDue(now);
    const since = Math.min(rangeStart(now, range), now - RUN_LOOKBACK_MS);
    const rows = this.deps.rows(since);
    const claude = choosePlan("claude-code", await this.claudeCandidates(rows, now), now, this.version);
    const clis = [claude, ...(this.deps.otherClis?.(now) ?? NOT_YET)];
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
    await this.requesting;
  }

  private async claudeCandidates(rows: readonly UsageRow[], now: number): Promise<PlanCandidate[]> {
    const candidates: PlanCandidate[] = [];
    const sample = this.deps.samples?.get("claude-code") ?? this.memorySample;
    if (sample !== undefined) candidates.push({ source: "request", reading: sample });
    else if (this.requestProblem !== undefined) candidates.push({ source: "request", problem: this.requestProblem });

    const run = rows
      .filter((row) => row.call.cliId === "claude-code" && row.call.plan !== undefined)
      .map((row) => row.call.plan!)
      .sort((a, b) => b.at - a.at)[0];
    if (run !== undefined) candidates.push({ source: "run", reading: { windows: run.windows, asOf: run.at } });

    const cache = this.deps.sources.cache;
    if (cache !== undefined) {
      if (this.cached === undefined || now - this.cached.at > CACHE_EVERY_MS) {
        this.cached = { at: now, result: cache().then((read): PlanCandidate => (read.ok ? { source: "cache", reading: read.value } : { source: "cache", problem: read.error })) };
      }
      candidates.push(await this.cached.result);
    }
    return candidates;
  }

  private requestIfDue(now: number): void {
    const request = this.deps.sources.request;
    if (request === undefined || this.requesting !== undefined) return;
    if (this.requestedAt !== undefined && now - this.requestedAt < (this.deps.requestEveryMs ?? REQUEST_EVERY_MS)) return;
    this.requestedAt = now;
    this.requesting = request()
      .then((answer) => {
        if (answer.ok) {
          const { version, ...reading } = answer.value;
          if (version !== undefined) this.version = version;
          this.requestProblem = undefined;
          this.memorySample = reading;
          this.deps.samples?.save("claude-code", reading);
        } else {
          this.requestProblem = answer.error;
          this.deps.log?.(`Claude Code usage request: ${answer.error}`);
        }
      })
      .catch((error: unknown) => {
        this.requestProblem = `The usage request failed: ${String(error)}`;
        this.deps.log?.(`Claude Code usage request: ${this.requestProblem}`);
      })
      .finally(() => {
        this.requesting = undefined;
        this.deps.onChange();
      });
  }
}
