// Agent call shapes: the events an agent runtime emits, the usage record stored per call, and the
// usage report the engine serves: plan windows per AI CLI, and tokens and estimated cost per day,
// workflow and item.
import { z } from "zod";
import { AgentIdSchema, AiCliIdSchema, CallIdSchema, EpochMsSchema, HelperIdSchema, ItemIdSchema, RepoIdSchema, StepIdSchema } from "./ids.js";

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

/** The days the usage report covers, ending today. */
export const UsageRangeSchema = z.union([z.literal(14), z.literal(30), z.literal(90)]);

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
  /** Why the windows are unknown or old, in plain words. */
  note: z.string().min(1).max(500).optional(),
});

const tokens = z.int().nonnegative();
/** US dollars; null when no call of the group could be priced. */
const cost = z.number().nonnegative().nullable();
/**
 * The workflow key exactly as item records carry it, so clients match it with the setup's templates
 * the same way they match items.
 */
const templateId = z.string().min(1).max(200);

/**
 * Which usage the report counts: `tokama`, the agent calls Tokama ran; `all`, every Claude Code
 * call on this machine from its session logs (Tokama's included), plus Tokama's calls on other CLIs.
 */
export const UsageScopeSchema = z.enum(["tokama", "all"]);

const percent = z.number().min(0).max(100);

/** Where the tokens went, over the scope and range. */
export const TokenSummarySchema = z.strictObject({
  /** Every token: input, cache reads, cache writes and output. */
  processed: tokens,
  /** Input read from the prompt cache. */
  cachedInput: tokens,
  /** Cached input as a share of all input. */
  cachedInputPercent: percent,
  /** Input not read from the cache: plain input and cache writes. */
  uncachedInput: tokens,
  output: tokens,
  /** What the cached input would have cost more at the input price; null when no cached model has a price. */
  cacheSavingsUsd: cost,
  /** The input price over the cache-read price, weighted by cached tokens: how many times cheaper the cache was. */
  cacheSavingsFactor: z.number().min(0).nullable(),
});

/** Where the engine is in reading Claude Code's session logs, for the `all` scope. */
export const LogScanSchema = z.strictObject({
  /** `scanning`: the numbers grow until it ends. `unavailable`: see the note. */
  state: z.enum(["scanning", "ready", "unavailable"]),
  filesDone: z.int().nonnegative(),
  filesTotal: z.int().nonnegative(),
  /** When the last scan ended. */
  asOf: EpochMsSchema.optional(),
  note: z.string().min(1).max(500).optional(),
});

export const UsageItemSchema = z.strictObject({
  itemId: ItemIdSchema,
  title: z.string().min(1).max(200),
  templateId,
  /** Each agent once, in the order it first ran. */
  agents: z.array(z.strictObject({ agentId: AgentIdSchema, cliId: AiCliIdSchema })).max(20),
  tokens: TokenUsageSchema,
  /** Wall time of the item's agent calls. */
  durationMs: z.int().nonnegative(),
  costUsd: cost,
  /** Every call ran on a local model: it cost nothing. */
  local: z.boolean(),
});

export const UsageReportSchema = z.strictObject({
  range: UsageRangeSchema,
  /** When the engine made the report. */
  asOf: EpochMsSchema,
  /** The date of the price table the estimates use, `YYYY-MM-DD`. */
  pricesAsOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  clis: z.array(CliPlanSchema).max(10),
  /** The scope counted; absent means `tokama`. */
  scope: UsageScopeSchema.optional(),
  /** Every day of the range, oldest first, in the engine's local time. */
  days: z
    .array(
      z.strictObject({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        /** The scope's tokens that day. */
        tokens: tokens.optional(),
        /** The scope's estimated cost that day. */
        costUsd: cost.optional(),
        /** Tokama's workflows with calls that day, whatever the scope. */
        workflows: z
          .array(
            z.strictObject({
              templateId,
              tokens,
              costUsd: cost,
              /** The items with calls that day, most tokens first, at most five. */
              items: z.array(z.strictObject({ itemId: ItemIdSchema, title: z.string().min(1).max(200) })).max(5),
              itemCount: z.int().nonnegative(),
            }),
          )
          .max(100),
      }),
    )
    .max(90),
  /** Totals per Tokama workflow over the range, most tokens first, whatever the scope. */
  workflows: z.array(z.strictObject({ templateId, tokens, costUsd: cost, calls: z.int().nonnegative() })).max(100),
  /** The Tokama items with the most tokens over the range, at most 50, whatever the scope. */
  items: z.array(UsageItemSchema).max(50),
  /**
   * Tokama's agent calls that ended on the current local day (a call over midnight counts in full),
   * whatever the range and scope: the items with the most tokens, and the day's totals. Absent
   * from older engines.
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
  /** The scope's totals. */
  totals: z.strictObject({
    tokens: TokenUsageSchema,
    costUsd: cost,
    /** Agent calls; in the `all` scope, each message of Claude Code's logs counts as one. */
    calls: z.int().nonnegative(),
    /** Calls neither the CLI nor the price table could price; their cost is left out. */
    unpricedCalls: z.int().nonnegative(),
  }),
  tokenSummary: TokenSummarySchema.optional(),
  /** The scope's tokens and cost per model, most expensive first, at most 50. */
  models: z
    .array(
      z.strictObject({
        model: z.string().min(1).max(200),
        cliId: AiCliIdSchema,
        tokens,
        costUsd: cost,
        /** The model's share of the priced cost; null when the model has no price. */
        sharePercent: percent.nullable(),
      }),
    )
    .max(50)
    .optional(),
  /** The scope's tokens and cost per repo, most tokens first. `repoId` null: work outside the configured repos. */
  repos: z.array(z.strictObject({ repoId: RepoIdSchema.nullable(), tokens, costUsd: cost })).max(100).optional(),
  /** Present in the `all` scope. */
  scan: LogScanSchema.optional(),
  /**
   * Tokama's own helper calls over the range, most tokens first, whatever the scope. Absent from
   * older engines. A separate list: whether `totals` also count these calls is up to the engine,
   * so a client must not add the two.
   */
  helpers: z.array(z.strictObject({ helperId: HelperIdSchema, tokens: TokenUsageSchema, costUsd: cost, calls: z.int().nonnegative() })).max(20).optional(),
});

export type TokenUsage = z.output<typeof TokenUsageSchema>;
export type AgentCallOutcome = z.output<typeof AgentCallOutcomeSchema>;
export type AgentCallErrorKind = z.output<typeof AgentCallErrorKindSchema>;
export type RateLimitWindow = z.output<typeof RateLimitWindowSchema>;
export type AgentCallEvent = z.output<typeof AgentCallEventSchema>;
export type AgentCallUsage = z.output<typeof AgentCallUsageSchema>;
export type PlanSnapshot = z.output<typeof PlanSnapshotSchema>;
export type UsageRange = z.output<typeof UsageRangeSchema>;
export type PlanSource = z.output<typeof PlanSourceSchema>;
export type PlanWindow = z.output<typeof PlanWindowSchema>;
export type CliPlan = z.output<typeof CliPlanSchema>;
export type UsageItem = z.output<typeof UsageItemSchema>;
export type UsageScope = z.output<typeof UsageScopeSchema>;
export type TokenSummary = z.output<typeof TokenSummarySchema>;
export type LogScan = z.output<typeof LogScanSchema>;
export type UsageReport = z.output<typeof UsageReportSchema>;
