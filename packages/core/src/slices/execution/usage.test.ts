import { describe, expect, it } from "vitest";
import { AgentCallUsageSchema, type AgentId, type CallId, type StepId } from "../../kernel/schemas/index.js";
import type { GuardedCallResult } from "./guarded-call.js";
import { callUsage } from "./usage.js";

const T0 = Date.UTC(2026, 10, 25, 10, 0);
const tokens = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };

function call(end: Partial<GuardedCallResult["end"]>, plan?: GuardedCallResult["plan"]): GuardedCallResult {
  return {
    end: { type: "end", outcome: "completed", usage: tokens, ...end },
    guard: { stop: null, turns: 1, turnsAfterLastChange: 0, msAfterLastChange: 0, lastChangeAt: null, wastedMs: 0, loop: false },
    startedAt: T0,
    endedAt: T0 + 5_000,
    ...(plan !== undefined && { plan }),
  };
}

const input = { callId: "call_0190a000-0000-7000-8000-000000000001" as CallId, stepId: "build" as StepId, attempt: 1, agentId: "builder" as AgentId, cliId: "claude-code" as const, model: "claude-opus-5-5" };

describe("callUsage", () => {
  it("keeps the call's tokens, models, own cost, times and last plan windows", () => {
    const usage = callUsage({ ...input, call: call({ modelUsage: { "claude-opus-5-5": tokens }, costUsd: 0.12 }, { status: "allowed", windows: [{ window: "five_hour", usedPercent: 40 }], at: T0 + 1 }) });
    expect(usage).toEqual({ ...input, outcome: "completed", startedAt: T0, endedAt: T0 + 5_000, tokens, models: { "claude-opus-5-5": tokens }, reportedCostUsd: 0.12, plan: { status: "allowed", windows: [{ window: "five_hour", usedPercent: 40 }], at: T0 + 1 } });
    expect(AgentCallUsageSchema.safeParse(usage).success).toBe(true);
  });

  it("cuts what the CLI sent to the record's limits, so the record is never refused: 25 windows, a long status and long model names", () => {
    const windows = Array.from({ length: 25 }, (_, n) => ({ window: `w${n}`, usedPercent: n }));
    const long = "m".repeat(300);
    const usage = callUsage({ ...input, model: long, call: call({ modelUsage: { [long]: tokens } }, { status: "s".repeat(100), windows, at: T0 }) });
    expect(usage.plan?.windows).toHaveLength(20);
    expect(usage.plan?.status).toHaveLength(64);
    expect(usage.model).toHaveLength(200);
    expect(Object.keys(usage.models ?? {})).toEqual(["m".repeat(200)]);
    expect(AgentCallUsageSchema.safeParse(usage).success).toBe(true);
  });

  it("leaves out models when the CLI reported none, and keeps the end at or after the start", () => {
    const usage = callUsage({ ...input, call: { ...call({ modelUsage: {} }), endedAt: T0 - 1 } });
    expect(usage.models).toBeUndefined();
    expect(usage.endedAt).toBe(T0);
  });
});
