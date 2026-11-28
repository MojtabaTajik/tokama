import { describe, expect, it } from "vitest";
import type { ProcessRunner, RunRequest, RunResult } from "../process/index.js";
import { BWRAP_BLOCKED_HINT, createLinuxSupport, NESTED_BLOCKED_HINT } from "./linux.js";

const finished = (extra: Partial<Extract<RunResult, { kind: "finished" }>> = {}): RunResult => ({
  kind: "finished", pid: 2, exitCode: 0, signal: null, timedOut: false, aborted: false, startedAt: 0, endedAt: 0, durationMs: 0, ...extra,
});
const signal = new AbortController().signal;
const argvOf = (request: RunRequest): readonly string[] => ("argv" in request.command ? request.command.argv : []);
const isNested = (request: RunRequest): boolean => argvOf(request).includes("unshare");
const isProfile = (request: RunRequest): boolean => argvOf(request).includes("cat");
const isOuter = (request: RunRequest): boolean => argvOf(request).includes("--unshare-user") && !isNested(request) && !isProfile(request);

const SANDBOX = ["bwrap", "--new-session", "--die-with-parent", "--unshare-user", "--unshare-pid", "--unshare-net", "--cap-drop", "ALL", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];

interface Answer {
  readonly result: RunResult;
  readonly stdout?: string;
  readonly stderr?: string;
}
const answer = (result: RunResult, text: { stdout?: string; stderr?: string } = {}): Answer => ({ result, ...text });
const ok = answer(finished());

/** A runner where the tools answer `--version` as given and each of the three probes inside bwrap answers as given. */
function runnerWith(answers: { bwrap?: RunResult; socat?: RunResult; outer?: Answer; nested?: Answer; profile?: Answer }) {
  const requests: RunRequest[] = [];
  const runner: ProcessRunner = {
    run: async (request) => {
      requests.push(request);
      const program = argvOf(request)[0];
      const probe = isNested(request) ? answers.nested : isProfile(request) ? answers.profile : isOuter(request) ? answers.outer : undefined;
      if (probe !== undefined) {
        if (probe.stdout !== undefined) request.stdout?.onLine?.(probe.stdout);
        if (probe.stderr !== undefined) request.stderr?.onLine?.(probe.stderr);
        return probe.result;
      }
      return (isNested(request) || isProfile(request) || isOuter(request) ? undefined : answers[program as "bwrap" | "socat"]) ?? { kind: "not-started", reason: "spawn-error", message: "ENOENT", code: "ENOENT" };
    },
  };
  return { runner, requests };
}
const tools = { bwrap: finished(), socat: finished() };

const OUTER_BLOCKED = {
  ok: false,
  problem: "Steps that run commands need bubblewrap, which is installed but blocked: it could not start a sandbox on this machine.",
  fix: BWRAP_BLOCKED_HINT,
};
const nestedBlocked = (profile: string) => ({
  ok: false,
  problem: `Steps that run commands need bubblewrap, which starts here but blocks the helper that Claude Code's sandbox runs inside it${profile}, so every command would fail.`,
  fix: NESTED_BLOCKED_HINT,
});

describe("Linux sandbox support: bubblewrap must start the sandbox Claude Code builds", () => {
  it("is ready when the outer and the nested probe pass, and never runs the diagnostic", async () => {
    const { runner, requests } = runnerWith({ ...tools, outer: ok, nested: ok });
    expect(await createLinuxSupport(runner, { PATH: "/opt/tools" }).check(signal)).toEqual({ ok: true });
    expect(requests.map(argvOf)).toEqual([
      ["bwrap", "--version"],
      ["socat", "-V"],
      [...SANDBOX, "true"],
      [...SANDBOX, "--", "unshare", "--user", "--map-root-user", "true"],
    ]);
    expect(requests.every((request) => request.env?.["PATH"] === "/opt/tools" && request.timeoutMs === 5_000)).toBe(true);
  });

  it("reports bubblewrap as installed but blocked when the outer probe exits non-zero, and runs no other probe", async () => {
    const { runner, requests } = runnerWith({ ...tools, outer: answer(finished({ exitCode: 1 })), nested: ok });
    expect(await createLinuxSupport(runner).check(signal)).toEqual(OUTER_BLOCKED);
    expect(requests.some(isNested) || requests.some(isProfile)).toBe(false);
  });

  it("reports it as blocked when the outer probe times out", async () => {
    const timedOut = finished({ exitCode: null, signal: "SIGTERM", timedOut: true });
    expect(await createLinuxSupport(runnerWith({ ...tools, outer: answer(timedOut) }).runner).check(signal)).toEqual(OUTER_BLOCKED);
  });

  it("reports the nested probe failing as blocked, and names the AppArmor profile that the diagnostic reads", async () => {
    const { runner, requests } = runnerWith({
      ...tools, outer: ok, nested: answer(finished({ exitCode: 1 })), profile: answer(finished(), { stdout: "unpriv_bwrap (enforce)" }),
    });
    expect(await createLinuxSupport(runner).check(signal)).toEqual(nestedBlocked(" (the cause: Ubuntu's AppArmor profile `unpriv_bwrap` confines it)"));
    expect(requests.map(argvOf).at(-1)).toEqual([...SANDBOX, "--", "cat", "/proc/self/attr/current"]);
  });

  it("reports the nested probe failing as blocked without the profile name when the diagnostic shows another profile, fails or times out", async () => {
    const timedOut = finished({ exitCode: null, signal: "SIGTERM", timedOut: true });
    for (const profile of [answer(finished(), { stdout: "bwrap (unconfined)" }), answer(finished({ exitCode: 1 })), answer(timedOut), undefined]) {
      const { runner } = runnerWith({ ...tools, outer: ok, nested: answer(finished({ exitCode: 1 })), ...(profile && { profile }) });
      expect(await createLinuxSupport(runner).check(signal)).toEqual(nestedBlocked(""));
    }
  });

  it("reports it as blocked when the nested probe times out", async () => {
    const timedOut = finished({ exitCode: null, signal: "SIGTERM", timedOut: true });
    expect(await createLinuxSupport(runnerWith({ ...tools, outer: ok, nested: answer(timedOut) }).runner).check(signal)).toEqual(nestedBlocked(""));
  });

  it("does not block when `unshare` is not installed, so the nested probe shows nothing", async () => {
    const nested = answer(finished({ exitCode: 1 }), { stderr: "bwrap: execvp unshare: No such file or directory" });
    expect(await createLinuxSupport(runnerWith({ ...tools, outer: ok, nested }).runner).check(signal)).toEqual({ ok: true });
  });

  it("does not block when the nested probe cannot be started at all", async () => {
    const nested = answer({ kind: "not-started", reason: "spawn-error", message: "ENOENT", code: "ENOENT" });
    expect(await createLinuxSupport(runnerWith({ ...tools, outer: ok, nested }).runner).check(signal)).toEqual({ ok: true });
  });

  it("does not run any sandbox probe when a tool is missing, and names the install commands for apt and dnf", async () => {
    const { runner, requests } = runnerWith({ bwrap: finished(), outer: ok, nested: ok });
    const check = await createLinuxSupport(runner).check(signal);
    expect(check).toMatchObject({ ok: false, problem: expect.stringContaining("`socat` is missing"), fix: expect.stringContaining("sudo apt install bubblewrap socat") });
    expect(check).toMatchObject({ fix: expect.stringContaining("sudo dnf install bubblewrap socat") });
    expect(requests.some(isOuter) || requests.some(isNested)).toBe(false);
  });

  it("does not cache a blocked answer", async () => {
    const answers: Parameters<typeof runnerWith>[0] = { ...tools, outer: ok, nested: answer(finished({ exitCode: 1 })) };
    const support = createLinuxSupport(runnerWith(answers).runner);
    expect((await support.check(signal)).ok).toBe(false);
    answers.nested = ok;
    expect((await support.check(signal)).ok).toBe(true);
  });

  it("gives both hints as full strings that point at the docs page", () => {
    expect(BWRAP_BLOCKED_HINT).toBe("Ubuntu's AppArmor can stop bubblewrap from creating a user namespace. How to allow it: https://tokama.dev/docs/linux-sandbox");
    expect(NESTED_BLOCKED_HINT).toBe("Ubuntu's AppArmor profile for bubblewrap may stop the helper that Claude Code's sandbox starts inside it. How to check and allow it: https://tokama.dev/docs/linux-sandbox");
  });
});
