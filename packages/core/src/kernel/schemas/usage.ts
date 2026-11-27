// Agent call shapes: the events an agent runtime emits, the usage record stored per call, and the
// usage report the engine serves: plan windows per AI CLI with a forecast, what used each limit in
// a week, retries, each model's record per step and agent, and today's totals.
import { z } from "zod";
import { AgentIdSchema, AiCliIdSchema, CallIdSchema, EpochMsSchema, ItemIdSchema, RepoIdSchema, StepIdSchema } from "./ids.js";

const count = z.int().nonnegative();

export const TokenUsageSchema = z.strictObject({
  input: count,
  output: count,
  cacheRead: count,
  cacheWrite: count,
});

/** How an agent call ended. A loop-guard stop is recorded by the execution slice, not the runtime. */
export const AgentCallOutcomeSchema = z.enum(["completed", "failed", "aborted"]);

/**
 * Why a call failed when the run failed, not the work: the plan's quota is used up, the backend
 * rate-limits, the CLI is logged out, the CLI crashed or failed in another way, or the call ran
 * past its timeout.
 */
export const AgentCallErrorKindSchema = z.enum(["quota", "rate_limit", "auth", "crash", "timeout"]);

/** One plan window as the CLI last reported it. */
export const RateLimitWindowSchema = z.strictObject({
  /** The CLI's name for the window, e.g. `five_hour`, `seven_day`. */
  window: z.string().min(1),
  usedPercent: z.number().min(0),
  resetsAt: EpochMsSchema.optional(),
});

/** One event of an agent call's stream. Every stream ends with exactly one `end` event. */
export const AgentCallEventSchema = z.discriminatedUnion("type", [
  /**
   * The CLI started. `pid` is the root of its process tree; on POSIX it is also the process group
   * id, which a restart kills if the call is still running.
   */
  z.strictObject({ type: z.literal("started"), pid: z.int().positive() }),
  z.strictObject({ type: z.literal("text"), text: z.string() }),
  /**
   * The agent started a new turn. One event per assistant message, however many parts the CLI
   * streams it in. It comes before the `tool_call` events of its message.
   */
  z.strictObject({ type: z.literal("turn") }),
  /**
   * The agent asked for a tool. `kind` tells file edits and shell commands apart from other tools.
   * `input` holds only the fields that make two calls the same call (for a command, `command`;
   * no descriptions or notes), so loop guards can spot an agent that repeats itself.
   */
  z.strictObject({
    type: z.literal("tool_call"),
    /** The CLI's id for the call. A call streamed twice keeps its id. */
    id: z.string().min(1),
    name: z.string().min(1),
    kind: z.enum(["edit", "command", "other"]),
    input: z.record(z.string(), z.json()),
  }),
  /**
   * A tool call ended: the CLI sent back the tool's result. `id` is the `tool_call` event's id. A
   * call with a `tool_call` and no `tool_result` yet is still running.
   */
  z.strictObject({ type: z.literal("tool_result"), id: z.string().min(1) }),
  /**
   * A subagent the agent started sent a message or a tool result. It is no turn or tool call of
   * the agent; it shows that the tool call which runs the subagent is still at work.
   */
  z.strictObject({ type: z.literal("subagent") }),
  /** The CLI reported its plan usage. */
  z.strictObject({
    type: z.literal("rate_limit"),
    /** The CLI's status word, e.g. `allowed`, `allowed_warning`, `rejected`. */
    status: z.string().min(1),
    windows: z.array(RateLimitWindowSchema),
  }),
  z.strictObject({
    type: z.literal("end"),
    outcome: AgentCallOutcomeSchema,
    /** Tokens used so far; partial when the call failed or was aborted. */
    usage: TokenUsageSchema,
    /** Tokens per model, when the CLI reports them. */
    modelUsage: z.record(z.string().min(1), TokenUsageSchema).optional(),
    /** The CLI's own estimate of the call's cost in US dollars, at list price, when it reports one. */
    costUsd: z.number().nonnegative().optional(),
    /** Why the call failed, in words. */
    error: z.string().min(1).optional(),
    errorKind: AgentCallErrorKindSchema.optional(),
    /** The CLI's session id, for resuming the session later. */
    sessionId: z.string().min(1).optional(),
    /** Wall time from start to exit. */
    durationMs: z.int().nonnegative().optional(),
  }),
]);

/** The plan windows the CLI reported last during a call, and when. */
export const PlanSnapshotSchema = z.strictObject({
  /** The CLI's status word, e.g. `allowed`, `allowed_warning`, `rejected`. */
  status: z.string().min(1).max(64),
  windows: z.array(RateLimitWindowSchema).max(20),
  at: EpochMsSchema,
});

const modelName = z.string().min(1).max(200);

/**
 * What one agent call used, as its own output reported it. Stored in the item's log as a
 * `usage_recorded` event, whose envelope adds the item, host, position and UTC time. Costs are
 * not stored, except the CLI's own figure: estimates come from the price table when read.
 */
export const AgentCallUsageSchema = z
  .strictObject({
    callId: CallIdSchema,
    stepId: StepIdSchema,
    attempt: z.int().min(1),
    agentId: AgentIdSchema,
    /** The AI CLI or model host the agent runs on; `ollama` for a local model. */
    cliId: AiCliIdSchema,
    /** The model the call asked for. */
    model: modelName,
    outcome: AgentCallOutcomeSchema,
    startedAt: EpochMsSchema,
    endedAt: EpochMsSchema,
    /** All tokens of the call, subagents included when the CLI counts them. */
    tokens: TokenUsageSchema,
    /** Tokens per model the CLI reported; a call can use more than one. */
    models: z.record(modelName, TokenUsageSchema).optional(),
    /** The CLI's own list-price estimate, in US dollars. */
    reportedCostUsd: z.number().nonnegative().optional(),
    plan: PlanSnapshotSchema.optional(),
  })
  .refine((usage) => usage.endedAt >= usage.startedAt, { message: "endedAt is before startedAt", path: ["endedAt"] });

/** Where a plan window reading came from, best first. */
export const PlanSourceSchema = z.enum([
  /** The CLI answered a usage request on demand (Claude Code's `get_usage`). */
  "request",
  /** The last rate-limit event of an agent call Tokama ran. */
  "run",
  /** The CLI's own cached copy of its last usage answer. */
  "cache",
]);

export const PlanWindowSchema = z.strictObject({
  /**
   * The CLI's name for the window: a fixed window such as `five_hour`, `seven_day`, or the kind of a
   * limit such as `session`, `weekly_all`, `weekly_scoped`.
   */
  window: z.string().min(1).max(64),
  /** 0 to 100, or above when over the limit. */
  usedPercent: z.number().min(0).max(1000),
  resetsAt: EpochMsSchema.optional(),
  /** What a scoped limit covers, e.g. the model `Fable`. */
  scope: z.string().min(1).max(64).optional(),
  /** The family of limits it belongs to, e.g. `session`, `weekly`. */
  group: z.string().min(1).max(32).optional(),
  /** The CLI's word for how close the limit is, e.g. `normal`. */
  severity: z.string().min(1).max(32).optional(),
  /** Whether the CLI marks this limit as the one that applies now. */
  active: z.boolean().optional(),
  /** A scoped limit's allowance as a share of the whole weekly limit, 0 to 100. */
  sharePercent: z.number().min(0).max(100).optional(),
  /** When the window started: its reset time less its length. Absent when the length is unknown. */
  startsAt: EpochMsSchema.optional(),
  /**
   * Where the window ends up at the pace since it started, read at the reading's time. Absent while
   * less than 5% of the window has passed, while nothing is used, once the limit is reached, and
   * when the window's length is unknown.
   */
  forecast: z
    .strictObject({
      /** The use at the reset time if the pace holds; above 100 when it would pass the limit. */
      atResetPercent: z.number().min(0).max(100_000),
      /** When the limit is reached at that pace; only when that is before the reset. */
      runsOutAt: EpochMsSchema.optional(),
    })
    .optional(),
});

/** One AI CLI's plan usage as the engine last read it. Absent values are unknown, never guessed. */
export const CliPlanSchema = z.strictObject({
  cliId: AiCliIdSchema,
  /** Empty when nothing is known. */
  windows: z.array(PlanWindowSchema).max(20),
  /** Absent when no source answered. */
  source: PlanSourceSchema.optional(),
  /** When the source read the windows: the data's age. */
  asOf: EpochMsSchema.optional(),
  /** The plan's name as the CLI reports it, e.g. `max`. */
  plan: z.string().min(1).max(64).optional(),
  /** The CLI's version, when known. */
  version: z.string().min(1).max(100).optional(),
  /** Extra usage beyond the plan: on, off, or absent when unknown. */
  extraUsage: z.enum(["on", "off"]).optional(),
  /** `plan`: the CLI has plan limits. `pay_per_use`: it bills per call (an API key). Absent when unknown. */
  billing: z.enum(["plan", "pay_per_use"]).optional(),
  /** Why the windows are unknown or old, in plain words. */
  note: z.string().min(1).max(500).optional(),
});

const tokens = z.int().nonnegative();
/**
 * The workflow key exactly as item records carry it, so clients match it with the setup's templates
 * the same way they match items.
 */
const templateId = z.string().min(1).max(200);

/** Which weekly window a report's `week` block covers: the one running now, or the one before it. */
export const UsageWindowSchema = z.enum(["current", "previous"]);

/** A part of a limit in percent. It can pass 100 when the limit was passed. */
const limitPercent = z.number().min(0).max(1000);
const usd = z.number().nonnegative();
const text = (max: number) => z.string().min(1).max(max);

const ItemRowShape = {
  itemId: ItemIdSchema,
  title: text(200),
  runs: count,
  tokens,
  sharePercent: limitPercent.optional(),
  costUsd: usd.optional(),
};

/**
 * One AI CLI's weekly window, with how it splits. `tokamaPercent` and `outsidePercent` are parts
 * of the limit (they add up to `usedPercent`); both are absent when the split is not known.
 */
const WeekLimitSchema = z.strictObject({
  cliId: AiCliIdSchema,
  window: text(64),
  startsAt: EpochMsSchema,
  endsAt: EpochMsSchema,
  usedPercent: limitPercent,
  tokamaPercent: limitPercent.optional(),
  outsidePercent: limitPercent.optional(),
});

const RetryCauseSchema = z.strictObject({
  kind: z.enum(["check", "review"]),
  /** For `check`: the first check that failed. */
  command: text(500).optional(),
  /** The item's repo, when it has one. */
  repoId: RepoIdSchema.optional(),
  templateId,
  /** The step that ran again. */
  stepId: StepIdSchema,
  agentId: AgentIdSchema,
  retries: count,
  itemCount: count,
  tokens,
  sharePercent: limitPercent.optional(),
  costUsd: usd.optional(),
});

const ModelRecordSchema = z.strictObject({
  model: modelName,
  cliId: AiCliIdSchema,
  runs: count,
  /** Runs that passed their checks on the first attempt; only for a step with checks. */
  firstTryPassed: count.optional(),
  avgAttempts: z.number().min(0),
  tokensPerRun: tokens,
  /** Part of the limit one run took, on average. */
  sharePerRun: limitPercent.optional(),
  costPerRun: usd.optional(),
  durationMsPerRun: z.int().nonnegative(),
});

/** What an item used: tokens, its part of each AI CLI's limit, and the attempts that repeated a step. */
export const ItemUsageSchema = z.strictObject({
  tokens,
  shares: z.array(z.strictObject({ cliId: AiCliIdSchema, sharePercent: limitPercent })).max(3).optional(),
  costUsd: usd.optional(),
  /** The cost is the price table's estimate, not the CLI's figure. */
  costEstimated: z.boolean().optional(),
  retries: z
    .array(
      z.strictObject({
        /** The step's place in the item's steps, as the item record lists them. */
        stepIndex: z.int().nonnegative(),
        /** The attempts that ran the step again. */
        attempts: z.array(z.int().min(1)).max(50),
        /** Their tokens as a share of the item's tokens. */
        tokensPercent: z.number().min(0).max(100),
        failingCheck: text(500).optional(),
      }),
    )
    .max(20)
    .optional(),
});

export const UsageReportSchema = z.strictObject({
  /** When the engine made the report. */
  asOf: EpochMsSchema,
  /** The date of the price table the estimates use, `YYYY-MM-DD`. */
  pricesAsOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  clis: z.array(CliPlanSchema).max(10),
  /**
   * Tokama's agent calls that ended on the current local day (a call over midnight counts in full):
   * the items with the most tokens, and the day's totals.
   */
  today: z
    .strictObject({
      /** Most tokens first, at most five. */
      items: z
        .array(
          z.strictObject({
            itemId: ItemIdSchema,
            title: z.string().min(1).max(200),
            /** Each agent once, in the order it first ran today. */
            agents: z.array(z.strictObject({ agentId: AgentIdSchema, cliId: AiCliIdSchema })).max(20),
            tokens,
            /** Wall time of the item's agent calls today. */
            durationMs: z.int().nonnegative(),
          }),
        )
        .max(5),
      itemCount: z.int().nonnegative(),
      tokens: TokenUsageSchema,
      durationMs: z.int().nonnegative(),
    })
    .optional(),
  /**
   * What used each AI CLI's limit in its weekly window (the one running now, or the one before):
   * Tokama's use by step, item, helper and retry cause. An AI CLI without a weekly window counts its
   * last 7 days. A share is a part of that CLI's own limit; shares of different CLIs are never added.
   * `costUsd` appears only for a CLI billed per use. Absent from older engines.
   */
  week: z
    .strictObject({
      window: UsageWindowSchema,
      limits: z.array(WeekLimitSchema).max(10),
      /** Per workflow, step, agent and model, most used first. */
      steps: z
        .array(
          z.strictObject({
            templateId,
            stepId: StepIdSchema,
            stepName: text(100),
            agentId: AgentIdSchema,
            cliId: AiCliIdSchema,
            model: modelName,
            /** Passed attempts: the step done once on an item. */
            runs: count,
            itemCount: count,
            tokens,
            /** Part of Tokama's use of this CLI in the window. */
            tokamaPercent: limitPercent,
            sharePercent: limitPercent.optional(),
            costUsd: usd.optional(),
            /** The cost is the price table's estimate, not the CLI's figure. */
            costEstimated: z.boolean().optional(),
            /** The items that used most, at most five. */
            items: z.array(z.strictObject(ItemRowShape)).max(5),
          }),
        )
        .max(100),
      /** The items that used most, at most 50, one row per item and AI CLI. */
      items: z.array(z.strictObject({ ...ItemRowShape, templateId, cliId: AiCliIdSchema })).max(50),
      /** Tokama's own helper calls. */
      helpers: z.array(z.strictObject({ cliId: AiCliIdSchema, model: modelName, calls: count, tokens, sharePercent: limitPercent.optional(), costUsd: usd.optional() })).max(20),
      /** What repeated attempts took, per AI CLI. `tokens` holds every retry, also those under no cause. */
      retries: z
        .array(z.strictObject({ cliId: AiCliIdSchema, tokens, sharePercent: limitPercent.optional(), causes: z.array(RetryCauseSchema).max(20) }))
        .max(10),
    })
    .optional(),
  /**
   * Per step, how each model did over the last 90 days. A model has a row from 5 runs, and a step
   * only when at least two models have one.
   */
  stepModels: z.array(z.strictObject({ templateId, stepId: StepIdSchema, stepName: text(100), models: z.array(ModelRecordSchema).min(2).max(20) })).max(100).optional(),
  /** The same per agent over the last 90 days: from 5 runs per model, one model is enough. */
  agentModels: z.array(z.strictObject({ agentId: AgentIdSchema, models: z.array(ModelRecordSchema).min(1).max(20) })).max(100).optional(),
});

export type TokenUsage = z.output<typeof TokenUsageSchema>;
export type AgentCallOutcome = z.output<typeof AgentCallOutcomeSchema>;
export type AgentCallErrorKind = z.output<typeof AgentCallErrorKindSchema>;
export type RateLimitWindow = z.output<typeof RateLimitWindowSchema>;
export type AgentCallEvent = z.output<typeof AgentCallEventSchema>;
export type AgentCallUsage = z.output<typeof AgentCallUsageSchema>;
export type PlanSnapshot = z.output<typeof PlanSnapshotSchema>;
export type PlanSource = z.output<typeof PlanSourceSchema>;
export type PlanWindow = z.output<typeof PlanWindowSchema>;
export type CliPlan = z.output<typeof CliPlanSchema>;

/** One reading of an AI CLI's plan windows, from whichever source gave it. */
export interface PlanReading {
  readonly windows: readonly PlanWindow[];
  readonly asOf: number;
  readonly plan?: string;
  readonly extraUsage?: "on" | "off";
  /** `pay_per_use`: the login bills per call and has no windows (an API key). */
  readonly billing?: "pay_per_use";
}
export type UsageReport = z.output<typeof UsageReportSchema>;
export type UsageWindow = z.output<typeof UsageWindowSchema>;
export type ItemUsage = z.output<typeof ItemUsageSchema>;
