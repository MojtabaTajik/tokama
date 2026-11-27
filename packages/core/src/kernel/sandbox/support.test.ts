import { describe, expect, it } from "vitest";
import type { ProcessRunner, RunRequest, RunResult } from "../process/index.js";
import { createSandboxSupport, toolCacheDirs } from "./index.js";

const finished = (extra: Partial<Extract<RunResult, { kind: "finished" }>> = {}): RunResult => ({
  kind: "finished", pid: 2, exitCode: 0, signal: null, timedOut: false, aborted: false, startedAt: 0, endedAt: 0, durationMs: 0, ...extra,
});
const missing: RunResult = { kind: "not-started", reason: "spawn-error", message: "ENOENT", code: "ENOENT" };

/** A runner that answers by program name and records every request. */
function runnerWith(answers: Readonly<Record<string, RunResult>>) {
  const requests: RunRequest[] = [];
  const runner: ProcessRunner = {
    run: async (request) => {
      requests.push(request);
      const program = "argv" in request.command ? request.command.argv[0] : undefined;
      return answers[program ?? ""] ?? missing;
    },
  };
  return { runner, requests };
}
const signal = new AbortController().signal;

describe("createSandboxSupport", () => {
  it("is ready on macOS without starting anything", async () => {
    const { runner, requests } = runnerWith({});
    expect(await createSandboxSupport(runner, "darwin").check(signal)).toEqual({ ok: true });
    expect(requests).toEqual([]);
  });

  it("is ready on Linux when bwrap and socat answer, looked up in the call's environment", async () => {
    const { runner, requests } = runnerWith({ bwrap: finished(), socat: finished() });
    expect(await createSandboxSupport(runner, "linux", { PATH: "/opt/tools" }).check(signal)).toEqual({ ok: true });
    expect(requests.map((request) => ("argv" in request.command ? request.command.argv.slice(0, 2) : []))).toEqual([["bwrap", "--version"], ["socat", "-V"], ["bwrap", "--ro-bind"]]);
    expect(requests.every((request) => request.env?.["PATH"] === "/opt/tools" && request.timeoutMs === 5_000)).toBe(true);
  });

  it("names the one that is missing", async () => {
    const check = await createSandboxSupport(runnerWith({ socat: finished() }).runner, "linux").check(signal);
    expect(check).toEqual({
      ok: false,
      problem: "Steps that run commands need bubblewrap and socat for Claude Code's sandbox, and `bwrap` is missing or not working.",
      fix: "Install them (Ubuntu or Debian: `sudo apt install bubblewrap socat`; Fedora: `sudo dnf install bubblewrap socat`).",
    });
    expect(await createSandboxSupport(runnerWith({ bwrap: finished() }).runner, "linux").check(signal)).toMatchObject({ ok: false, problem: expect.stringContaining("`socat` is missing") });
  });

  it("names both when both are missing", async () => {
    expect(await createSandboxSupport(runnerWith({}).runner, "linux").check(signal)).toMatchObject({ ok: false, problem: expect.stringContaining("`bwrap` and `socat` are missing") });
  });

  it("treats a tool that times out or fails as not working", async () => {
    const timedOut = finished({ exitCode: null, signal: "SIGTERM", timedOut: true });
    expect(await createSandboxSupport(runnerWith({ bwrap: timedOut, socat: finished() }).runner, "linux").check(signal)).toMatchObject({ ok: false, problem: expect.stringContaining("`bwrap`") });
    expect(await createSandboxSupport(runnerWith({ bwrap: finished(), socat: finished({ exitCode: 1 }) }).runner, "linux").check(signal)).toMatchObject({ ok: false, problem: expect.stringContaining("`socat`") });
  });

  it("does not cache a failure", async () => {
    const answers: Record<string, RunResult> = {};
    const support = createSandboxSupport(runnerWith(answers).runner, "linux");
    expect((await support.check(signal)).ok).toBe(false);
    answers["bwrap"] = finished();
    answers["socat"] = finished();
    expect((await support.check(signal)).ok).toBe(true);
  });

  it("is not available on Windows", async () => {
    expect(await createSandboxSupport(runnerWith({}).runner, "win32").check(signal)).toEqual({
      ok: false,
      problem: "Claude Code's sandbox does not run on Windows, so Tokama does not run steps that run commands here.",
    });
  });
});

describe("toolCacheDirs", () => {
  it("lists the macOS caches", () => {
    expect(toolCacheDirs("darwin")).toEqual([
      "~/.npm", "~/Library/pnpm/store", "~/Library/Caches/pnpm", "~/Library/Caches/Yarn", "~/.nuget/packages", "~/.local/share/NuGet", "~/Library/Caches/pip",
      "~/go/pkg/mod", "~/Library/Caches/go-build", "~/.cargo/registry", "~/.cargo/git", "~/.m2/repository", "~/.gradle/caches", "~/.gradle/wrapper",
    ]);
  });

  it("lists the Linux caches", () => {
    expect(toolCacheDirs("linux")).toEqual([
      "~/.npm", "~/.local/share/pnpm/store", "~/.cache/pnpm", "~/.cache/yarn", "~/.nuget/packages", "~/.local/share/NuGet", "~/.cache/pip",
      "~/go/pkg/mod", "~/.cache/go-build", "~/.cargo/registry", "~/.cargo/git", "~/.m2/repository", "~/.gradle/caches", "~/.gradle/wrapper",
    ]);
  });

  it("never lists a folder with programs on the PATH, or the whole .dotnet folder", () => {
    for (const platform of ["darwin", "linux"] as const) {
      for (const dir of toolCacheDirs(platform)) expect(dir).not.toMatch(/\/bin$|\.dotnet|\.cargo$/);
    }
    expect(toolCacheDirs("win32")).toEqual([]);
  });
});
