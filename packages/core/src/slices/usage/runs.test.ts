import { describe, expect, it } from "vitest";
import type { AgentCallUsage } from "../../kernel/schemas/index.js";
import { retriesOf, runsOf } from "./runs.js";
import { attempt, call, HOUR, item, NOW, step } from "./testing/items.js";

const at = (hours: number) => NOW - 30 * HOUR + hours * HOUR;
const c = (stepId: string, n: number, hours: number, over: Partial<AgentCallUsage> = {}) => call({ ...over, stepId, attempt: n, endedAt: at(hours) });

describe("runs", () => {
  it("is one run per passing attempt, with the failed attempts before it", () => {
    const build = step("build", "checks pass", [attempt(1, "failed", at(1), [["pnpm test", false]]), attempt(2, "failed", at(2), [["pnpm test", false]]), attempt(3, "passed", at(3), [["pnpm test", true]])]);
    const runs = runsOf(item([build], [c("build", 1, 1), c("build", 2, 2), c("build", 3, 3, { model: "claude-opus-5-5" })]));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ attempts: [1, 2, 3], model: "claude-opus-5-5", endedAt: at(3), firstTry: false });
    expect(runs[0]?.calls).toHaveLength(3);
  });

  it("is a second run when the step passes again after being sent back, and none for attempts that never passed", () => {
    const build = step("build", "checks pass", [attempt(1, "passed", at(1), [["pnpm test", true]]), attempt(2, "failed", at(4), [["pnpm test", false]]), attempt(3, "passed", at(5), [["pnpm test", true]]), attempt(4, "failed", at(7))]);
    const runs = runsOf(item([build], [c("build", 1, 1), c("build", 2, 4), c("build", 3, 5), c("build", 4, 7)]));
    expect(runs.map((run) => run.attempts)).toEqual([[1], [2, 3]]);
    // The attempt that never passed is no run, and its call is in no run.
    expect(runs.flatMap((run) => run.calls)).toHaveLength(3);
  });

  it("does not count an attempt whose run failed or that was stopped, but keeps its tokens in the run", () => {
    const build = step("build", "checks pass", [attempt(1, "run_failed", at(1)), attempt(2, "stopped", at(2)), attempt(3, "passed", at(3), [["pnpm test", true]])]);
    const [run] = runsOf(item([build], [c("build", 1, 1), c("build", 2, 2), c("build", 3, 3)]));
    expect(run?.attempts).toEqual([3]);
    expect(run?.calls).toHaveLength(3);
    // Attempt 3 is the step's first counted attempt but not its attempt 1: not a first try.
    expect(run?.firstTry).toBe(false);
  });

  it("is a first try only on a step with checks, with one counted attempt, the step's attempt 1", () => {
    const withChecks = step("build", "checks pass", [attempt(1, "passed", at(1), [["pnpm test", true]])]);
    const agentOnly = step("fix", "agent finishes", [attempt(1, "passed", at(2))]);
    const reviewer = step("review", "reviewer approves", [attempt(1, "passed", at(3))]);
    const runs = runsOf(item([withChecks, agentOnly, reviewer], [c("build", 1, 1), c("fix", 1, 2), c("review", 1, 3)]));
    expect(runs.map((run) => [run.step.id, run.firstTry])).toEqual([["build", true], ["fix", undefined], ["review", undefined]]);
  });

  it("takes the model of the passing attempt and the agent that made the call", () => {
    const build = step("build", "checks pass", [attempt(1, "failed", at(1)), attempt(2, "passed", at(2))]);
    const [run] = runsOf(item([build], [c("build", 1, 1, { model: "claude-haiku-5-5" }), c("build", 2, 2, { model: "claude-opus-5-5", agentId: "senior" as never })]));
    expect(run).toMatchObject({ model: "claude-opus-5-5", agentId: "senior", cliId: "claude-code" });
  });

  it("leaves out a run with no call at all, and an item whose attempts have no result yet", () => {
    expect(runsOf(item([step("build", "checks pass", [attempt(1, "passed", at(1))])], []))).toEqual([]);
    expect(runsOf(item([step("build", "checks pass", [attempt(1, undefined, at(1))])], [c("build", 1, 1)]))).toEqual([]);
  });
});

describe("retries", () => {
  const BUILD_FAILS = [attempt(1, "failed", at(1), [["pnpm lint", true], ["pnpm test", false], ["pnpm e2e", false]]), attempt(2, "passed", at(2), [["pnpm test", true]])];

  it("is every counted attempt after the first, with the first failing check as its cause", () => {
    const retries = retriesOf(item([step("build", "checks pass", BUILD_FAILS)], [c("build", 1, 1), c("build", 2, 2)]));
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ attempt: 2, cause: { kind: "check", command: "pnpm test" } });
    expect(retries[0]?.calls).toHaveLength(1);
  });

  it("is a retry after a reviewer's failed attempt, with the cause review, for the reviewer's own step", () => {
    const review = step("review", "reviewer approves", [attempt(1, "failed", at(1)), attempt(2, "passed", at(2))], "reviewer");
    expect(retriesOf(item([review], [c("review", 1, 1, { agentId: "reviewer" as never }), c("review", 2, 2, { agentId: "reviewer" as never })]))[0]).toMatchObject({ attempt: 2, cause: { kind: "review" } });
  });

  it("is a retry for the step that was sent back, under the cause of the step that sent it", () => {
    const build = step("build", "checks pass", [attempt(1, "passed", at(1), [["pnpm test", true]]), attempt(2, "passed", at(4), [["pnpm test", true]])]);
    const review = step("review", "reviewer approves", [attempt(1, "failed", at(3))], "reviewer");
    const retries = retriesOf(item([build, review], [c("build", 1, 1), c("review", 1, 3, { agentId: "reviewer" as never }), c("build", 2, 4)]));
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ attempt: 2, cause: { kind: "review" } });
    expect(retries[0]?.step.id).toBe("build");
  });

  it("takes the latest failure between the two attempts as the one that sent the step back", () => {
    const build = step("build", "checks pass", [attempt(1, "passed", at(1), [["pnpm test", true]]), attempt(2, "passed", at(6), [["pnpm test", true]])]);
    const verify = step("verify", "checks pass", [attempt(1, "failed", at(2), [["pnpm e2e", false]]), attempt(2, "failed", at(4), [["pnpm lint", false]])]);
    expect(retriesOf(item([build, verify], [c("build", 1, 1), c("verify", 1, 2), c("verify", 2, 4), c("build", 2, 6)])).find((r) => r.step.id === "build")?.cause).toEqual({ kind: "check", command: "pnpm lint" });
  });

  it("has no cause when an agent-finishes step failed, when a person asked for changes, or when nothing sent the step back", () => {
    const agentOnly = step("fix", "agent finishes", [attempt(1, "failed", at(1)), attempt(2, "passed", at(2))]);
    expect(retriesOf(item([agentOnly], [c("fix", 1, 1), c("fix", 2, 2)]))).toMatchObject([{ attempt: 2, cause: undefined }]);
    const approve = step("plan", "you approve", [attempt(1, "failed", at(1)), attempt(2, "passed", at(2))]);
    expect(retriesOf(item([approve], [c("plan", 1, 1), c("plan", 2, 2)]))).toMatchObject([{ attempt: 2, cause: undefined }]);
    const alone = step("build", "checks pass", [attempt(1, "passed", at(1), [["pnpm test", true]]), attempt(2, "passed", at(3), [["pnpm test", true]])]);
    expect(retriesOf(item([alone], [c("build", 1, 1), c("build", 2, 3)]))).toMatchObject([{ attempt: 2, cause: undefined }]);
  });

  it("does not take an attempt whose run failed for the work: the next counted one is the first", () => {
    const build = step("build", "checks pass", [attempt(1, "run_failed", at(1)), attempt(2, "failed", at(2), [["pnpm test", false]]), attempt(3, "passed", at(3), [["pnpm test", true]])]);
    const retries = retriesOf(item([build], [c("build", 1, 1), c("build", 2, 2), c("build", 3, 3)]));
    expect(retries.map((r) => [r.attempt, r.cause])).toEqual([[3, { kind: "check", command: "pnpm test" }]]);
  });

  it("is never also a first try: a run has a retry exactly when it is not a first try", () => {
    const shapes = [
      [attempt(1, "passed", at(1), [["pnpm test", true]])],
      BUILD_FAILS,
      [attempt(1, "run_failed", at(1)), attempt(2, "passed", at(2), [["pnpm test", true]])],
      [attempt(1, "passed", at(1), [["pnpm test", true]]), attempt(2, "passed", at(3), [["pnpm test", true]])],
      [attempt(1, "failed", at(1), [["pnpm test", false]]), attempt(2, "failed", at(2), [["pnpm test", false]])],
    ];
    for (const attempts of shapes) {
      const one = item([step("build", "checks pass", attempts)], attempts.map((a) => c("build", a.attempt, 1 + a.attempt)));
      const retried = new Set(retriesOf(one).map((r) => r.attempt));
      for (const run of runsOf(one)) {
        const hasRetry = run.attempts.some((n) => retried.has(n));
        // A first try holds no retry. A run that is not a first try may hold none: a pass after a send-back
        // is its own run with one attempt that is the retry, and an attempt after a crash is its step's first.
        if (run.firstTry === true) expect(hasRetry).toBe(false);
        if (hasRetry) expect(run.firstTry).toBe(false);
      }
    }
  });
});
