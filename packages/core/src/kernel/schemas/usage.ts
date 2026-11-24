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

/** One event of an agent call's stream. Every stream ends with exactly one `end` event. */
export const AgentCallEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string() }),
  z.strictObject({
    type: z.literal("end"),
    outcome: AgentCallOutcomeSchema,
    /** Tokens used so far; partial when the call failed or was aborted. */
    usage: TokenUsageSchema,
    /** Why the call failed, in words. */
    error: z.string().min(1).optional(),
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
export type AgentCallEvent = z.output<typeof AgentCallEventSchema>;
export type AgentCallUsage = z.output<typeof AgentCallUsageSchema>;
