import { describe, expect, it } from "vitest";
import type { ProcessRunner, RunRequest, RunResult } from "../process/index.js";
import { APPARMOR_HINT, createLinuxSupport } from "./linux.js";

const finished = (extra: Partial<Extract<RunResult, { kind: "finished" }>> = {}): RunResult => ({
  kind: "finished", pid: 2, exitCode: 0, signal: null, timedOut: false, aborted: false, startedAt: 0, endedAt: 0, durationMs: 0, ...extra,
});
const signal = new AbortController().signal;
const isNoop = (request: RunRequest): boolean => "argv" in request.command && request.command.argv.includes("--unshare-user");

/** A runner where the tools answer `--version` as given and the no-op inside bwrap answers `noop`. */
function runnerWith(answers: { bwrap?: RunResult; socat?: RunResult; noop?: RunResult }) {
  const requests: RunRequest[] = [];
  const runner: ProcessRunner = {
    run: async (request) => {
      requests.push(request);
      const program = "argv" in request.command ? request.command.argv[0] : "";
      const answer = isNoop(request) ? answers.noop : answers[program as "bwrap" | "socat"];
      return answer ?? { kind: "not-started", reason: "spawn-error", message: "ENOENT", code: "ENOENT" };
    },
  };
  return { runner, requests };
}

describe("Linux sandbox support: bubblewrap must be able to start", () => {
  it("is ready when the no-op runs inside bwrap, with the same environment and limit as the version checks", async () => {
    const { runner, requests } = runnerWith({ bwrap: finished(), socat: finished(), noop: finished() });
    expect(await createLinuxSupport(runner, { PATH: "/opt/tools" }).check(signal)).toEqual({ ok: true });
    const probe = requests.find(isNoop);
    expect("argv" in probe!.command && probe!.command.argv).toEqual([
      "bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--unshare-user", "--unshare-pid", "--unshare-net", "--die-with-parent", "/usr/bin/true",
    ]);
    expect(requests.every((request) => request.env?.["PATH"] === "/opt/tools" && request.timeoutMs === 5_000)).toBe(true);
  });

  it("reports bubblewrap as installed but blocked when the no-op exits non-zero, with the AppArmor fix", async () => {
    const { runner } = runnerWith({ bwrap: finished(), socat: finished(), noop: finished({ exitCode: 1 }) });
    const check = await createLinuxSupport(runner).check(signal);
    expect(check).toEqual({
      ok: false,
      problem: "Steps that run commands need bubblewrap, which is installed but blocked: it could not start a sandbox on this machine.",
      fix: APPARMOR_HINT,
    });
    expect(APPARMOR_HINT).toContain("AppArmor profile for /usr/bin/bwrap");
    expect(APPARMOR_HINT).toContain("sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0");
  });

  it("reports it as blocked when the no-op times out", async () => {
    const timedOut = finished({ exitCode: null, signal: "SIGTERM", timedOut: true });
    const { runner } = runnerWith({ bwrap: finished(), socat: finished(), noop: timedOut });
    expect(await createLinuxSupport(runner).check(signal)).toMatchObject({ ok: false, problem: expect.stringContaining("installed but blocked") });
  });

  it("does not run the no-op when a tool is missing, and names the install commands for apt and dnf", async () => {
    const { runner, requests } = runnerWith({ bwrap: finished(), noop: finished() });
    const check = await createLinuxSupport(runner).check(signal);
    expect(check).toMatchObject({ ok: false, problem: expect.stringContaining("`socat` is missing"), fix: expect.stringContaining("sudo apt install bubblewrap socat") });
    expect(check).toMatchObject({ fix: expect.stringContaining("sudo dnf install bubblewrap socat") });
    expect(requests.some(isNoop)).toBe(false);
  });

  it("does not cache a blocked answer", async () => {
    const answers: { bwrap: RunResult; socat: RunResult; noop: RunResult } = { bwrap: finished(), socat: finished(), noop: finished({ exitCode: 1 }) };
    const support = createLinuxSupport(runnerWith(answers).runner);
    expect((await support.check(signal)).ok).toBe(false);
    answers.noop = finished();
    expect((await support.check(signal)).ok).toBe(true);
  });
});
