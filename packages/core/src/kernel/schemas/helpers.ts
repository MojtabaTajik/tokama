// Helpers: small one-shot AI tasks Tokama runs for itself, started by a click inside a screen. The
// shapes here are part of the versioned engine API: what a helper asks for, what it answers, the
// record of one run, and the record of a Try checks run (which uses no AI). A helper file can
// never change them.
import { z } from "zod";
import { checkCommand, folderPath, MAX_CHECK_CHARS } from "./common.js";
import { AiCliIdSchema, CheckTrialIdSchema, EpochMsSchema, type HelperId, HelperIdSchema, HelperRunIdSchema, HostIdSchema } from "./ids.js";
import { AgentSummarySchema } from "./setup.js";
import { AgentCallUsageSchema, TokenUsageSchema } from "./usage.js";

/** What each helper takes in, by helper id. */
export const HelperInputSchemas = {
  "suggest-checks": z.strictObject({ path: folderPath }),
} as const satisfies Record<HelperId, z.ZodType>;

/**
 * What `run_helper` asks for: a helper and its input. One union keyed by `helperId`, so a new
 * helper adds one member here and no command.
 */
export const HelperRunRequestSchema = z.discriminatedUnion("helperId", [
  z.strictObject({ helperId: z.literal("suggest-checks"), input: HelperInputSchemas["suggest-checks"] }),
]);

/** One line of plain text: no control characters (line breaks and tabs included), no format, private-use or lone surrogate characters, no line or paragraph separators. */
const oneLine = (max: number) => z.string().min(1).max(max).regex(/^[^\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]*$/u, "must be one line of plain text");

/** The most checks suggest-checks proposes. */
export const MAX_SUGGESTED_CHECKS = 4;

export const SuggestedCheckSchema = z.strictObject({
  /** One line. Whether it is one simple command (no `&&`, `|`, redirects) is checked by the engine, not here. */
  command: oneLine(MAX_CHECK_CHARS),
  /** Why this command proves a change correct. */
  why: oneLine(200),
  /** How long it takes, in minutes, as a rough estimate. */
  minutes: z.int().min(1).max(120),
});

export const SuggestChecksResultSchema = z.strictObject({
  checks: z.array(SuggestedCheckSchema).max(MAX_SUGGESTED_CHECKS),
  /** One command that installs what the checks need in a new worktree. Same shape as a check; the engine drops it unless it is one simple command. */
  setup: SuggestedCheckSchema.optional(),
  /** A line to show with the checks, e.g. why there are none. */
  note: oneLine(500).optional(),
});

/** What each helper answers, by helper id. */
export const HelperResultSchemas = {
  "suggest-checks": SuggestChecksResultSchema,
} as const satisfies Record<HelperId, z.ZodType>;

/** A finished run's answer, typed by helper. */
export const HelperRunResultSchema = z.discriminatedUnion("helperId", [
  z.strictObject({ helperId: z.literal("suggest-checks"), value: SuggestChecksResultSchema }),
]);

/** The agent a helper runs on, as the Agents page shows it. */
export const HelperAgentSchema = AgentSummarySchema.omit({ id: true }).extend({ agentId: AgentSummarySchema.shape.id });

/** One helper as the `helpers` query lists it. */
export const HelperSummarySchema = z
  .strictObject({
    helperId: HelperIdSchema,
    name: z.string().min(1).max(100),
    /** The helper's content version; it changes when its instructions do. */
    version: z.int().min(1),
    available: z.boolean(),
    /** Why it cannot run now, in plain words; set exactly when `available` is false. */
    problem: z.string().min(1).max(500).optional(),
    /** Absent when the agent cannot be resolved (a broken file). */
    agent: HelperAgentSchema.optional(),
    /** What a run sends, as plain-word labels such as "file names" and "build files", in order. */
    sends: z.array(z.string().min(1).max(60)).max(10),
  })
  .refine((summary) => summary.available === (summary.problem === undefined), { message: "problem is set exactly when not available", path: ["problem"] });

export const HelperRunStateSchema = z.enum(["running", "done", "failed", "cancelled"]);
/** Where a running helper is: collecting its inputs, waiting for the agent, or asking again after a bad answer. */
export const HelperRunPhaseSchema = z.enum(["gathering", "asking", "retrying"]);
/** The codes a failed run carries in `error.code`. Clients accept any code. */
export const HELPER_RUN_ERROR_CODES = ["bad_answer", "timeout", "quota", "rate_limit", "auth", "crash", "too_large"] as const;

const runError = z.strictObject({ code: z.string().min(1).max(64), message: z.string().max(1000) });

/** What is wrong with the end time of a run or trial that is not running; undefined when nothing. */
function endProblem(record: { readonly startedAt: number; readonly endedAt?: number | undefined }): string | undefined {
  if (record.endedAt === undefined) return "an ended record has an end time";
  return record.endedAt < record.startedAt ? "endedAt is before startedAt" : undefined;
}

export const HelperRunSchema = z
  .strictObject({
    runId: HelperRunIdSchema,
    helperId: HelperIdSchema,
    helperVersion: z.int().min(1),
    state: HelperRunStateSchema,
    /** Set while running. */
    phase: HelperRunPhaseSchema.optional(),
    startedAt: EpochMsSchema,
    endedAt: EpochMsSchema.optional(),
    agent: HelperAgentSchema,
    /** Set exactly when done. */
    result: HelperRunResultSchema.optional(),
    /** Set exactly when failed. Clients accept any code. */
    error: runError.optional(),
    usage: z.strictObject({ tokens: TokenUsageSchema, costUsd: z.number().nonnegative().optional() }).optional(),
  })
  .superRefine((run, context) => {
    const problem = (message: string, path: string) => context.addIssue({ code: "custom", message, path: [path] });
    if (run.state === "running") {
      if (run.phase === undefined) problem("a running run has a phase", "phase");
      if (run.endedAt !== undefined) problem("a running run has not ended", "endedAt");
    } else {
      if (run.phase !== undefined) problem("an ended run has no phase", "phase");
      const timeProblem = endProblem(run);
      if (timeProblem !== undefined) problem(timeProblem, "endedAt");
    }
    if ((run.state === "done") !== (run.result !== undefined)) problem("result is set exactly when the run is done", "result");
    if (run.result !== undefined && run.result.helperId !== run.helperId) problem("the result is of another helper", "result");
    if ((run.state === "failed") !== (run.error !== undefined)) problem("error is set exactly when the run failed", "error");
  });

export const CheckTrialCheckStateSchema = z.enum(["waiting", "running", "passed", "failed", "timed_out", "skipped"]);
/** The most of a check's output a trial carries: its last characters. */
export const MAX_TRIAL_OUTPUT_CHARS = 2000;
/** The most checks one trial runs; the same as a repo's checks. */
export const MAX_TRIAL_CHECKS = 20;

/**
 * One Try checks run: the commands once, in a temporary worktree at the base branch. `done` means
 * every check ran (some may have failed); `failed` means the trial itself could not run.
 */
export const CheckTrialSchema = z
  .strictObject({
    trialId: CheckTrialIdSchema,
    state: HelperRunStateSchema,
    startedAt: EpochMsSchema,
    /** Set exactly when the trial is not running. */
    endedAt: EpochMsSchema.optional(),
    /** The base commit the worktree was made at, short form; absent until the worktree exists. */
    commit: z.string().regex(/^[0-9a-f]{7,64}$/).optional(),
    /** The setup command the trial was asked to run before its checks, as given. */
    setup: checkCommand.optional(),
    /** How the setup went; set exactly when `setup` is. */
    setupResult: z
      .strictObject({
        state: CheckTrialCheckStateSchema,
        /** When the setup command started; set while it runs and after. */
        startedAt: EpochMsSchema.optional(),
        durationMs: z.int().nonnegative().optional(),
        exitCode: z.int().optional(),
        /** The last characters of the output, as text. */
        outputTail: z.string().max(MAX_TRIAL_OUTPUT_CHARS).optional(),
        /** The shell could not find or start the command; `word` is its first word. */
        couldNotStart: z.strictObject({ word: z.string().min(1).max(MAX_CHECK_CHARS) }).optional(),
      })
      .optional(),
    /** With no `setup` given: the command a known file in the trial's top folder points to, for the "Use as setup" button. */
    setupHint: z.strictObject({ command: checkCommand.min(1), from: z.string().min(1).max(255) }).optional(),
    checks: z
      .array(
        z.strictObject({
          command: checkCommand,
          state: CheckTrialCheckStateSchema,
          durationMs: z.int().nonnegative().optional(),
          exitCode: z.int().optional(),
          /** The last characters of the output, as text. */
          outputTail: z.string().max(MAX_TRIAL_OUTPUT_CHARS).optional(),
        }),
      )
      .max(MAX_TRIAL_CHECKS),
    /** Why the trial could not run (the worktree failed, the repo was not found). Set exactly when failed. */
    error: runError.optional(),
  })
  .superRefine((trial, context) => {
    const problem = (message: string, path: string) => context.addIssue({ code: "custom", message, path: [path] });
    if (trial.state === "running") {
      if (trial.endedAt !== undefined) problem("a running trial has not ended", "endedAt");
    } else {
      const timeProblem = endProblem(trial);
      if (timeProblem !== undefined) problem(timeProblem, "endedAt");
    }
    if ((trial.state === "failed") !== (trial.error !== undefined)) problem("error is set exactly when the trial failed", "error");
    if (trial.checks.length === 0 && trial.setup === undefined) problem("a trial has a setup command or a check", "checks");
    if ((trial.setup === undefined) !== (trial.setupResult === undefined)) problem("setupResult is set exactly when setup is", "setupResult");
  });

/**
 * One line of the helper log (`helper-runs/events-<yyyy-mm>.jsonl`): what a helper run did. It
 * holds ids, times, process ids and token counts, never a path, prompt, input or answer. Readers
 * ignore fields they do not know.
 */
const logEnvelope = { format: z.literal(1), hostId: HostIdSchema, at: z.iso.datetime(), runId: HelperRunIdSchema };
export const HelperLogLineSchema = z.discriminatedUnion("type", [
  z.object({ ...logEnvelope, type: z.literal("helper_run_started"), helperId: HelperIdSchema, version: z.int().min(1), agentId: z.string().min(1), cliId: AiCliIdSchema, model: z.string().min(1) }),
  z.object({ ...logEnvelope, type: z.literal("process_started"), pid: z.int().min(2), startedAt: EpochMsSchema, bootTime: EpochMsSchema }),
  z.object({ ...logEnvelope, type: z.literal("usage_recorded"), usage: AgentCallUsageSchema }),
  z.object({ ...logEnvelope, type: z.literal("helper_run_ended"), state: z.enum(["done", "failed", "cancelled"]), errorCode: z.string().optional() }),
]);

export type HelperLogLine = z.output<typeof HelperLogLineSchema>;

export type HelperInput<T extends HelperId = HelperId> = z.output<(typeof HelperInputSchemas)[T]>;
export type HelperRunRequest = z.output<typeof HelperRunRequestSchema>;
export type SuggestedCheck = z.output<typeof SuggestedCheckSchema>;
export type SuggestChecksResult = z.output<typeof SuggestChecksResultSchema>;
export type HelperResult<T extends HelperId = HelperId> = z.output<(typeof HelperResultSchemas)[T]>;
export type HelperAgent = z.output<typeof HelperAgentSchema>;
export type HelperSummary = z.output<typeof HelperSummarySchema>;
export type HelperRunState = z.output<typeof HelperRunStateSchema>;
export type HelperRunPhase = z.output<typeof HelperRunPhaseSchema>;
export type HelperRun = z.output<typeof HelperRunSchema>;
export type CheckTrialCheckState = z.output<typeof CheckTrialCheckStateSchema>;
export type CheckTrial = z.output<typeof CheckTrialSchema>;
