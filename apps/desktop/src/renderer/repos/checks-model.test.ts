import { HELPER_LOCAL_ONLY, HELPER_NO_CLI } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { availability, breaksRule, checkLines, failureOf, lineOf, summaryOf, tryProblem } from "./checks-model.js";

describe("breaksRule", () => {
  it.each(["npm test && npm run lint", "make a | tee out", "echo a; echo b", "npm test > out.txt", "cat < in", "echo `id`", "echo $(id)", "sleep 1 &", "npm test 2>&1"])("flags %s", (command) => {
    expect(breaksRule(command)).toBe(true);
  });

  it.each(["npm test", "pnpm --filter @tokama/desktop e2e", "grep \"a|b\" file", "echo 'a && b'", "echo \"$HOME\"", "node --check src/main.js"])("leaves %s", (command) => {
    expect(breaksRule(command)).toBe(false);
  });

  it("does not let an escaped quote end a quote early", () => {
    expect(breaksRule('echo "a \\" | b"')).toBe(false);
    expect(breaksRule('echo "a" | b')).toBe(true);
  });
});

describe("checkLines and tryProblem", () => {
  it("trims lines and drops the empty ones", () => {
    expect(checkLines("  npm test \n\n npm run lint\n")).toEqual(["npm test", "npm run lint"]);
  });

  it("names the line that breaks the rule, and the cap", () => {
    expect(tryProblem(["npm test", "a && b"])).toMatch(/^Line 2 is more than one command\./);
    expect(tryProblem(["npm test"])).toBeUndefined();
    expect(tryProblem(Array.from({ length: 21 }, (_, i) => `cmd${i}`))).toBe("Try checks runs at most 20 checks.");
  });
});

describe("availability", () => {
  const base = { helperId: "suggest-checks", name: "Suggest checks", version: 1, sends: [] as string[] } as const;
  it("reads the engine's words for no AI CLI and local-only mode (pinned to the engine's constants)", () => {
    expect(availability({ ...base, available: false, problem: HELPER_NO_CLI })).toEqual({ kind: "no_cli" });
    expect(availability({ ...base, available: false, problem: HELPER_LOCAL_ONLY })).toEqual({ kind: "local_only" });
    expect(availability({ ...base, available: false, problem: "The agent helper is not set up." })).toEqual({ kind: "unavailable", problem: "The agent helper is not set up." });
    expect(availability({ ...base, available: true })).toEqual({ kind: "ready" });
    expect(availability(undefined)).toBeUndefined();
  });
});

describe("failureOf", () => {
  it("picks a head by code and keeps the engine's sentence; a refused folder is not called a crash", () => {
    expect(failureOf({ code: "bad_answer", message: "x" })).toMatchObject({ head: "No usable answer.", action: "retry" });
    expect(failureOf({ code: "auth", message: "x" })).toMatchObject({ head: "Logged out.", action: "get-started" });
    expect(failureOf({ code: "crash", message: "This is the home folder, not a project's." })).toEqual({ head: "Could not suggest checks.", message: "This is the home folder, not a project's.", action: "retry" });
  });
});

describe("trial lines", () => {
  it("words each state", () => {
    expect(lineOf({ command: "a", state: "failed", exitCode: 2, durationMs: 14_000, outputTail: "x" })).toMatchObject({ word: "Failed, exit 2", tone: "fail", hasOutput: true, time: "14 s" });
    expect(lineOf({ command: "a", state: "failed" })).toMatchObject({ word: "Could not start", hasOutput: false });
    expect(lineOf({ command: "a", state: "passed", durationMs: 1200 })).toMatchObject({ word: "Passed", tone: "pass", time: "1.2 s" });
    expect(lineOf({ command: "a", state: "skipped" })).toMatchObject({ word: "Not run" });
  });

  it("counts timed-out checks as failed in the header", () => {
    const checks = [
      { command: "a", state: "passed" as const },
      { command: "b", state: "timed_out" as const },
    ];
    const trial = { trialId: "trial_1", startedAt: 1, checks } as never;
    expect(summaryOf({ ...(trial as object), state: "done" } as never)).toEqual({ tone: "fail", text: "1 of 2 checks failed" });
    expect(summaryOf({ ...(trial as object), state: "cancelled" } as never)).toEqual({ tone: "stopped", text: "Stopped" });
  });
});
