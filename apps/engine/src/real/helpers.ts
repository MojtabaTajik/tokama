// The helper runs of a real engine: starting one, its phases as events, cancelling it, keeping it
// for a while after it ends, and what it leaves behind: the helper log, a `call.json` for the last
// few runs, and the usage rows of the usage report. A run is asked for with a command that answers
// at once with the run id; its progress comes as `helper_run_updated` events, so a call that takes
// longer than a client's request timeout is no problem.
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type Clock,
  type CommandError,
  type EngineEvent,
  err,
  type HelperCallRow,
  type HelperOutcome,
  type HelperRun,
  type HelperRunId,
  HelperRunIdSchema,
  type HelperRunner,
  type HelperRunRequest,
  HelperRunSchema,
  type HelpersResult,
  type HostId,
  killLeftoverTree,
  newId,
  ok,
  type PreparedHelperRun,
  type ProcessTable,
  replaceTextSync,
  type Result,
  type TimerHandle,
} from "@tokama/core";
import { helperCallRows, HelperLog } from "./helper-log.js";

/** Ended runs stay in memory this long, at most `MAX_KEPT` of them, so a client that reconnects can ask for one. */
const KEEP_MS = 10 * 60_000;
const MAX_KEPT = 50;
/** Helper runs at once; a third is refused. */
const MAX_RUNNING = 2;
/** `call.json` is kept for the newest runs, at most this many and this old. */
const MAX_RECORDS = 20;
const RECORD_DAYS_MS = 7 * 24 * 60 * 60_000;
const RUN_DIR = /^hrun_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface HelperRunsOptions {
  readonly runner: HelperRunner;
  readonly home: string;
  readonly hostId: HostId;
  readonly clock: Clock;
  readonly processes: ProcessTable;
  /** Time between SIGTERM and SIGKILL for a helper process left over from the last engine. */
  readonly recoveryGraceMs?: number;
  readonly emit: (event: EngineEvent) => void;
  readonly log: (message: string) => void;
}

interface Entry {
  run: HelperRun;
  readonly controller: AbortController;
  /** Settles when the run has ended and everything about it is written. */
  done: Promise<void>;
  /** The timers that belong to the entry: its first update, and its expiry once it ended. */
  timers: TimerHandle[];
  /** No update goes out before the first one, which comes from a timer: the reply with the run id is written first. */
  announced: boolean;
}

const fail = (code: CommandError["code"], message: string): Result<never, CommandError> => err({ code, message });

/** When a run id was made: its first 48 bits, as `newId` writes them. */
const madeAt = (runId: string): number => Number.parseInt(`${runId.slice(5, 13)}${runId.slice(14, 18)}`, 16);

export class HelperRuns {
  private readonly log: HelperLog;
  private readonly entries = new Map<string, Entry>();
  private rows: HelperCallRow[] = [];
  private closing = false;
  /** Settles once the log is read and the processes the last engine left are dealt with. */
  readonly ready: Promise<void>;

  constructor(private readonly options: HelperRunsOptions) {
    this.log = new HelperLog({ home: options.home, hostId: options.hostId, clock: options.clock, log: options.log });
    this.ready = this.load().catch((error: unknown) => options.log(`the helper log could not be read: ${String(error)}`));
  }

  /** Reads the log for the usage rows, and ends the runs whose process outlived the last engine. */
  private async load(): Promise<void> {
    const lines = await this.log.read();
    for (const leftover of this.log.leftovers(lines)) {
      const killed = await killLeftoverTree(leftover, { table: this.options.processes, clock: this.options.clock, ...(this.options.recoveryGraceMs !== undefined && { graceMs: this.options.recoveryGraceMs }) });
      this.log.append(leftover.runId, { type: "helper_run_ended", state: "cancelled", errorCode: "crash" });
      this.options.log(`a helper run was still going when the last engine stopped (${killed.kind === "killed" ? "its process was stopped" : `its process was ${killed.reason.replace("_", " ")}`})`);
    }
    // Rows are added by runs that began while the log was read, so these come first.
    this.rows = [...helperCallRows(lines), ...this.rows];
    if (this.rows.length > 0) this.options.emit({ type: "usage_changed" });
    this.prune();
  }

  /** Tokama's helper calls that ended at or after `since`, for the usage report. */
  calls(since: number): readonly HelperCallRow[] {
    return this.rows.filter((row) => row.call.endedAt >= since);
  }

  /** Runs that have not ended: a stop that waits for idle must not interrupt them. */
  running(): number {
    return [...this.entries.values()].filter((entry) => entry.run.state === "running").length;
  }

  async helpers(): Promise<HelpersResult> {
    return { helpers: await this.options.runner.list() };
  }

  /** Every refusal comes before the run id; once there is one, the run's end is an event. */
  async start(request: HelperRunRequest, cloud?: "accepted"): Promise<Result<{ runId: HelperRunId }, CommandError>> {
    await this.ready;
    if (this.closing) return fail("invalid_state", "The engine is stopping.");
    const prepared = await this.options.runner.prepare(request, cloud);
    if (!prepared.ok) return err(prepared.error);
    if (this.closing) return fail("invalid_state", "The engine is stopping.");
    if (this.running() >= MAX_RUNNING) return fail("busy", "Two helpers are running. Wait for one to end, then try again.");
    const { clock } = this.options;
    const runId = HelperRunIdSchema.parse(newId("hrun", clock.now()));
    const run: HelperRun = { runId, helperId: request.helperId, helperVersion: prepared.value.definition.version, state: "running", phase: "gathering", startedAt: clock.now(), agent: prepared.value.agent };
    const entry: Entry = { run, controller: new AbortController(), done: Promise.resolve(), timers: [], announced: false };
    this.entries.set(runId, entry);
    const { target, definition } = prepared.value;
    this.log.append(runId, { type: "helper_run_started", helperId: definition.id, version: definition.version, agentId: target.id, cliId: target.cliId, model: target.model });
    // The reply goes out first: the first update comes from a timer, so a client knows the id
    // before it hears of the run. It carries the run as it is by then.
    entry.timers.push(
      clock.setTimeout(() => {
        entry.announced = true;
        this.send(entry.run);
      }, 0),
    );
    entry.done = this.execute(entry, prepared.value);
    return ok({ runId });
  }

  cancel(runId: string): Result<null, CommandError> {
    const entry = this.entries.get(runId);
    if (entry === undefined) return fail("not_found", `no helper run ${runId}`);
    if (entry.run.state !== "running") return fail("invalid_state", `helper run ${runId} has already ended (${entry.run.state})`);
    entry.controller.abort();
    return ok(null);
  }

  get(runId: string): Result<HelperRun, CommandError> {
    const entry = this.entries.get(runId);
    return entry === undefined ? fail("not_found", `no helper run ${runId}`) : ok(entry.run);
  }

  /** Stops the runs that are going, waits for them to be written, and drops every timer. */
  async close(): Promise<void> {
    this.closing = true;
    await this.ready;
    for (const entry of this.entries.values()) entry.controller.abort();
    await Promise.all([...this.entries.values()].map((entry) => entry.done));
    for (const entry of this.entries.values()) for (const timer of entry.timers) this.options.clock.clearTimeout(timer);
    this.entries.clear();
  }

  private async execute(entry: Entry, prepared: PreparedHelperRun): Promise<void> {
    const { runId } = entry.run;
    const { clock, processes } = this.options;
    let outcome: HelperOutcome | undefined;
    try {
      outcome = await this.options.runner.run(
        prepared,
        {
          onPhase: (phase) => this.update(entry, { ...entry.run, phase }),
          onProcess: (pid) => this.log.append(runId, { type: "process_started", pid, startedAt: clock.now(), bootTime: processes.bootTime() }),
          onUsage: (usage) => {
            this.log.append(runId, { type: "usage_recorded", usage });
            this.rows.push({ helperId: prepared.definition.id, call: usage });
          },
        },
        entry.controller.signal,
      );
    } catch (error) {
      this.options.log(`a helper run failed: ${String(error)}`);
    }
    const errorCode = outcome === undefined ? "crash" : outcome.error?.code;
    this.log.append(runId, { type: "helper_run_ended", state: outcome?.state ?? "failed", ...(errorCode !== undefined && { errorCode }) });
    if (outcome !== undefined) this.writeRecord(entry.run, outcome);
    this.finish(entry, outcome);
    this.prune();
  }

  /** The end of a run: its record leaves the phase, gets its end time and outcome, and goes out. */
  private finish(entry: Entry, outcome: HelperOutcome | undefined): void {
    const rest = { ...entry.run };
    delete rest.phase;
    const endedAt = Math.max(rest.startedAt, this.options.clock.now());
    const ended: HelperRun =
      outcome === undefined
        ? { ...rest, state: "failed", endedAt, error: { code: "crash", message: "The helper stopped before it answered." } }
        : {
            ...rest,
            state: outcome.state,
            endedAt,
            ...(outcome.result !== undefined && { result: { helperId: rest.helperId, value: outcome.result } as HelperRun["result"] }),
            ...(outcome.error !== undefined && { error: outcome.error }),
            ...(outcome.usage !== undefined && { usage: outcome.usage }),
          };
    this.update(entry, ended);
    if (outcome?.usage !== undefined) this.options.emit({ type: "usage_changed" });
    entry.timers.push(this.options.clock.setTimeout(() => this.entries.delete(rest.runId), KEEP_MS));
    // Past the cap, the oldest ended runs go first.
    const endedRuns = [...this.entries].filter(([, other]) => other.run.state !== "running");
    for (const [id, dropped] of endedRuns.slice(0, Math.max(0, endedRuns.length - MAX_KEPT))) {
      for (const timer of dropped.timers) this.options.clock.clearTimeout(timer);
      this.entries.delete(id);
    }
  }

  private update(entry: Entry, run: HelperRun): void {
    // The run's own state moves on even when its record cannot be sent: a run must never stay "running" for good.
    entry.run = run;
    const parsed = HelperRunSchema.safeParse(run);
    if (!parsed.success) return this.options.log(`a helper run record was not valid and was not sent: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`);
    if (entry.announced) this.send(parsed.data);
  }

  private send(run: HelperRun): void {
    this.options.emit({ type: "helper_run_updated", run });
  }

  /** `call.json`: what the run sent and how it went, by names and sizes. No input text and no answer. */
  private writeRecord(run: HelperRun, outcome: HelperOutcome): void {
    const dir = join(this.log.dir, run.runId);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      return this.options.log(`the record of a helper run was not made: ${String(error)}`);
    }
    const record = { format: 1, runId: run.runId, state: outcome.state, ...(outcome.error !== undefined && { error: outcome.error }), ...outcome.record };
    const written = replaceTextSync(join(dir, "call.json"), `${JSON.stringify(record, null, 2)}\n`, 0o600);
    if (!written.ok) this.options.log(`the record of a helper run was not written: ${written.error.message}`);
  }

  /** Keeps `call.json` for the newest runs only: at most 20, none older than 7 days. */
  private prune(): void {
    try {
      const now = this.options.clock.now();
      const runs = readdirSync(this.log.dir).filter((name) => RUN_DIR.test(name)).sort((a, b) => madeAt(b) - madeAt(a));
      for (const [index, name] of runs.entries()) {
        if (index >= MAX_RECORDS || now - madeAt(name) > RECORD_DAYS_MS) rmSync(join(this.log.dir, name), { recursive: true, force: true });
      }
    } catch {
      // No folder yet, or one that cannot be listed: nothing to prune.
    }
  }
}
