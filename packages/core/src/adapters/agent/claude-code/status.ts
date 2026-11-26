// Whether Claude Code is installed and logged in, read-only: `claude --version`, then
// `claude auth status --json`. Only `loggedIn` is read from the status; the rest is account data.
import { tmpdir } from "node:os";
import { createProcessRunner, type ProcessRunner } from "../../../kernel/process/index.js";
import type { CliHealth } from "../../../kernel/schemas/index.js";
import { CLAUDE_CODE_COMMAND } from "./command.js";
import { COMMAND_RULES_FROM, commandRulesProblem, parseVersion } from "./version.js";

export interface ClaudeCodeStatusOptions {
  /** argv that starts the CLI. Default: `[CLAUDE_CODE_COMMAND]`, found on the allowlisted PATH. */
  readonly command?: readonly [string, ...string[]];
  readonly runner?: ProcessRunner;
  /** Per command. Default: 8 s. */
  readonly timeoutMs?: number;
}

/** What a person types to sign in. */
export const LOGIN_COMMAND = "claude auth login";
const LOGIN_HINT = `Run \`${LOGIN_COMMAND}\` in a terminal, then check again.`;
const UNREADABLE_VERSION = "Tokama could not read the Claude Code version, so steps that run commands will not run. Check that `claude --version` works.";

export async function claudeCodeStatus(options: ClaudeCodeStatusOptions = {}): Promise<CliHealth> {
  const command = options.command ?? [CLAUDE_CODE_COMMAND];
  const runner = options.runner ?? createProcessRunner();
  const timeoutMs = options.timeoutMs ?? 8_000;
  const run = async (args: readonly string[]): Promise<{ started: boolean; timedOut: boolean; exitCode: number | null; out: string }> => {
    const lines: string[] = [];
    const result = await runner.run({
      command: { argv: [...command, ...args] },
      cwd: tmpdir(),
      timeoutMs,
      stdout: { onLine: (line) => void (lines.length < 200 && lines.push(line)) },
    });
    if (result.kind === "not-started") return { started: false, timedOut: false, exitCode: null, out: "" };
    return { started: true, timedOut: result.timedOut, exitCode: result.timedOut ? null : result.exitCode, out: lines.join("\n") };
  };

  const base = { cliId: "claude-code" as const };
  // A CLI that does not answer is neither missing nor logged out: say so, and check again later.
  const slow = (installed: boolean): CliHealth => ({ ...base, installed, loggedIn: false, timedOut: true, message: "Claude Code didn't answer in time. Tokama checks again when you come back to the window." });
  const version = await run(["--version"]);
  if (version.timedOut) return slow(true);
  if (!version.started) return { ...base, installed: false, loggedIn: false, message: "Claude Code is not installed, or `claude` is not on the PATH." };
  const shown = /^\S+/.exec(version.out.trim())?.[0];
  const withVersion = shown === undefined ? base : { ...base, version: shown.slice(0, 100) };
  if (version.exitCode !== 0) return { ...withVersion, installed: false, loggedIn: false, message: "`claude --version` failed; reinstall Claude Code." };

  const status = await run(["auth", "status", "--json"]);
  if (status.timedOut) return { ...slow(true), ...(shown === undefined ? {} : { version: shown.slice(0, 100) }) };
  if (loggedIn(status.out)) {
    const ready = { ...withVersion, installed: true, loggedIn: true };
    const parsed = parseVersion(version.out);
    if (commandRulesProblem(parsed) === undefined) return ready;
    return { ...ready, message: parsed === undefined ? UNREADABLE_VERSION : `Claude Code ${parsed} is older than ${COMMAND_RULES_FROM}. Steps that run commands will fail until you update it (for example with \`claude update\`).` };
  }
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
