import type { ItemRecord } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { checkAttempts, checksOf, checksWords, doneFacts, factsOf, failedFacts, failureLine, finishedLine } from "./item-facts.js";

const check = (command: string, passed = true) => ({ command, passed, exitCode: passed ? 0 : 1 });
const attempt = (n: number, checks: ReturnType<typeof check>[], fields: Record<string, unknown> = {}) => ({ attempt: n, result: checks.every((c) => c.passed) ? "passed" : "failed", checks, ...fields });
const step = (name: string, state: string, fields: Record<string, unknown> = {}) => ({ name, state, stage: "working", data: "none", ...fields });
const item = (fields: Record<string, unknown> = {}): ItemRecord => ({ kind: "task", state: "done", steps: [], ...fields }) as unknown as ItemRecord;

const THREE = [check("pnpm typecheck"), check("pnpm lint"), check("pnpm test")];

describe("checkAttempts", () => {
  it("lists each step's latest attempt that ran checks, with its step, and none for steps without", () => {
    const build = step("Build", "passed", { attempts: [attempt(1, [check("pnpm test", false)]), attempt(2, THREE), attempt(3, [], { result: "run_failed" })] });
    const found = checkAttempts(item({ steps: [step("Plan", "passed"), build] }));
    expect(found.map(({ step: { name }, attempt: { attempt: n } }) => [name, n])).toEqual([["Build", 2]]);
  });
});

describe("checksOf", () => {
  it("adds up the latest attempt with checks of each step", () => {
    const build = step("Build", "passed", { attempts: [attempt(1, [check("pnpm test", false)]), attempt(2, THREE)] });
    const verify = step("Verify", "passed", { attempts: [attempt(1, [check("pnpm e2e", false)])] });
    expect(checksOf(item({ steps: [step("Plan", "passed"), build, verify] }))).toEqual({ passed: 3, total: 4 });
  });

  it("looks past a later attempt that ran no checks, and counts none for a step without any", () => {
    const build = step("Build", "passed", { attempts: [attempt(1, THREE), attempt(2, [], { result: "run_failed" })] });
    expect(checksOf(item({ steps: [build] }))).toEqual({ passed: 3, total: 3 });
    expect(checksOf(item({ steps: [step("Plan", "passed", { attempts: [attempt(1, [])] })] }))).toBeUndefined();
  });

  it("is undefined for an item from before checks were recorded", () => {
    expect(checksOf(item({ steps: [step("Build", "passed")] }))).toBeUndefined();
    expect(checksWords(item())).toBeUndefined();
  });

  it("says it in words for a banner", () => {
    expect(checksWords(item({ steps: [step("Build", "passed", { attempts: [attempt(1, THREE)] })] }))).toBe("checks 3/3 passed");
  });
});

describe("doneFacts", () => {
  const withChecks = (checks: ReturnType<typeof check>[]) => item({ steps: [step("Build", "passed", { attempts: [attempt(1, checks)] })] });

  it("names the checks with no symbol when all passed", () => {
    expect(doneFacts(withChecks(THREE))).toEqual([{ text: "checks 3/3" }]);
  });

  it("marks checks that did not pass with a symbol and a word", () => {
    expect(doneFacts(withChecks([check("a"), check("b", false), check("c")]))).toEqual([{ text: "checks 2/3", mark: { symbol: "✕", tone: "fail", word: "failed" } }]);
  });

  it("says no checks for a task from before they were recorded, and nothing for an investigation", () => {
    expect(doneFacts(item())).toEqual([{ text: "no checks" }]);
    expect(doneFacts(item({ kind: "investigation" }))).toEqual([]);
  });
});

describe("failedFacts and failureLine", () => {
  const failing = () => attempt(3, [check("pnpm lint"), check("pnpm test", false), check("pnpm typecheck")]);
  const build = (fields: Record<string, unknown> = {}) => step("Build", "failed", { runs: 3, attempts: [failing(), failing(), failing()], ...fields });
  const crashed = (steps: unknown[], fields: Record<string, unknown> = {}) => item({ state: "failed", steps, ...fields });

  it("names the failing check, its runs, where it stopped and the checks that did not pass", () => {
    const failed = crashed([step("Plan", "passed"), build(), step("Review", "pending")]);
    expect(failedFacts(failed)).toEqual([{ text: "pnpm test failed 3 times" }, { text: "stopped at Build, step 2 of 3" }, { text: "checks 2/3", mark: { symbol: "✕", tone: "fail", word: "failed" } }]);
    expect(failureLine(failed)).toBe("Stopped at Build, step 2 of 3: pnpm test failed 3 times");
  });

  it("counts the attempts in which that check failed, not the runs of the step", () => {
    const attempts = [attempt(1, [check("pnpm test", false)]), attempt(2, [], { result: "run_failed" }), attempt(3, [check("pnpm test", false)])];
    expect(failureLine(crashed([step("Build", "failed", { runs: 2, attempts })]))).toBe("Stopped at Build, step 1 of 1: pnpm test failed 2 times");
    // Another check failed first: pnpm test failed once in two runs.
    const other = [attempt(1, [check("pnpm lint", false), check("pnpm test")]), attempt(2, [check("pnpm lint"), check("pnpm test", false)])];
    expect(failureLine(crashed([step("Build", "failed", { runs: 2, attempts: other })]))).toBe("Stopped at Build, step 1 of 1: pnpm test failed");
  });

  it("gives the step's own line when no check failed, as for a crash", () => {
    const failed = crashed([step("Build", "failed", { detail: "the agent crashed" })]);
    expect(failedFacts(failed)).toEqual([{ text: "the agent crashed" }, { text: "stopped at Build, step 1 of 1" }]);
    expect(failureLine(failed)).toBe("Stopped at Build, step 1 of 1: the agent crashed");
  });

  it("falls back to the item's outcome when the step has no line", () => {
    const failed = crashed([step("Build", "failed")], { outcome: { kind: "failed", detail: "The engine stopped." } });
    expect(failureLine(failed)).toBe("Stopped at Build, step 1 of 1: The engine stopped.");
  });

  it("names the step the item was in when none is marked failed, and only the outcome when it has no steps", () => {
    const stopped = crashed([step("Plan", "passed"), step("Build", "running")], { outcome: { kind: "failed", detail: "The engine stopped." } });
    expect(failureLine(stopped)).toBe("Stopped at Build, step 2 of 2: The engine stopped.");
    expect(failureLine(crashed([step("Build", "running")]))).toBe("Stopped at Build, step 1 of 1");
    expect(failureLine(crashed([], { outcome: { kind: "failed", detail: "The engine stopped." } }))).toBe("The engine stopped.");
    expect(failedFacts(crashed([], { outcome: { kind: "failed", detail: "The engine stopped." } }))).toEqual([{ text: "The engine stopped." }]);
  });

  it("never says that a step failed without saying which, and gives no facts for an item with nothing recorded", () => {
    expect(failureLine(crashed([]))).toBe("Stopped.");
    expect(failedFacts(crashed([]))).toEqual([]);
  });

  it("leaves out the checks when they all passed", () => {
    const failed = crashed([step("Build", "failed", { detail: "timed out", attempts: [attempt(1, THREE)] })]);
    expect(failedFacts(failed).map((fact) => fact.text)).toEqual(["timed out", "stopped at Build, step 1 of 1"]);
  });
});

describe("finishedLine", () => {
  const checked = item({ steps: [step("Build", "passed", { attempts: [attempt(1, THREE)] })] });
  it("says the time and the checks, then what can be done", () => {
    expect(finishedLine(checked, "9 min", true)).toBe("Done in 9 min · checks 3/3 passed. Ready to merge or open a PR.");
    expect(finishedLine(checked, "9 min", false)).toBe("Done in 9 min · checks 3/3 passed.");
  });
  it("leaves the checks out when there were none, and ends with the outcome's own line", () => {
    expect(finishedLine(item({ outcome: { kind: "no_action_needed", detail: "Nothing to change." } }), "1 h", false)).toBe("Done in 1 h. Nothing to change.");
  });
});

describe("factsOf", () => {
  it("gives the facts of a done or failed item and none for another", () => {
    expect(factsOf(item())).toEqual([{ text: "no checks" }]);
    expect(factsOf(item({ state: "failed", steps: [step("Build", "failed", { detail: "x" })] })).map((fact) => fact.text)).toEqual(["x", "stopped at Build, step 1 of 1"]);
    expect(factsOf(item({ state: "running" }))).toEqual([]);
    expect(factsOf(item({ state: "stopped" }))).toEqual([]);
  });
});
