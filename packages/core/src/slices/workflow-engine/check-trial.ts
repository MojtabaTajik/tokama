// Try checks: runs the commands a person accepted once, in a throwaway detached worktree at the
// base branch's commit, so they see what an item would see before the repo is added. No agent is
// involved. Every command comes from the request and nowhere else: it is attacker-controlled text
// when a helper suggested it, so `prepare` re-checks each one, and nothing is created before that.
//
// `prepare` makes every refusal. `run` then makes the worktree, runs the setup command (if any)
// and every check in order, a failed check included, and removes the worktree in a `finally`.
// Checks are skipped only when the setup failed or the trial was cancelled. Like a check step,
// the commands run as the person in the worktree, with the command policy, `CI=1`, their own
// process group and the allowlisted environment; there is no OS sandbox yet.
import { realpath } from "node:fs/promises";
import type { Clock } from "../../kernel/clock/index.js";
import type { Git } from "../../kernel/git/index.js";
import type { ProcessRunner } from "../../kernel/process/index.js";
import { err, ok, type Result } from "../../kernel/result/index.js";
import {
  type CheckTrial,
  CheckTrialIdSchema,
  type CheckTrialId,
  type CommandErrorCode,
  MAX_TRIAL_OUTPUT_CHARS,
  newId,
  terminalText,
} from "../../kernel/schemas/index.js";
import { cutText, scrubPaths } from "../../kernel/text/index.js";
import { BRANCH, checkProblem, MAX_BRANCH } from "../config/index.js";
import { checkRunOptions, runCommand, type CheckResult } from "../verification/index.js";
import { checkTrialFolder, createTrialWorktree, removeTrialWorktree, trialWorktreePath, type WorktreeRepo } from "../worktrees/index.js";

/** What `try_checks` asks for. */
export interface CheckTrialRequest {
  readonly path: string;
  readonly baseBranch?: string | undefined;
  readonly checks: readonly { readonly command: string; readonly minutes?: number | undefined }[];
  readonly setup?: string | undefined;
}

export interface CheckTrialError {
  readonly code: CommandErrorCode;
  readonly message: string;
}

export interface CheckTrialDeps {
  readonly git: Git;
  readonly runner: ProcessRunner;
  readonly clock: Clock;
  /** The repo a path stands for, with the base branch and worktree folder to use; or why it cannot be tried. */
  readonly resolveRepo: (path: string, baseBranch: string | undefined) => Promise<Result<WorktreeRepo, CheckTrialError>>;
  /** Folders written as names in output, in every form they may appear in; the trial adds its own repo and worktree. */
  readonly folders: readonly (readonly [path: string, name: string])[];
  /** Length of a minute in ms. Default 60 000; a test makes it short. */
  readonly minuteMs?: number;
}

export interface PreparedCheckTrial {
  readonly trialId: CheckTrialId;
  readonly request: CheckTrialRequest;
  readonly repo: WorktreeRepo;
  /** The base branch's commit, full object id. */
  readonly commit: string;
}

export interface CheckTrialHooks {
  /** The trial as it is now; called for every change. */
  readonly onUpdate: (trial: CheckTrial) => void;
  /** Called before the worktree exists, so the caller can record it for a restart's cleanup. */
  readonly onPlanned: (planned: { readonly repoPath: string; readonly worktreePath: string }) => void;
  /** Called with the pid of each command's shell (also its process group) right after it started. */
  readonly onProcess: (pid: number) => void;
}

export interface CheckTrialRunner {
  prepare(request: CheckTrialRequest): Promise<Result<PreparedCheckTrial, CheckTrialError>>;
  /** Ends when the worktree is gone and the last update was sent. */
  run(prepared: PreparedCheckTrial, hooks: CheckTrialHooks, signal: AbortSignal): Promise<void>;
}

const SETUP_MINUTES = 20;
const MAX_CHECK_MINUTES = 20;
const MIN_CHECK_MINUTES = 2;
const RAW_OUTPUT_CAP = 8_000;
const SETUP_TAIL_CHARS = 300;
// Control characters, invisible and direction-changing characters, and line and paragraph breaks.
const NOT_PLAIN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

/** Why a command or setup cannot run, or undefined: one simple command on one line of plain text. */
export function trialCommandProblem(command: string): string | undefined {
  if (NOT_PLAIN.test(command)) return "has a control, invisible or line-break character";
  return checkProblem(command);
}

/** A check's time limit: three times its minutes, between 2 and 20 minutes; without minutes, 20. */
export function checkLimitMinutes(minutes: number | undefined): number {
  return minutes === undefined ? MAX_CHECK_MINUTES : Math.min(MAX_CHECK_MINUTES, Math.max(MIN_CHECK_MINUTES, minutes * 3));
}

/** Output as text: no escape or control characters, our folders written as names, the last 2 000 characters. */
export function tidyOutput(text: string, folders: readonly (readonly [path: string, name: string])[]): string {
  return cutText(scrubPaths(terminalText(text), { roots: folders }).trimEnd(), MAX_TRIAL_OUTPUT_CHARS, { keep: "tail" });
}

const refuse = (code: CommandErrorCode, message: string): Result<never, CheckTrialError> => err({ code, message });
const shown = (command: string) => JSON.stringify(cutText(command, 80));

export function createCheckTrialRunner(deps: CheckTrialDeps): CheckTrialRunner {
  const { git, clock } = deps;
  const minuteMs = deps.minuteMs ?? 60_000;

  const prepare: CheckTrialRunner["prepare"] = async (request) => {
    // Every refusal comes before anything exists.
    for (const [label, command] of [["setup command", request.setup], ...request.checks.map((check) => ["check", check.command] as const)] as const) {
      if (command === undefined) continue;
      const problem = trialCommandProblem(command);
      if (problem !== undefined) return refuse("invalid_request", `The ${label} ${shown(command)} ${problem}.`);
    }
    const repo = await deps.resolveRepo(request.path, request.baseBranch);
    if (!repo.ok) return repo;
    // The branch name reaches git as an argument: nothing that reads as an option or a range.
    if (!BRANCH.test(repo.value.baseBranch) || repo.value.baseBranch.length > MAX_BRANCH) return refuse("invalid_request", `The base branch ${shown(repo.value.baseBranch)} must be a branch name, such as main.`);
    const folder = await checkTrialFolder(repo.value, { create: false });
    if (!folder.ok) return refuse("invalid_request", `Tokama will not use this worktree folder: ${folder.error.message}.`);
    const commit = await git.revParse(repo.value.path, `${repo.value.baseBranch}^{commit}`);
    if (!commit.ok) return refuse("invalid_request", `The base branch ${shown(repo.value.baseBranch)} was not found in this repo.`);
    return ok({ trialId: CheckTrialIdSchema.parse(newId("trial", clock.now())), request, repo: repo.value, commit: commit.value });
  };

  const run: CheckTrialRunner["run"] = async (prepared, hooks, signal) => {
    const { trialId, request, repo, commit } = prepared;
    const startedAt = clock.now();
    let trial: CheckTrial = {
      trialId,
      state: "running",
      startedAt,
      ...(request.setup !== undefined && { setup: request.setup }),
      checks: request.checks.map((check) => ({ command: check.command, state: "waiting" as const })),
    };
    const publish = (next: CheckTrial) => {
      trial = next;
      hooks.onUpdate(next);
    };
    const end = (state: "done" | "failed" | "cancelled", extra: Partial<CheckTrial> = {}) => {
      const skipped = trial.checks.map((check) => (check.state === "waiting" || check.state === "running" ? { command: check.command, state: "skipped" as const } : check));
      publish({ ...trial, ...extra, state, endedAt: Math.max(startedAt, clock.now()), checks: skipped });
    };
    const worktreePath = trialWorktreePath(repo, trialId);
    publish(trial);
    hooks.onPlanned({ repoPath: repo.path, worktreePath });
    let final: (() => void) | undefined;
    try {
      if (signal.aborted) {
        final = () => end("cancelled");
        return;
      }
      // Longest first is scrubPaths' own job.
      const folders = [...deps.folders, ...(await names(worktreePath, worktreePath, "<worktree>")), ...(await names(repo.path, repo.path, "<repo>"))];
      const made = await createTrialWorktree(git, repo, trialId, commit);
      if (!made.ok) {
        final = () => end("failed", { error: { code: "worktree_failed", message: cutText(tidyOutput(made.error.message, folders), 500) } });
        return;
      }
      const cwd = made.value;
      publish({ ...trial, commit: commit.slice(0, 12) });
      const execute = (command: string, minutes: number): Promise<CheckResult> =>
        runCommand(deps.runner, command, checkRunOptions(command, { cwd, timeoutMs: minutes * minuteMs, signal, outputCap: RAW_OUTPUT_CAP, onSpawn: hooks.onProcess }));

      if (request.setup !== undefined) {
        const setup = await execute(request.setup, SETUP_MINUTES);
        if (setup.outcome !== "passed") {
          final = setup.outcome === "aborted" ? () => end("cancelled") : () => end("failed", { error: { code: "setup_failed", message: setupMessage(setup, folders) } });
          return;
        }
      }
      for (const [index, check] of request.checks.entries()) {
        if (signal.aborted) break;
        publish({ ...trial, checks: trial.checks.map((current, at) => (at === index ? { command: check.command, state: "running" as const } : current)) });
        const result = await execute(check.command, checkLimitMinutes(check.minutes));
        if (result.outcome === "aborted") break;
        publish({ ...trial, checks: trial.checks.map((current, at) => (at === index ? finished(result, folders) : current)) });
      }
      final = () => end(signal.aborted ? "cancelled" : "done");
    } finally {
      // Whatever happened, the worktree goes; a failure to remove it is left for the next start's sweep.
      await removeTrialWorktree(git, repo.path, worktreePath).catch(() => undefined);
      (final ?? (() => end("failed", { error: { code: "crash", message: "The trial stopped before it finished." } })))();
    }
  };

  return { prepare, run };
}

/** A path in each form a process may print it in: as given and as its real path (a temp folder on macOS is reached through a link). */
async function names(given: string, other: string, name: string): Promise<(readonly [string, string])[]> {
  const real = (path: string) => realpath(path).catch(() => path);
  return [...new Set([given, other, await real(given), await real(other)])].map((path) => [path, name] as const);
}

function finished(result: CheckResult, folders: readonly (readonly [string, string])[]): CheckTrial["checks"][number] {
  const base = { command: result.command, durationMs: result.durationMs, ...(result.exitCode !== null && { exitCode: result.exitCode }) };
  if (result.outcome === "refused" || result.outcome === "not-started") {
    return { ...base, state: "failed", outputTail: tidyOutput(`could not start: ${result.output}`, folders) };
  }
  const state = result.outcome === "passed" ? "passed" : result.outcome === "timed-out" ? "timed_out" : "failed";
  return { ...base, state, outputTail: tidyOutput(result.output, folders) };
}

/** Why the setup failed, in Tokama's words with a short cleaned end of its output; at most 1 000 characters. */
function setupMessage(result: CheckResult, folders: readonly (readonly [string, string])[]): string {
  const tail = cutText(tidyOutput(result.output, folders), SETUP_TAIL_CHARS, { keep: "tail" });
  const what =
    result.outcome === "timed-out"
      ? `did not finish in ${SETUP_MINUTES} minutes`
      : result.outcome === "failed"
        ? `exited with code ${String(result.exitCode)}`
        : "could not start";
  return cutText(`The setup command ${what}.${tail === "" ? "" : ` Its output ended with: ${tail}`}`, 1000);
}
