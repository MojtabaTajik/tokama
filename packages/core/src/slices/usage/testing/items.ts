// Items, attempts and calls for the usage tests. Times are local, so the tests do not depend on the
// machine's time zone.
import type { AgentCallUsage, AgentId, AttemptResult, DoneWhen, ItemId, RepoId, StepId } from "../../../kernel/schemas/index.js";
import type { RunAttempt, RunItem, RunStep } from "../runs.js";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const NOW = new Date(2025, 9, 20, 15, 0).getTime();

export const MILLION = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };

let calls = 0;
export function call(fields: Partial<AgentCallUsage> & { stepId: string; attempt: number; endedAt: number }): AgentCallUsage {
  calls++;
  const { stepId, ...rest } = fields;
  return {
    callId: `call_0190a000-0000-7000-8000-${String(calls).padStart(12, "0")}` as AgentCallUsage["callId"],
    stepId: stepId as StepId,
    agentId: "builder" as AgentId,
    cliId: "claude-code",
    model: "claude-sonnet-5-5",
    outcome: "completed",
    startedAt: fields.endedAt - 5 * MINUTE,
    tokens: { input: 10_000, output: 1_000, cacheRead: 0, cacheWrite: 0 },
    ...rest,
  };
}

/** An attempt that ended at `endedAt` after ten minutes; `checks` are `[command, passed]`. */
export function attempt(n: number, result: AttemptResult | undefined, endedAt: number, checks: readonly (readonly [string, boolean])[] = []): RunAttempt {
  return { attempt: n, ...(result !== undefined && { result }), startedAt: endedAt - 10 * MINUTE, endedAt, checks: checks.map(([command, passed]) => ({ command, passed })) };
}

export const step = (id: string, doneWhen: DoneWhen | undefined, attempts: RunAttempt[], agentId = "builder"): RunStep => ({ id: id as StepId, name: id[0]!.toUpperCase() + id.slice(1), agentId: agentId as AgentId, ...(doneWhen !== undefined && { doneWhen }), attempts });

let items = 0;
export function item(steps: RunStep[], itemCalls: AgentCallUsage[], fields: Partial<Pick<RunItem, "title" | "templateId" | "repoIds">> = {}): RunItem {
  items++;
  return {
    itemId: `item_0190a000-0000-7000-8000-${String(items).padStart(12, "0")}` as ItemId,
    title: fields.title ?? `Item ${items}`,
    templateId: fields.templateId ?? "builtin/plan-and-build",
    repoIds: fields.repoIds ?? (["orders-api"] as RepoId[]),
    steps,
    calls: itemCalls,
  };
}
