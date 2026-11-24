// Agent call shapes: the events an agent runtime emits and the usage record stored per call.
// Usage carries what v1 can measure now: tokens by type and wall time.
import { z } from "zod";
import { AgentIdSchema, CallIdSchema, EpochMsSchema, ItemIdSchema } from "./ids.js";

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
    /** Why the call failed, in words. */
    error: z.string().min(1).optional(),
    errorKind: AgentCallErrorKindSchema.optional(),
    /** The CLI's session id, for resuming the session later. */
    sessionId: z.string().min(1).optional(),
    /** Wall time from start to exit. */
    durationMs: z.int().nonnegative().optional(),
  }),
]);

export const AGENT_CALL_USAGE_SCHEMA_VERSION = 1;

export const AgentCallUsageSchema = z
  .strictObject({
    schemaVersion: z.literal(AGENT_CALL_USAGE_SCHEMA_VERSION),
    callId: CallIdSchema,
    itemId: ItemIdSchema,
    stepIndex: z.int().nonnegative(),
    agentId: AgentIdSchema,
    model: z.string().min(1),
    outcome: AgentCallOutcomeSchema,
    startedAt: EpochMsSchema,
    endedAt: EpochMsSchema,
    tokens: TokenUsageSchema,
  })
  .refine((usage) => usage.endedAt >= usage.startedAt, { message: "endedAt is before startedAt", path: ["endedAt"] });

export type TokenUsage = z.output<typeof TokenUsageSchema>;
export type AgentCallOutcome = z.output<typeof AgentCallOutcomeSchema>;
export type AgentCallErrorKind = z.output<typeof AgentCallErrorKindSchema>;
export type RateLimitWindow = z.output<typeof RateLimitWindowSchema>;
export type AgentCallEvent = z.output<typeof AgentCallEventSchema>;
export type AgentCallUsage = z.output<typeof AgentCallUsageSchema>;
