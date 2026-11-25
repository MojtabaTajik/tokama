// The usage record of one agent call: what its own output reported, plus who ran it and when.
// Values from the CLI are cut to the record's limits, so an odd stream never loses the record.
import type { AgentCallUsage, AgentId, AiCliId, CallId, PlanSnapshot, StepId } from "../../kernel/schemas/index.js";
import type { GuardedCallResult } from "./guarded-call.js";

export interface CallUsageInput {
  readonly callId: CallId;
  readonly stepId: StepId;
  readonly attempt: number;
  readonly agentId: AgentId;
  readonly cliId: AiCliId;
  readonly model: string;
  readonly call: GuardedCallResult;
}

const MODEL_CHARS = 200;
const STATUS_CHARS = 64;
const MAX_WINDOWS = 20;

const planOf = (plan: PlanSnapshot): PlanSnapshot => ({ status: plan.status.slice(0, STATUS_CHARS), windows: plan.windows.slice(0, MAX_WINDOWS), at: plan.at });

/** Tokens, wall time, the CLI's own cost and the last plan windows of a finished call. */
export function callUsage({ callId, stepId, attempt, agentId, cliId, model, call }: CallUsageInput): AgentCallUsage {
  const { end, startedAt, endedAt, plan } = call;
  return {
    callId,
    stepId,
    attempt,
    agentId,
    cliId,
    model: model.slice(0, MODEL_CHARS),
    outcome: end.outcome,
    startedAt,
    endedAt: Math.max(startedAt, endedAt),
    tokens: end.usage,
    ...(end.modelUsage !== undefined && Object.keys(end.modelUsage).length > 0 && { models: Object.fromEntries(Object.entries(end.modelUsage).map(([name, tokens]) => [name.slice(0, MODEL_CHARS), tokens])) }),
    ...(end.costUsd !== undefined && { reportedCostUsd: end.costUsd }),
    ...(plan !== undefined && { plan: planOf(plan) }),
  };
}
