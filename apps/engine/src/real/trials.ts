// The Try checks runs of a real engine: starting one, its progress as events, cancelling it, keeping
// it for a while after it ends, and the list of open trials on disk. A trial is written to
// `run/check-trials.json` before its worktree exists and removed once the worktree is gone, so an
// engine that stopped in between finds the leftover at its next start: it stops the trial's
// process tree (only when the boot time and the process's start time match) and removes the
// worktree, even in a folder that was never added as a repo.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CheckTrial,
  type CheckTrialId,
  CheckTrialSchema,
  type CheckTrialRequest,
  type CheckTrialRunner,
  type Clock,
  type CommandError,
  type EngineEvent,
  err,
  type Git,
  killLeftoverTree,
  ok,
  type ProcessTable,
  removeTrialWorktree,
  replaceTextSync,
  type Result,
  type TimerHandle,
} from "@tokama/core";

/** Ended trials stay in memory this long, at most `MAX_KEPT` of them, so a client that reconnects can ask for one. */
const KEEP_MS = 10 * 60_000;
const MAX_KEPT = 50;
const FILE = "check-trials.json";

/** One trial that may have left a worktree or a process behind. */
export interface OpenTrial {
  readonly trialId: string;
  readonly repoPath: string;
  readonly worktreePath: string;
  /** The shell of the command that runs (or ran last), with when it started. */
  readonly pid?: number;
  readonly startedAt?: number;
  readonly bootTime: number;
}

export interface CheckTrialsOptions {
  readonly runner: CheckTrialRunner;
  readonly git: Git;
  /** The Tokama home: the open-trials file is `<home>/run/check-trials.json`. */
  readonly home: string;
  readonly clock: Clock;
  readonly processes: ProcessTable;
  /** Time between SIGTERM and SIGKILL for a process left over from the last engine. */
  readonly recoveryGraceMs?: number;
  readonly emit: (event: EngineEvent) => void;
  readonly log: (message: string) => void;
}

interface Entry {
  trial: CheckTrial | undefined;
  readonly controller: AbortController;
  done: Promise<void>;
  timers: TimerHandle[];
  /** No update goes out before the first one, which comes from a timer: the reply with the id is written first. */
  announced: boolean;
}

const fail = (code: CommandError["code"], message: string): Result<never, CommandError> => err({ code, message });

const isOpenTrial = (value: unknown): value is OpenTrial => {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["trialId"] === "string" &&
    typeof record["repoPath"] === "string" &&
    typeof record["worktreePath"] === "string" &&
    typeof record["bootTime"] === "number" &&
    (record["pid"] === undefined || Number.isInteger(record["pid"])) &&
    (record["startedAt"] === undefined || typeof record["startedAt"] === "number")
  );
};

export class CheckTrials {
  private readonly entries = new Map<string, Entry>();
  private readonly file: string;
  private open: OpenTrial[] = [];
  private closing = false;
  /** Settles once the trials the last engine left are dealt with. */
  readonly ready: Promise<void>;

  constructor(private readonly options: CheckTrialsOptions) {
    this.file = join(options.home, "run", FILE);
    this.ready = this.sweep().catch((error: unknown) => options.log(`left-over trials were not cleaned up: ${String(error)}`));
  }

  /** Trials that have not ended: a stop that waits for idle must not interrupt them. */
  running(): number {
    return [...this.entries.values()].filter((entry) => entry.trial === undefined || entry.trial.state === "running").length;
  }

  /** Every refusal comes before the trial id; once there is one, the end is an event. */
  async start(request: CheckTrialRequest): Promise<Result<{ trialId: CheckTrialId }, CommandError>> {
    await this.ready;
    if (this.closing) return fail("invalid_state", "The engine is stopping.");
    const prepared = await this.options.runner.prepare(request);
    if (!prepared.ok) return err(prepared.error);
    if (this.closing) return fail("invalid_state", "The engine is stopping.");
    if (this.running() > 0) return fail("busy", "Checks are already being tried. Wait for them to end, or cancel them.");
    const { trialId } = prepared.value;
    const { clock } = this.options;
    const entry: Entry = { trial: undefined, controller: new AbortController(), done: Promise.resolve(), timers: [], announced: false };
    this.entries.set(trialId, entry);
    entry.timers.push(
      clock.setTimeout(() => {
        entry.announced = true;
        if (entry.trial !== undefined) this.send(entry.trial);
      }, 0),
    );
    entry.done = this.execute(entry, prepared.value);
    return ok({ trialId });
  }

  cancel(trialId: string): Result<null, CommandError> {
    const entry = this.entries.get(trialId);
    if (entry === undefined) return fail("not_found", `no check trial ${trialId}`);
    if (entry.trial !== undefined && entry.trial.state !== "running") return fail("invalid_state", `check trial ${trialId} has already ended (${entry.trial.state})`);
    entry.controller.abort();
    return ok(null);
  }

  get(trialId: string): Result<CheckTrial, CommandError> {
    const trial = this.entries.get(trialId)?.trial;
    return trial === undefined ? fail("not_found", `no check trial ${trialId}`) : ok(trial);
  }

  /** Stops the trials that are going, waits until their worktrees are gone, and drops every timer. */
  async close(): Promise<void> {
    this.closing = true;
    await this.ready;
    for (const entry of this.entries.values()) entry.controller.abort();
    await Promise.all([...this.entries.values()].map((entry) => entry.done));
    for (const entry of this.entries.values()) for (const timer of entry.timers) this.options.clock.clearTimeout(timer);
    this.entries.clear();
  }

  private async execute(entry: Entry, prepared: Parameters<CheckTrialRunner["run"]>[0]): Promise<void> {
    const { trialId } = prepared;
    let worktreePath: string | undefined;
    try {
      await this.options.runner.run(
        prepared,
        {
          onUpdate: (trial) => this.update(entry, trial),
          onPlanned: (planned) => {
            worktreePath = planned.worktreePath;
            this.record({ trialId, repoPath: planned.repoPath, worktreePath: planned.worktreePath, bootTime: this.options.processes.bootTime() });
          },
          onProcess: (pid) => {
            const open = this.open.find((trial) => trial.trialId === trialId);
            if (open !== undefined) this.record({ ...open, pid, startedAt: this.options.clock.now() });
          },
        },
        entry.controller.signal,
      );
    } catch (error) {
      this.options.log(`a check trial failed: ${String(error)}`);
    }
    // The record stays when the worktree could not be removed, for the next start to try again.
    if (worktreePath === undefined || !existsSync(worktreePath)) this.forget(trialId);
    this.keep(entry, trialId);
  }

  private keep(entry: Entry, trialId: string): void {
    entry.timers.push(this.options.clock.setTimeout(() => this.entries.delete(trialId), KEEP_MS));
    // Past the cap, the oldest ended trials go first.
    const ended = [...this.entries].filter(([, other]) => other.trial !== undefined && other.trial.state !== "running");
    for (const [id, dropped] of ended.slice(0, Math.max(0, ended.length - MAX_KEPT))) {
      for (const timer of dropped.timers) this.options.clock.clearTimeout(timer);
      this.entries.delete(id);
    }
  }

  private update(entry: Entry, trial: CheckTrial): void {
    const parsed = CheckTrialSchema.safeParse(trial);
    if (!parsed.success) return this.options.log(`a check trial record was not valid and was not sent: ${JSON.stringify(parsed.error.issues.slice(0, 3))}`);
    entry.trial = parsed.data;
    if (entry.announced) this.send(parsed.data);
  }

  private send(trial: CheckTrial): void {
    this.options.emit({ type: "check_trial_updated", trial });
  }

  // ---- the open-trials file ---------------------------------------------------------------

  private record(trial: OpenTrial): void {
    this.open = [...this.open.filter((other) => other.trialId !== trial.trialId), trial];
    this.save();
  }

  private forget(trialId: string): void {
    this.open = this.open.filter((trial) => trial.trialId !== trialId);
    this.save();
  }

  private save(): void {
    try {
      mkdirSync(join(this.options.home, "run"), { recursive: true, mode: 0o700 });
    } catch (error) {
      return this.options.log(`the open check trials were not recorded: ${String(error)}`);
    }
    const written = replaceTextSync(this.file, `${JSON.stringify({ format: 1, trials: this.open })}\n`, 0o600);
    if (!written.ok) this.options.log(`the open check trials were not recorded: ${written.error.message}`);
  }

  private read(): OpenTrial[] {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch {
      return [];
    }
    try {
      const parsed = JSON.parse(text) as { trials?: unknown };
      return Array.isArray(parsed.trials) ? parsed.trials.filter(isOpenTrial) : [];
    } catch (error) {
      this.options.log(`the open check trials file is not readable: ${String(error)}`);
      return [];
    }
  }

  /** Stops what the last engine left (process tree, then worktree) and clears the file. A trial that cannot be cleaned stays in it. */
  private async sweep(): Promise<void> {
    const { git, processes, clock } = this.options;
    const left: OpenTrial[] = [];
    for (const trial of this.read()) {
      if (trial.pid !== undefined && trial.startedAt !== undefined) {
        const killed = await killLeftoverTree({ pid: trial.pid, startedAt: trial.startedAt, bootTime: trial.bootTime }, { table: processes, clock, ...(this.options.recoveryGraceMs !== undefined && { graceMs: this.options.recoveryGraceMs }) });
        if (killed.kind === "killed") this.options.log("a check trial's process was still going when the last engine stopped; it was stopped");
      }
      const removed = await removeTrialWorktree(git, trial.repoPath, trial.worktreePath);
      if (removed.ok) this.options.log("a check trial's worktree was left by the last engine and was removed");
      // A folder that is gone is nothing to clean, whatever git says about a repo that moved or was deleted.
      else if (!existsSync(trial.worktreePath)) this.options.log("a check trial's repo is gone; its record was dropped");
      else {
        this.options.log(`a check trial's worktree could not be removed: ${removed.error.message}`);
        left.push(trial);
      }
    }
    // `start` waits for the sweep, so nothing else is recorded yet.
    this.open = left;
    if (left.length > 0 || existsSync(this.file)) this.save();
  }
}
