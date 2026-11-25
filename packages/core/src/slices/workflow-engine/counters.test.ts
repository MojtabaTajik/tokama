import { describe, expect, it } from "vitest";
import type { AttemptRecord, StoredDecision, StoredItem, StoredStep } from "../../kernel/schemas/index.js";
import { countedAttempts } from "../items/index.js";
import { attemptLimit, budgetAllowedMs, budgetUsedMs, roundTripLimit, sameFailureTwice } from "./counters.js";

const T = 1_000_000;
const MIN = 60_000;

const attempt = (n: number, startedAt: number, end: Partial<AttemptRecord> = {}): AttemptRecord => ({
  attempt: n,
  startedAt,
  processes: [],
  checks: [],
  ...end,
});
const step = (attempts: AttemptRecord[]): StoredStep => ({ id: "build" as StoredStep["id"], state: "running", attempts });
const asked = (kind: StoredDecision["kind"], askedAt: number, resolved?: { choice: string; at: number }): StoredDecision => ({
  id: `decision_${askedAt}` as StoredDecision["id"],
  kind,
  stepId: "build" as StoredStep["id"],
  askedAt,
  choices: [],
  ...(resolved !== undefined && { resolved }),
});
const itemOf = (steps: StoredStep[], decisions: StoredDecision[] = []) => ({ steps, decisions }) as unknown as StoredItem;
const failedCheck = (command: string, exitCode: number, at: number) => ({ command, exitCode, passed: false, at });

describe("attemptLimit", () => {
  it("grants one attempt for each Retry answered at the limit, not below it", () => {
    const build = step([attempt(1, T, { endedAt: T + 10, result: "failed" }), attempt(2, T + 20, { endedAt: T + 30, result: "failed" })]);
    // Asked after attempt 1 (below a limit of 3) and after attempt 2 at a limit of 2.
    expect(attemptLimit(itemOf([build], [asked("after_failure", T + 10, { choice: "retry_step", at: T + 15 })]), build, 3)).toBe(3);
    expect(attemptLimit(itemOf([build], [asked("after_failure", T + 30, { choice: "retry_step", at: T + 35 })]), build, 2)).toBe(3);
    expect(attemptLimit(itemOf([build], [asked("plan_approval", T + 30, { choice: "retry_step", at: T + 35 })]), build, 2)).toBe(3);
    // Run failures do not count toward being at the limit.
    const runFailed = step([attempt(1, T, { endedAt: T + 10, result: "run_failed", failure: "crash" })]);
    expect(attemptLimit(itemOf([runFailed], [asked("after_failure", T + 10, { choice: "retry_step", at: T + 15 })]), runFailed, 1)).toBe(1);
  });

  it("counts the current round only: a grant from an earlier round does not carry over", () => {
    // Round 1: attempt 1 failed at a limit of 1, Retry once more, attempt 2 passed. Round 2 starts at attempt 3.
    const build = {
      ...step([attempt(1, T, { endedAt: T + 10, result: "failed" }), attempt(2, T + 20, { endedAt: T + 30, result: "passed" }), attempt(3, T + 40, { endedAt: T + 50, result: "failed" })]),
      roundStart: 2,
    };
    const item = itemOf([build], [asked("after_failure", T + 10, { choice: "one_more_attempt", at: T + 15 })]);
    expect(attemptLimit(item, build, 1)).toBe(1);
    expect(countedAttempts(build)).toBe(1);
    // A grant asked at the limit in this round counts.
    const granted = itemOf([build], [asked("after_failure", T + 50, { choice: "one_more_attempt", at: T + 55 })]);
    expect(attemptLimit(granted, build, 1)).toBe(2);
  });
});

describe("roundTripLimit", () => {
  it("allows 3 round trips, plus one for each Run one more round", () => {
    const review = { ...step([]), sentBack: 3 };
    expect(roundTripLimit(itemOf([review]), review)).toBe(3);
    expect(roundTripLimit(itemOf([review], [asked("after_failure", T, { choice: "one_more_round", at: T + 5 })]), review)).toBe(4);
    // Other answers grant nothing.
    expect(roundTripLimit(itemOf([review], [asked("after_failure", T, { choice: "one_more_attempt", at: T + 5 })]), review)).toBe(3);
  });
});

describe("sameFailureTwice", () => {
  it("compares the first failing check of the last two counted attempts", () => {
    const fail = (n: number, code: number) => attempt(n, T + n * 100, { endedAt: T + n * 100 + 50, result: "failed", checks: [failedCheck("pnpm test", code, T + n * 100 + 40)] });
    expect(sameFailureTwice(step([fail(1, 1), fail(2, 1)]))).toContain("twice in a row");
    expect(sameFailureTwice(step([fail(1, 1), fail(2, 2)]))).toBeUndefined();
    expect(sameFailureTwice(step([fail(1, 1), attempt(2, T + 200, { endedAt: T + 250, result: "run_failed", failure: "quota" }), fail(3, 1)]))).toContain("twice");
  });
});

describe("budget", () => {
  it("counts an attempt ended by an engine restart only up to its last recorded event", () => {
    const restarted = attempt(1, T, {
      // The engine was down for an hour before recovery ended the attempt.
      endedAt: T + 60 * MIN,
      result: "run_failed",
      failure: "engine_restart",
      processes: [{ role: "agent", pid: 42, startedAt: T + 1_000, bootTime: 0, hostId: "host_x" as never }],
      checks: [failedCheck("pnpm test", 1, T + 2 * MIN)],
    });
    expect(budgetUsedMs(itemOf([step([restarted])]), T + 61 * MIN)).toBe(2 * MIN);
  });

  it("leaves out the time a question asked during an attempt waited", () => {
    const open = attempt(1, T, { endedAt: T + 70 * MIN, result: "passed" });
    const tamper = asked("tamper", T + 5 * MIN, { choice: "approve", at: T + 65 * MIN });
    expect(budgetUsedMs(itemOf([step([open])], [tamper]), T + 80 * MIN)).toBe(10 * MIN);
  });

  it("Continue adds one budget on top of the time used when the engineer answered", () => {
    const long = attempt(1, T, { endedAt: T + 25 * MIN, result: "failed" });
    const budget = asked("budget", T + 25 * MIN, { choice: "continue", at: T + 90 * MIN });
    const item = itemOf([step([long])], [budget]);
    expect(budgetAllowedMs(itemOf([step([long])]), 10 * MIN)).toBe(10 * MIN);
    // 25 min used when Continue was chosen, plus one more 10-min budget.
    expect(budgetAllowedMs(item, 10 * MIN)).toBe(35 * MIN);
  });
});
