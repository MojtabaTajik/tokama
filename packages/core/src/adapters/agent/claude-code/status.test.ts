import { describe, expect, it } from "vitest";
import type { ProcessRunner, RunRequest, RunResult } from "../../../kernel/process/index.js";
import type { SandboxSupport } from "../../../kernel/sandbox/index.js";
import { claudeCodeStatus as checkStatus, type ClaudeCodeStatusOptions } from "./status.js";

// A Linux CI machine has no bubblewrap: every test but the sandbox ones brings its own answer.
const READY: SandboxSupport = { check: async () => ({ ok: true }) };
const claudeCodeStatus = (options: ClaudeCodeStatusOptions) => checkStatus({ sandboxSupport: READY, ...options });

type Reply = { readonly exitCode: number; readonly out: string } | "missing" | "timeout";

/** A runner that answers each argv (joined by spaces) with a fixed reply. */
function fakeRunner(replies: Readonly<Record<string, Reply>>): ProcessRunner & { argvs: string[] } {
  const argvs: string[] = [];
  return {
    argvs,
    run: async (request: RunRequest): Promise<RunResult> => {
      const argv = "argv" in request.command ? request.command.argv.join(" ") : request.command.shell;
      argvs.push(argv);
      const reply = replies[argv] ?? "missing";
      if (reply === "missing") return { kind: "not-started", reason: "spawn-error", message: "ENOENT", code: "ENOENT" };
      if (reply === "timeout") return { kind: "finished", pid: 2, exitCode: null, signal: "SIGTERM", timedOut: true, aborted: false, startedAt: 0, endedAt: 0, durationMs: 0 };
      for (const line of reply.out.split("\n")) request.stdout?.onLine?.(line);
      return { kind: "finished", pid: 2, exitCode: reply.exitCode, signal: null, timedOut: false, aborted: false, startedAt: 0, endedAt: 0, durationMs: 0 };
    },
  };
}

describe("claudeCodeStatus", () => {
  it("reports an installed CLI that is logged in, with its version, and reads nothing else", async () => {
    const runner = fakeRunner({
      "claude --version": { exitCode: 0, out: "2.1.331 (Claude Code)" },
      "claude auth status --json": { exitCode: 0, out: JSON.stringify({ loggedIn: true, email: "someone@example.com" }) },
    });
    const status = await claudeCodeStatus({ runner });
    expect(status).toEqual({ cliId: "claude-code", installed: true, loggedIn: true, version: "2.1.331" });
    expect(runner.argvs).toEqual(["claude --version", "claude auth status --json"]);
  });

  it("says a logged-in CLI older than 2.1.315 cannot run steps that run commands", async () => {
    const loggedInOn = (out: string) => fakeRunner({ "claude --version": { exitCode: 0, out }, "claude auth status --json": { exitCode: 0, out: JSON.stringify({ loggedIn: true }) } });
    expect(await claudeCodeStatus({ runner: loggedInOn("2.1.314 (Claude Code)") })).toEqual({
      cliId: "claude-code",
      installed: true,
      loggedIn: true,
      version: "2.1.314",
      message: expect.stringContaining("older than 2.1.315"),
    });
    expect(await claudeCodeStatus({ runner: loggedInOn("2.1.315") })).toEqual({ cliId: "claude-code", installed: true, loggedIn: true, version: "2.1.315" });
    expect(await claudeCodeStatus({ runner: loggedInOn("weird") })).toMatchObject({ installed: true, loggedIn: true, message: expect.stringMatching(/could not read the Claude Code version/) });
  });

  it("says when this machine cannot run the sandbox, once the CLI itself is fine", async () => {
    const runner = () =>
      fakeRunner({ "claude --version": { exitCode: 0, out: "2.1.331" }, "claude auth status --json": { exitCode: 0, out: JSON.stringify({ loggedIn: true }) } });
    const missing: SandboxSupport = {
      check: async () => ({ ok: false, problem: "Steps that run commands need bubblewrap and socat for Claude Code's sandbox, and `bwrap` is missing or not working.", fix: "Install them (Ubuntu: `sudo apt-get install bubblewrap socat`)." }),
    };
    expect(await claudeCodeStatus({ runner: runner(), sandboxSupport: missing })).toEqual({
      cliId: "claude-code",
      installed: true,
      loggedIn: true,
      version: "2.1.331",
      message: "Steps that run commands need bubblewrap and socat for Claude Code's sandbox, and `bwrap` is missing or not working. Install them (Ubuntu: `sudo apt-get install bubblewrap socat`). Then check again.",
    });
    const windows: SandboxSupport = { check: async () => ({ ok: false, problem: "No sandbox on this system." }) };
    expect(await claudeCodeStatus({ runner: runner(), sandboxSupport: windows })).toMatchObject({ loggedIn: true, message: "No sandbox on this system." });
    // The version problem comes first: the sandbox is not looked at.
    const old = fakeRunner({ "claude --version": { exitCode: 0, out: "2.1.300" }, "claude auth status --json": { exitCode: 0, out: JSON.stringify({ loggedIn: true }) } });
    expect(await claudeCodeStatus({ runner: old, sandboxSupport: missing })).toMatchObject({ message: expect.stringContaining("older than 2.1.315") });
  });

  it("keeps the login message for a logged-out CLI that is also too old", async () => {
    const runner = fakeRunner({ "claude --version": { exitCode: 0, out: "2.1.294" }, "claude auth status --json": { exitCode: 1, out: JSON.stringify({ loggedIn: false }) } });
    expect(await claudeCodeStatus({ runner })).toMatchObject({ loggedIn: false, message: expect.stringMatching(/claude auth login/) });
  });

  it("reports a CLI that is not logged in, with the command to log in", async () => {
    const runner = fakeRunner({
      "claude --version": { exitCode: 0, out: "2.1.331 (Claude Code)" },
      "claude auth status --json": { exitCode: 1, out: JSON.stringify({ loggedIn: false }) },
    });
    expect(await claudeCodeStatus({ runner })).toMatchObject({ installed: true, loggedIn: false, message: expect.stringMatching(/claude auth login/) });
  });

  it("treats output that is not the expected JSON as logged out", async () => {
    const runner = fakeRunner({ "claude --version": { exitCode: 0, out: "2.1.331" }, "claude auth status --json": { exitCode: 0, out: "unknown command" } });
    expect(await claudeCodeStatus({ runner })).toMatchObject({ installed: true, loggedIn: false });
  });

  it("says a CLI that does not answer in time did not answer, not that it is missing or logged out", async () => {
    const slowVersion = await claudeCodeStatus({ runner: fakeRunner({ "claude --version": "timeout" }) });
    expect(slowVersion).toMatchObject({ installed: true, loggedIn: false, message: expect.stringMatching(/didn't answer in time/) });
    const slowStatus = await claudeCodeStatus({ runner: fakeRunner({ "claude --version": { exitCode: 0, out: "2.1.331" }, "claude auth status --json": "timeout" }) });
    expect(slowStatus).toMatchObject({ installed: true, loggedIn: false, version: "2.1.331", message: expect.stringMatching(/didn't answer in time/) });
  });

  it("reports a CLI that is not on the PATH", async () => {
    const runner = fakeRunner({});
    expect(await claudeCodeStatus({ runner })).toMatchObject({ installed: false, loggedIn: false, message: expect.stringMatching(/not installed/) });
    expect(runner.argvs).toEqual(["claude --version"]);
  });
});
