// Whether Claude Code is installed and logged in, read-only: `claude --version`, then
// `claude auth status --json`. Only `loggedIn` is read from the status; the rest is account data.
import { tmpdir } from "node:os";
import { createProcessRunner, type ProcessRunner } from "../../../kernel/process/index.js";
import type { CliHealth } from "../../../kernel/schemas/index.js";

export interface ClaudeCodeStatusOptions {
  /** argv that starts the CLI. Default: `["claude"]`, found on the allowlisted PATH. */
  readonly command?: readonly [string, ...string[]];
  readonly runner?: ProcessRunner;
  /** Per command. Default: 15 s. */
  readonly timeoutMs?: number;
}

const LOGIN_HINT = "Run `claude auth login` in a terminal, then check again.";

export async function claudeCodeStatus(options: ClaudeCodeStatusOptions = {}): Promise<CliHealth> {
  const command = options.command ?? ["claude"];
  const runner = options.runner ?? createProcessRunner();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const run = async (args: readonly string[]): Promise<{ started: boolean; exitCode: number | null; out: string }> => {
    const lines: string[] = [];
    const result = await runner.run({
      command: { argv: [...command, ...args] },
      cwd: tmpdir(),
      timeoutMs,
      stdout: { onLine: (line) => void (lines.length < 200 && lines.push(line)) },
    });
    if (result.kind === "not-started") return { started: false, exitCode: null, out: "" };
    return { started: true, exitCode: result.timedOut ? null : result.exitCode, out: lines.join("\n") };
  };

  const base = { cliId: "claude-code" as const };
  const version = await run(["--version"]);
  if (!version.started) return { ...base, installed: false, loggedIn: false, message: "Claude Code is not installed, or `claude` is not on the PATH." };
  const shown = /^\S+/.exec(version.out.trim())?.[0];
  const withVersion = shown === undefined ? base : { ...base, version: shown.slice(0, 100) };
  if (version.exitCode !== 0) return { ...withVersion, installed: false, loggedIn: false, message: "`claude --version` failed; reinstall Claude Code." };

  const status = await run(["auth", "status", "--json"]);
  if (loggedIn(status.out)) return { ...withVersion, installed: true, loggedIn: true };
  return { ...withVersion, installed: true, loggedIn: false, message: `Claude Code is not logged in. ${LOGIN_HINT}` };
}

function loggedIn(out: string): boolean {
  try {
    const parsed: unknown = JSON.parse(out);
    return typeof parsed === "object" && parsed !== null && "loggedIn" in parsed && parsed.loggedIn === true;
  } catch {
    return false;
  }
}
