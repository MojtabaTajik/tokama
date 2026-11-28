import { describe, expect, it } from "vitest";
import type { ProcessRunner, RunRequest, RunResult } from "../../../kernel/process/index.js";
import { parseVersion, readClaudeVersion, shellCallsProblem } from "./version.js";

const finished = (extra: Partial<Extract<RunResult, { kind: "finished" }>> = {}): RunResult => ({
  kind: "finished", pid: 2, exitCode: 0, signal: null, timedOut: false, aborted: false, startedAt: 0, endedAt: 0, durationMs: 0, ...extra,
});

/** A runner that records its requests and answers each with `result` after printing `out`. */
function recordingRunner(result: RunResult, out = "") {
  const requests: RunRequest[] = [];
  const runner: ProcessRunner = {
    run: async (request) => {
      requests.push(request);
      if (out !== "") request.stdout?.onLine?.(out);
      return result;
    },
  };
  return { runner, requests };
}

describe("readClaudeVersion", () => {
  const options = (runner: ProcessRunner) => ({ command: ["claude"] as const, runner, cwd: "/repo/x", signal: new AbortController().signal });

  it("runs `claude --version` in the folder the call runs in", async () => {
    const { runner, requests } = recordingRunner(finished(), "2.1.332 (Claude Code)");
    expect(await readClaudeVersion(options(runner))).toEqual({ kind: "version", version: "2.1.332" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ command: { argv: ["claude", "--version"] }, cwd: "/repo/x" });
  });

  it("reports a CLI that does not answer in time", async () => {
    const { runner } = recordingRunner(finished({ exitCode: null, signal: "SIGTERM", timedOut: true }));
    expect(await readClaudeVersion({ ...options(runner), timeoutMs: 10_000 })).toEqual({ kind: "unknown", why: "it did not answer within 10 s" });
  });

  it("reports a stop, whether the process started or not", async () => {
    expect(await readClaudeVersion(options(recordingRunner({ kind: "not-started", reason: "aborted", message: "aborted before start" }).runner))).toEqual({ kind: "aborted" });
    expect(await readClaudeVersion(options(recordingRunner(finished({ aborted: true })).runner))).toEqual({ kind: "aborted" });
  });
});

describe("parseVersion", () => {
  it("reads the leading version of `claude --version`", () => {
    expect(parseVersion("2.1.332 (Claude Code)")).toBe("2.1.332");
    expect(parseVersion("2.1.295")).toBe("2.1.295");
    expect(parseVersion(" 2.1.295\n")).toBe("2.1.295");
  });

  it("gives nothing for output without a version", () => {
    expect(parseVersion("garbage")).toBeUndefined();
    expect(parseVersion("")).toBeUndefined();
  });
});

describe("shellCallsProblem", () => {
  it("names the needed version and the installed one when it is older", () => {
    for (const version of ["2.1.314", "2.1.295", "2.0.999"]) {
      expect(shellCallsProblem(version)).toContain("Claude Code 2.1.315 or newer is needed to run commands inside its sandbox");
      expect(shellCallsProblem(version)).toContain(`this is Claude Code ${version}`);
    }
  });

  it("has no problem from 2.1.315 on", () => {
    for (const version of ["2.1.315", "2.1.316", "2.2.0", "3.0.0"]) expect(shellCallsProblem(version)).toBeUndefined();
  });

  it("fails closed on an unknown version", () => {
    expect(shellCallsProblem(undefined)).toMatch(/could not read the Claude Code version \(it printed no version\).*2\.1\.315/);
    expect(shellCallsProblem(undefined, "it exited with code 3")).toContain("(it exited with code 3)");
  });
});
