import { HELPER_LOCAL_ONLY, HELPER_NO_CLI } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { availability, breaksRule, checkLines, couldNotStartText, failedWithoutSetup, failureOf, lineOf, setupLineOf, setupText, summaryOf, tryProblem } from "./checks-model.js";

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

describe("setup in a trial", () => {
  const base = { trialId: "trial_1", startedAt: 1, setup: "pnpm install" };
  const checks = (...states: Array<"passed" | "failed" | "skipped">) => states.map((state, at) => ({ command: `c${at}`, state }));

  it("words the setup line: Done for the good end, the exit code, could not start, timed out, not run", () => {
    expect(setupLineOf({ state: "passed", durationMs: 48_000 }, 0)).toMatchObject({ word: "Done", tone: "pass", time: "48 s" });
    expect(setupLineOf({ state: "failed", exitCode: 1, durationMs: 12_000, outputTail: "x" }, 0)).toMatchObject({ word: "Failed, exit 1", tone: "fail", hasOutput: true });
    expect(setupLineOf({ state: "failed", exitCode: 127, couldNotStart: { word: "pnpm" } }, 0)).toMatchObject({ word: "Could not start" });
    expect(setupLineOf({ state: "timed_out", durationMs: 1_200_000 }, 0)).toMatchObject({ word: "Timed out", tone: "fail" });
    expect(setupLineOf({ state: "skipped" }, 0)).toMatchObject({ word: "Not run", tone: "skipped", time: undefined });
  });

  it("ticks the running time from when the setup started", () => {
    expect(setupLineOf({ state: "running", startedAt: 1000 }, 42_000)).toMatchObject({ word: "Running", tone: "live", time: "41 s" });
    expect(setupLineOf({ state: "running" }, 42_000)).toMatchObject({ time: undefined });
  });

  it("heads each end: all passed, a setup that failed with the checks not run (never counted), alone, stopped", () => {
    expect(summaryOf({ ...base, state: "done", setupResult: { state: "passed" }, checks: checks("passed", "passed", "passed") } as never)).toEqual({ tone: "pass", text: "Setup and 3 checks passed" });
    expect(summaryOf({ ...base, state: "done", setupResult: { state: "passed" }, checks: [] } as never)).toEqual({ tone: "pass", text: "Setup done" });
    expect(summaryOf({ ...base, state: "failed", setupResult: { state: "failed", exitCode: 1 }, checks: checks("skipped", "skipped", "skipped") } as never)).toEqual({ tone: "fail", text: "Setup failed · 3 checks not run" });
    expect(summaryOf({ ...base, state: "failed", setupResult: { state: "failed", exitCode: 1 }, checks: checks("skipped") } as never).text).toBe("Setup failed · 1 check not run");
    expect(summaryOf({ ...base, state: "failed", setupResult: { state: "failed", exitCode: 1 }, checks: [] } as never).text).toBe("Setup failed");
    expect(summaryOf({ ...base, state: "failed", setupResult: { state: "timed_out" }, checks: checks("skipped") } as never).text).toBe("Setup timed out · 1 check not run");
    expect(summaryOf({ ...base, state: "failed", setupResult: { state: "failed", exitCode: 127, couldNotStart: { word: "pnpm" } }, checks: checks("skipped") } as never).text).toBe("Setup could not start · 1 check not run");
    expect(summaryOf({ ...base, state: "cancelled", setupResult: { state: "skipped" }, checks: checks("skipped") } as never)).toEqual({ tone: "stopped", text: "Stopped" });
    // A check that fails after a good setup is a failed check.
    expect(summaryOf({ ...base, state: "done", setupResult: { state: "passed" }, checks: checks("passed", "failed") } as never).text).toBe("1 of 2 checks failed");
  });

  it("knows a failure with no setup command, which may be a missing package", () => {
    expect(failedWithoutSetup({ trialId: "trial_1", startedAt: 1, checks: checks("failed") } as never)).toBe(true);
    expect(failedWithoutSetup({ trialId: "trial_1", startedAt: 1, checks: checks("passed") } as never)).toBe(false);
    expect(failedWithoutSetup({ ...base, checks: checks("failed") } as never)).toBe(false);
  });

  it("makes the field one line, and names the word that was not found", () => {
    expect(setupText("  npm ci \n")).toBe("npm ci");
    expect(setupText("npm ci\n  --ignore-scripts")).toBe("npm ci --ignore-scripts");
    expect(couldNotStartText("pnpm", undefined)).toBe("pnpm was not found. Tokama runs commands with the PATH of its background service, which can differ from your terminal.");
    expect(couldNotStartText("pnpm", "not_found")).toBe(couldNotStartText("pnpm", undefined));
    // A path is looked for in the worktree, not on the PATH.
    expect(couldNotStartText("./scripts/setup.sh", "not_found")).toBe("./scripts/setup.sh was not found in the worktree.");
    expect(couldNotStartText("./scripts/setup.sh", "not_executable")).toBe("./scripts/setup.sh was found but cannot run. Check that it is executable.");
  });

  it("turns Try checks off for a setup that breaks the rule, first", () => {
    expect(tryProblem(["npm test"], "npm ci && npm run build")).toMatch(/^The setup command is more than one command\./);
    expect(tryProblem(["npm test"], "npm ci")).toBeUndefined();
  });
});
