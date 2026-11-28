import { describe, expect, it } from "vitest";
import type { ProcessRunner, RunRequest, RunResult } from "../../../kernel/process/index.js";
import { codexCliStatus } from "./status.js";

type Reply = { readonly exitCode: number; readonly out?: string } | "missing" | "timeout";

const VERSION = "codex --no-daemon --version --disable daemon_auto_start";
const LOGIN = "codex --no-daemon login status --disable daemon_auto_start";

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
      for (const line of (reply.out ?? "").split("\n")) request.stdout?.onLine?.(line);
      return { kind: "finished", pid: 2, exitCode: reply.exitCode, signal: null, timedOut: false, aborted: false, startedAt: 0, endedAt: 0, durationMs: 0 };
    },
  };
}

describe("codexCliStatus", () => {
  it("reports an installed CLI that is logged in, with its version, and runs only the two read-only commands, never into the daemon", async () => {
    const runner = fakeRunner({ [VERSION]: { exitCode: 0, out: "codex-cli 0.172.0" }, [LOGIN]: { exitCode: 0, out: "Logged in using ChatGPT" } });
    expect(await codexCliStatus({ runner })).toEqual({ cliId: "codex-cli", installed: true, loggedIn: true, version: "0.172.0" });
    expect(runner.argvs).toEqual([VERSION, LOGIN]);
  });

  it("does not read the login text: the exit code is the answer", async () => {
    const runner = fakeRunner({ [VERSION]: { exitCode: 0, out: "codex-cli 0.172.0" }, [LOGIN]: { exitCode: 0, out: "Logged in as someone@example.com" } });
    expect(JSON.stringify(await codexCliStatus({ runner }))).not.toContain("someone@example.com");
  });

  it("says the CLI is missing when it does not start", async () => {
    expect(await codexCliStatus({ runner: fakeRunner({}) })).toEqual({ cliId: "codex-cli", installed: false, loggedIn: false, message: expect.stringContaining("not installed") });
  });

  it("says a CLI whose version check fails is broken", async () => {
    const status = await codexCliStatus({ runner: fakeRunner({ [VERSION]: { exitCode: 1 } }) });
    expect(status).toMatchObject({ installed: false, loggedIn: false, message: expect.stringContaining("reinstall") });
  });

  it("says a CLI that is not logged in how to sign in", async () => {
    const runner = fakeRunner({ [VERSION]: { exitCode: 0, out: "codex-cli 0.172.0" }, [LOGIN]: { exitCode: 1, out: "Not logged in" } });
    expect(await codexCliStatus({ runner })).toEqual({ cliId: "codex-cli", installed: true, loggedIn: false, version: "0.172.0", message: expect.stringContaining("codex login") });
  });

  it("marks a logged-in CLI older than the minimum, and one whose version cannot be read", async () => {
    const loggedInOn = (out: string) => fakeRunner({ [VERSION]: { exitCode: 0, out }, [LOGIN]: { exitCode: 0 } });
    expect(await codexCliStatus({ runner: loggedInOn("codex-cli 0.171.0") })).toEqual({ cliId: "codex-cli", installed: true, loggedIn: true, version: "0.171.0", message: expect.stringContaining("0.172.0 or newer") });
    expect(await codexCliStatus({ runner: loggedInOn("codex-cli 0.172.0") })).not.toHaveProperty("message");
    expect(await codexCliStatus({ runner: loggedInOn("weird") })).toMatchObject({ installed: true, loggedIn: true, message: expect.stringContaining("could not read") });
  });

  it("reports a CLI that does not answer as unknown, not as missing or logged out", async () => {
    expect(await codexCliStatus({ runner: fakeRunner({ [VERSION]: "timeout" }) })).toMatchObject({ installed: true, loggedIn: false, timedOut: true });
    const runner = fakeRunner({ [VERSION]: { exitCode: 0, out: "codex-cli 0.172.0" }, [LOGIN]: "timeout" });
    expect(await codexCliStatus({ runner })).toMatchObject({ installed: true, loggedIn: false, timedOut: true, version: "0.172.0" });
  });

  it("starts the command it is given", async () => {
    const runner = fakeRunner({ "/opt/codex --no-daemon --version --disable daemon_auto_start": { exitCode: 0, out: "codex-cli 0.172.0" }, "/opt/codex --no-daemon login status --disable daemon_auto_start": { exitCode: 0 } });
    expect(await codexCliStatus({ runner, command: ["/opt/codex"] })).toMatchObject({ loggedIn: true });
  });
});
