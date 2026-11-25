import { describe, expect, it } from "vitest";
import { DecisionSchema, type AttemptRecord, type StoredDecision, type StoredItem, type StoredStep, type TemplateRecord } from "../../kernel/schemas/index.js";
import { explainStop } from "./explain.js";

const T = 1_000_000;
const MIN = 60_000;

const attempt = (n: number, startedAt: number, end: Partial<AttemptRecord> = {}): AttemptRecord => ({ attempt: n, startedAt, processes: [], checks: [], ...end });
const step = (id: string, attempts: AttemptRecord[], extra: Partial<StoredStep> = {}): StoredStep => ({ id: id as StoredStep["id"], state: "passed", attempts, ...extra });
const asked = (kind: StoredDecision["kind"], stepId: string | undefined, askedAt: number, choices: string[]): StoredDecision => ({
  id: `decision_${askedAt}` as StoredDecision["id"],
  kind,
  ...(stepId !== undefined && { stepId: stepId as StoredStep["id"] }),
  askedAt,
  choices: choices.map((id) => ({ id, label: id })),
});
const itemOf = (steps: StoredStep[], decisions: StoredDecision[] = []) => ({ steps, decisions }) as unknown as StoredItem;
const check = (command: string, passed: boolean) => ({ command, passed, exitCode: passed ? 0 : 1, at: T });

// Plan and build as the built-in template has it: Build retries on failed checks, Review sends the work back.
const template = {
  steps: [
    { id: "build", name: "Build", maxAttempts: 3, doneWhen: "checks pass", ifFailed: { action: "retry" } },
    { id: "review", name: "Review", maxAttempts: 1, doneWhen: "reviewer approves", ifFailed: { action: "stop" }, ifChangesRequested: { action: "back", stepId: "build" } },
    { id: "plan", name: "Plan", maxAttempts: 1, doneWhen: "you approve", ifFailed: { action: "ask" } },
  ],
} as unknown as TemplateRecord;

describe("explainStop", () => {
  it("a review at its limit after Build fixed it: nothing has checked the fix", () => {
    const review = step("review", [attempt(1, T, { endedAt: T + 10, result: "failed" })]);
    const build = step("build", [attempt(1, T - 50, { endedAt: T - 20, result: "passed" }), attempt(2, T + 20, { endedAt: T + 30, result: "passed", checks: [check("pnpm test", true), check("pnpm lint", true)] })]);
    const decision = asked("after_failure", "review", T + 40, ["one_more_attempt", "no_action_needed", "stop"]);
    const stopped = explainStop(itemOf([build, review], [decision]), decision, template);
    expect(stopped).toEqual({
      limit: true,
      then: { kind: "later", stepIndex: 0, attempt: 2, result: "passed", checks: { passed: 2, total: 2 } },
      why: "Review may run once per round, so it has not checked the fix.",
    });
    expect(DecisionSchema.shape.stopped.safeParse(stopped).success).toBe(true);
  });

  it("a later attempt that started in the same millisecond the stopped one ended still ran after it", () => {
    const review = step("review", [attempt(1, T, { endedAt: T + 10, result: "failed" })]);
    const build = step("build", [attempt(1, T - 50, { endedAt: T - 20, result: "passed" }), attempt(2, T + 10, { endedAt: T + 30, result: "passed" })]);
    const decision = asked("after_failure", "review", T + 40, ["one_more_attempt", "stop"]);
    expect(explainStop(itemOf([build, review], [decision]), decision, template)?.then).toEqual({ kind: "later", stepIndex: 0, attempt: 2, result: "passed" });
  });

  it("a checks step at its limit: its own failed checks, and every attempt failed them", () => {
    const failed = [check("pnpm test", false), check("pnpm lint", true), check("pnpm typecheck", false)];
    const build = step("build", [1, 2, 3].map((n) => attempt(n, T + n * 10, { endedAt: T + n * 10 + 5, result: "failed", checks: failed })));
    const decision = asked("after_failure", "build", T + 40, ["one_more_attempt", "no_action_needed", "stop"]);
    expect(explainStop(itemOf([build], [decision]), decision, template)).toEqual({
      limit: true,
      then: { kind: "checks_failed", failed: ["pnpm test", "pnpm typecheck"], total: 3 },
      why: "Build may run 3 times per round, and all 3 attempts ended with failed checks.",
    });
  });

  it("the round-trip cap names both steps", () => {
    const review = step("review", [attempt(1, T, { endedAt: T + 10, result: "failed" })], { sentBack: 3 });
    const decision = asked("after_failure", "review", T + 10, ["one_more_round", "no_action_needed", "stop"]);
    expect(explainStop(itemOf([step("build", []), review], [decision]), decision, template)).toEqual({
      limit: true,
      then: { kind: "none" },
      why: "Review sent the work back to Build 3 times, so Tokama asks before another round.",
    });
  });

  it("Retry step after a work failure: the same failure twice, or a template that asks", () => {
    const twice = step("build", [1, 2].map((n) => attempt(n, T + n * 10, { endedAt: T + n * 10 + 5, result: "failed", checks: [check("pnpm test", false)] })));
    const same = asked("after_failure", "build", T + 30, ["retry_step", "no_action_needed", "stop"]);
    expect(explainStop(itemOf([twice], [same]), same, template)).toMatchObject({ limit: false, why: "`pnpm test` failed with exit status 1 twice in a row." });
    const plan = step("plan", [attempt(1, T, { endedAt: T + 5, result: "failed" })]);
    const ask = asked("after_failure", "plan", T + 5, ["retry_step", "no_action_needed", "stop"]);
    expect(explainStop(itemOf([plan], [ask]), ask, template)).toEqual({ limit: false, then: { kind: "none" }, why: "The template asks you when Plan fails." });
  });

  it("a run failure of the step's attempt says how the call failed", () => {
    const timedOut = step("plan", [attempt(1, T, { endedAt: T + 20 * MIN, result: "run_failed", failure: "timeout", detail: "The agent call timed out." })]);
    const decision = asked("run_failure", "plan", T + 20 * MIN, ["retry_step", "stop"]);
    expect(explainStop(itemOf([timedOut], [decision]), decision, template)).toEqual({ limit: false, then: { kind: "none" }, why: "The agent call ran for 20 m (the limit)." });
    const silent = step("plan", [attempt(1, T, { endedAt: T + 12 * MIN, result: "run_failed", failure: "silent", detail: "Planner was silent for 10 m." })]);
    const quiet = asked("run_failure", "plan", T + 12 * MIN, ["retry_step", "stop"]);
    expect(explainStop(itemOf([silent], [quiet]), quiet, template)?.why).toBe("Planner was silent for 10 m.");
    const crashed = step("review", [attempt(1, T, { endedAt: T + 5, result: "run_failed", failure: "crash", detail: "The reviewer's reply did not end with VERDICT: approve or VERDICT: changes." })]);
    const noVerdict = asked("run_failure", "review", T + 5, ["retry_step", "stop"]);
    expect(explainStop(itemOf([crashed], [noVerdict]), noVerdict, template)?.why).toBe("The reviewer's reply did not end with VERDICT: approve or VERDICT: changes.");
  });

  it("explains nothing for other questions, or a run failure outside an attempt", () => {
    const build = step("build", [attempt(1, T, { endedAt: T + 5, result: "run_failed", failure: "crash" })]);
    const setup = asked("run_failure", undefined, T + 5, ["retry_step", "stop"]);
    const later = asked("run_failure", "build", T + 99, ["retry_step", "stop"]);
    const approval = asked("plan_approval", "build", T + 5, ["approve", "stop"]);
    for (const decision of [setup, later, approval]) expect(explainStop(itemOf([build], [decision]), decision, template)).toBeUndefined();
  });

  it("a step the template snapshot does not describe still explains itself by its id", () => {
    const fix = step("fix", [attempt(1, T, { endedAt: T + 5, result: "failed" })]);
    const decision = asked("after_failure", "fix", T + 5, ["one_more_attempt", "stop"]);
    expect(explainStop(itemOf([fix], [decision]), decision, undefined)).toEqual({ limit: true, then: { kind: "none" }, why: "fix reached its limit of attempts." });
  });
});
