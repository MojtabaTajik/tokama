// Sample answers for helpers and Try checks (fake engine mode). Nothing runs and no folder is
// read: the folder name picks one canned answer, so a screen can reach every state:
//   `slow`  the helper waits 60 s (to try Cancel), then answers like the default
//   `fail`  the helper fails with a bad answer
//   `empty` the helper finds no checks
//   `retry` the helper asks the agent a second time, then answers like the default
// and in Try checks, a command with `lint` fails and one with `slow` runs 60 s; a setup command
// with `fail` fails with exit 1 and one with `nothere` is not found. All timers go
// through the engine clock. The first update of a run or trial is sent from a timer, so a client
// has the reply (with the id) before it hears of the run.
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
  type CheckTrial,
  CheckTrialSchema,
  type Clock,
  type CommandResult,
  err,
  type EngineEvent,
  type HelperAgent,
  type HelperResult,
  type HelperRun,
  HelperRunSchema,
  type HelpersResult,
  ok,
  type Result,
  type TimerHandle,
} from "@tokama/core";
import type { HelperCommand } from "../helpers.js";
import type { CommandError } from "./sample.js";

/** How long an ended run or trial can still be asked for. */
export const SAMPLE_KEEP_MS = 10 * 60_000;
const MAX_KEPT = 50;
/** Helper runs at once; a third is refused. */
const MAX_RUNNING_RUNS = 2;

/** What a `slow` run or check waits. */
export const SAMPLE_SLOW_MS = 60_000;
const GATHER_MS = 300;
const CHECK_MS = 1_200;
const SETUP_MS = 1_500;
const SETUP_FAIL_OUTPUT = "ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with \"frozen-lockfile\" because pnpm-lock.yaml is not up to date with package.json";

const AGENT: HelperAgent = { agentId: "helper" as HelperAgent["agentId"], name: "Helper", cliId: "claude-code", model: "haiku", runsOn: "cloud" };
const SENDS = ["file names", "build files"];
const DISCLOSURE = `Sends ${SENDS.join(" and ")} of this folder to Claude Code · haiku.`;

const DEFAULT_RESULT: HelperResult<"suggest-checks"> = {
  checks: [
    { command: "pnpm test", why: "Runs the unit tests in package.json.", minutes: 3 },
    { command: "pnpm lint", why: "Checks code style with the lint script.", minutes: 1 },
    { command: "pnpm typecheck", why: "Finds type errors before review.", minutes: 2 },
  ],
  setup: { command: "pnpm install --frozen-lockfile", why: "Installs the packages pnpm-lock.yaml lists; a new worktree has none.", minutes: 1 },
};
const USAGE = { tokens: { input: 6200, output: 180, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.007 };

const LINT_OUTPUT = "src/orders.ts\n  12:5  error  'total' is never reassigned. Use 'const' instead  prefer-const\n\n✖ 1 problem (1 error, 0 warnings)";
const PASS_OUTPUT = "Test Files  12 passed (12)\n     Tests  148 passed (148)\n  Duration  41.20s";

interface Entry<T> {
  value: T;
  /** The timers that move it on; cleared when it ends early. */
  timers: TimerHandle[];
  expiry?: TimerHandle;
}

/** Runs or trials by id: ended ones stay for SAMPLE_KEEP_MS, at most MAX_KEPT of them. */
class Table<T extends { state: string }> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(private readonly clock: Clock) {}

  get(id: string): Entry<T> | undefined {
    return this.entries.get(id);
  }

  add(id: string, value: T): Entry<T> {
    const entry: Entry<T> = { value, timers: [] };
    this.entries.set(id, entry);
    return entry;
  }

  running(): number {
    return [...this.entries.values()].filter((entry) => entry.value.state === "running").length;
  }

  /** The entry has ended: stop its timers, keep it for a while, and drop the oldest ended ones past the cap. */
  ended(id: string): void {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    this.stop(entry);
    entry.expiry = this.clock.setTimeout(() => this.entries.delete(id), SAMPLE_KEEP_MS);
    const endedIds = [...this.entries].filter(([, other]) => other.value.state !== "running").map(([otherId]) => otherId);
    for (const old of endedIds.slice(0, Math.max(0, endedIds.length - MAX_KEPT))) {
      const dropped = this.entries.get(old);
      if (dropped?.expiry !== undefined) this.clock.clearTimeout(dropped.expiry);
      this.entries.delete(old);
    }
  }

  stop(entry: Entry<T>): void {
    for (const timer of entry.timers) this.clock.clearTimeout(timer);
    entry.timers = [];
  }

  close(): void {
    for (const entry of this.entries.values()) {
      this.stop(entry);
      if (entry.expiry !== undefined) this.clock.clearTimeout(entry.expiry);
    }
    this.entries.clear();
  }
}

export class SampleHelpers {
  private readonly runs: Table<HelperRun>;
  private readonly trials: Table<CheckTrial>;

  constructor(
    private readonly clock: Clock,
    private readonly emit: (event: EngineEvent) => void = () => {},
  ) {
    this.runs = new Table(clock);
    this.trials = new Table(clock);
  }

  helpers(): HelpersResult {
    return { helpers: [{ helperId: "suggest-checks", name: "Suggest checks", version: 2, available: true, agent: AGENT, sends: SENDS }] };
  }

  helperRun(runId: string): Result<HelperRun, CommandError> {
    const entry = this.runs.get(runId);
    return entry === undefined ? err({ code: "not_found", message: `no helper run ${runId}` }) : ok(entry.value);
  }

  checkTrial(trialId: string): Result<CheckTrial, CommandError> {
    const entry = this.trials.get(trialId);
    return entry === undefined ? err({ code: "not_found", message: `no check trial ${trialId}` }) : ok(entry.value);
  }

  command(command: HelperCommand): Result<CommandResult<HelperCommand["type"]>, CommandError> {
    switch (command.type) {
      case "run_helper":
        return this.runHelper(command.run.input.path, command.cloud === "accepted");
      case "cancel_helper":
        return this.cancelRun(command.runId);
      case "try_checks":
        return this.tryChecks(command.checks.map((check) => check.command), command.setup);
      case "cancel_check_trial":
        return this.cancelTrial(command.trialId);
    }
  }

  /** Stops every timer; nothing is sent after this. */
  close(): void {
    this.runs.close();
    this.trials.close();
  }

  private runHelper(path: string, cloudAccepted: boolean): Result<{ runId: HelperRun["runId"] }, CommandError> {
    if (!cloudAccepted) return err({ code: "cloud_not_accepted", message: DISCLOSURE });
    if (this.runs.running() >= MAX_RUNNING_RUNS) return err({ code: "busy", message: "Two helpers are running. Wait for one to end, then try again." });
    const runId = `hrun_${randomUUID()}` as HelperRun["runId"];
    const folder = basename(path).toLowerCase();
    const startedAt = this.clock.now();
    const entry = this.runs.add(runId, { runId, helperId: "suggest-checks", helperVersion: 2, state: "running", phase: "gathering", startedAt, agent: AGENT });
    const at = (ms: number, step: () => void) => entry.timers.push(this.clock.setTimeout(step, ms));
    const phase = (next: "asking" | "retrying") => () => this.setRun(runId, { ...entry.value, phase: next });
    const done = (result: HelperResult<"suggest-checks">, usage?: HelperRun["usage"]) => () =>
      this.endRun(runId, { state: "done", result: { helperId: "suggest-checks", value: result }, ...(usage !== undefined && { usage }) });

    // The first update comes after the reply, so a client knows the id first.
    at(0, () => this.setRun(runId, entry.value));
    at(GATHER_MS, phase("asking"));
    if (folder.includes("slow")) at(GATHER_MS + SAMPLE_SLOW_MS, done(DEFAULT_RESULT, USAGE));
    else if (folder.includes("fail")) {
      at(1_500, () => this.endRun(runId, { state: "failed", error: { code: "bad_answer", message: "The helper's answer was not valid twice. Try again, or type the checks yourself." } }));
    } else if (folder.includes("empty")) at(1_200, done({ checks: [], note: "No build files found. Type the checks yourself." }));
    else if (folder.includes("retry")) {
      at(1_000, phase("retrying"));
      at(2_000, done(DEFAULT_RESULT, USAGE));
    } else at(1_500, done(DEFAULT_RESULT, USAGE));
    return ok({ runId });
  }

  private cancelRun(runId: string): Result<null, CommandError> {
    const entry = this.runs.get(runId);
    if (entry === undefined) return err({ code: "not_found", message: `no helper run ${runId}` });
    if (entry.value.state !== "running") return err({ code: "invalid_state", message: `helper run ${runId} has already ended (${entry.value.state})` });
    this.endRun(runId, { state: "cancelled" });
    return ok(null);
  }

  /** The run ends: its record loses the phase, gets the end time and the given outcome, and goes out. */
  private endRun(runId: string, outcome: Pick<HelperRun, "state"> & Partial<Pick<HelperRun, "result" | "error" | "usage">>): void {
    const entry = this.runs.get(runId);
    if (entry === undefined) return;
    const rest = { ...entry.value };
    delete rest.phase;
    this.runs.stop(entry);
    this.setRun(runId, { ...rest, ...outcome, endedAt: this.clock.now() });
    this.runs.ended(runId);
  }

  private setRun(runId: string, run: HelperRun): void {
    const entry = this.runs.get(runId);
    if (entry === undefined) return;
    const parsed = HelperRunSchema.safeParse(run);
    if (!parsed.success) throw new Error(`invalid sample helper run: ${JSON.stringify(parsed.error.issues)}`);
    entry.value = parsed.data;
    this.emit({ type: "helper_run_updated", run: parsed.data });
  }

  /** Nothing runs. A setup with `fail` in it fails with exit 1 and `nothere` is not found; a trial with no setup and a `pnpm` check offers the pnpm setup. */
  private tryChecks(commands: readonly string[], setup?: string): Result<{ trialId: CheckTrial["trialId"] }, CommandError> {
    if (this.trials.running() > 0) return err({ code: "busy", message: "Checks are already being tried. Wait for them to end, or cancel them." });
    const trialId = `trial_${randomUUID()}` as CheckTrial["trialId"];
    const entry = this.trials.add(trialId, {
      trialId,
      state: "running",
      startedAt: this.clock.now(),
      commit: "4f9c2ab",
      ...(setup !== undefined && { setup, setupResult: { state: "waiting" as const } }),
      ...(setup === undefined && commands.some((command) => command.startsWith("pnpm")) && { setupHint: { command: "pnpm install --frozen-lockfile", from: "pnpm-lock.yaml" } }),
      checks: commands.map((command) => ({ command, state: "waiting" })),
    });
    // Each check runs for CHECK_MS (a `slow` one for SAMPLE_SLOW_MS), one after the other.
    const run = (index: number) => {
      const check = entry.value.checks[index];
      if (check === undefined) return this.endTrial(trialId, { state: "done" });
      this.setTrial(trialId, { ...entry.value, checks: replace(entry.value.checks, index, { ...check, state: "running" }) });
      const slow = check.command.includes("slow") && !check.command.includes("lint");
      entry.timers = [
        this.clock.setTimeout(() => {
          const failed = check.command.includes("lint");
          const finished = failed
            ? { command: check.command, state: "failed" as const, durationMs: CHECK_MS, exitCode: 1, outputTail: LINT_OUTPUT }
            : { command: check.command, state: "passed" as const, durationMs: slow ? SAMPLE_SLOW_MS : CHECK_MS, exitCode: 0, outputTail: PASS_OUTPUT };
          this.setTrial(trialId, { ...entry.value, checks: replace(entry.value.checks, index, finished) });
          run(index + 1);
        }, slow ? SAMPLE_SLOW_MS : CHECK_MS),
      ];
    };
    // The setup runs first: it fails (exit 1 or not found) or passes, and a failed one skips every check.
    const runSetup = (command: string) => {
      const startedAt = this.clock.now();
      this.setTrial(trialId, { ...entry.value, setupResult: { state: "running", startedAt } });
      entry.timers = [
        this.clock.setTimeout(() => {
          const notFound = command.includes("nothere");
          const failed = notFound || command.includes("fail");
          if (!failed) {
            this.setTrial(trialId, { ...entry.value, setupResult: { state: "passed", startedAt, durationMs: SETUP_MS, exitCode: 0 } });
            return run(0);
          }
          const setupResult: NonNullable<CheckTrial["setupResult"]> = notFound
            ? { state: "failed", startedAt, durationMs: 60, exitCode: 127, outputTail: "sh: nothere: command not found", couldNotStart: { word: "nothere" } }
            : { state: "failed", startedAt, durationMs: SETUP_MS, exitCode: 1, outputTail: SETUP_FAIL_OUTPUT };
          this.setTrial(trialId, { ...entry.value, setupResult });
          this.endTrial(trialId, { state: "failed", skipUnfinished: true, error: { code: "setup_failed", message: `The setup command exited with code ${String(setupResult.exitCode)}.` } });
        }, SETUP_MS),
      ];
    };
    entry.timers = [
      this.clock.setTimeout(() => this.setTrial(trialId, entry.value), 0),
      this.clock.setTimeout(() => (setup === undefined ? run(0) : runSetup(setup)), GATHER_MS),
    ];
    return ok({ trialId });
  }

  private cancelTrial(trialId: string): Result<null, CommandError> {
    const entry = this.trials.get(trialId);
    if (entry === undefined) return err({ code: "not_found", message: `no check trial ${trialId}` });
    if (entry.value.state !== "running") return err({ code: "invalid_state", message: `check trial ${trialId} has already ended (${entry.value.state})` });
    // The check that runs and the ones that wait are not run.
    this.endTrial(trialId, { state: "cancelled", skipUnfinished: true });
    return ok(null);
  }

  private endTrial(trialId: string, outcome: { state: CheckTrial["state"]; skipUnfinished?: boolean; error?: NonNullable<CheckTrial["error"]> }): void {
    const entry = this.trials.get(trialId);
    if (entry === undefined) return;
    this.trials.stop(entry);
    const checks = outcome.skipUnfinished === true ? entry.value.checks.map((check) => (check.state === "waiting" || check.state === "running" ? { command: check.command, state: "skipped" as const } : check)) : entry.value.checks;
    const { setupResult } = entry.value;
    const setupEnd = outcome.skipUnfinished === true && setupResult !== undefined && (setupResult.state === "waiting" || setupResult.state === "running") ? { setupResult: { state: "skipped" as const } } : {};
    this.setTrial(trialId, { ...entry.value, ...setupEnd, state: outcome.state, endedAt: this.clock.now(), checks, ...(outcome.error !== undefined && { error: outcome.error }) });
    this.trials.ended(trialId);
  }

  private setTrial(trialId: string, trial: CheckTrial): void {
    const entry = this.trials.get(trialId);
    if (entry === undefined) return;
    const parsed = CheckTrialSchema.safeParse(trial);
    if (!parsed.success) throw new Error(`invalid sample check trial: ${JSON.stringify(parsed.error.issues)}`);
    entry.value = parsed.data;
    this.emit({ type: "check_trial_updated", trial: parsed.data });
  }
}

function replace<T>(items: readonly T[], index: number, item: T): T[] {
  return items.map((current, i) => (i === index ? item : current));
}
