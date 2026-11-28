// Whether Codex CLI is installed and logged in, read-only: `codex --version`, then
// `codex login status`, whose exit code is the answer (the text it prints can hold account data and is not read).
import { tmpdir } from "node:os";
import { createProcessRunner, type ProcessRunner } from "../../../kernel/process/index.js";
import type { CliHealth } from "../../../kernel/schemas/index.js";
import { CODEX_CLI_COMMAND, NO_DAEMON, NO_DAEMON_FEATURE } from "./command.js";
import { LOGIN_COMMAND, parseVersion, versionProblem } from "./version.js";

export interface CodexCliStatusOptions {
  /** argv that starts the CLI. Default: `[CODEX_CLI_COMMAND]`, found on the allowlisted PATH. */
  readonly command?: readonly [string, ...string[]];
  readonly runner?: ProcessRunner;
  /** Per command. Default: 8 s. */
  readonly timeoutMs?: number;
}

const LOGIN_HINT = `Run \`${LOGIN_COMMAND}\` in a terminal, then check again.`;

export async function codexCliStatus(options: CodexCliStatusOptions = {}): Promise<CliHealth> {
  const command = options.command ?? [CODEX_CLI_COMMAND];
  const runner = options.runner ?? createProcessRunner();
  const timeoutMs = options.timeoutMs ?? 8_000;
  const run = async (args: readonly string[]): Promise<{ started: boolean; timedOut: boolean; exitCode: number | null; out: string }> => {
    const lines: string[] = [];
    const result = await runner.run({
      command: { argv: [...command, ...NO_DAEMON, ...args, ...NO_DAEMON_FEATURE] },
      cwd: tmpdir(),
      timeoutMs,
      stdout: { onLine: (line) => void (lines.length < 20 && lines.push(line)) },
    });
    if (result.kind === "not-started") return { started: false, timedOut: false, exitCode: null, out: "" };
    return { started: true, timedOut: result.timedOut, exitCode: result.timedOut ? null : result.exitCode, out: lines.join("\n") };
  };

  const base = { cliId: "codex-cli" as const };
  // A CLI that does not answer is neither missing nor logged out: say so, and check again later.
  const slow = (installed: boolean): CliHealth => ({ ...base, installed, loggedIn: false, timedOut: true, message: "Codex CLI didn't answer in time. Tokama checks again when you come back to the window." });
  const version = await run(["--version"]);
  if (version.timedOut) return slow(true);
  if (!version.started) return { ...base, installed: false, loggedIn: false, message: "Codex CLI is not installed, or `codex` is not on the PATH." };
  const parsed = parseVersion(version.out);
  const withVersion = parsed === undefined ? base : { ...base, version: parsed };
  if (version.exitCode !== 0) return { ...withVersion, installed: false, loggedIn: false, message: "`codex --version` failed; reinstall Codex CLI." };

  const login = await run(["login", "status"]);
  if (login.timedOut) return { ...slow(true), ...(parsed === undefined ? {} : { version: parsed }) };
  if (login.exitCode !== 0) return { ...withVersion, installed: true, loggedIn: false, message: `Codex CLI is not logged in. ${LOGIN_HINT}` };
  const ready = { ...withVersion, installed: true, loggedIn: true };
  const problem = versionProblem(parsed);
  return problem === undefined ? ready : { ...ready, message: problem };
}
