// Check and setup commands Tokama runs itself in an item's worktree. Each command passes the
// command policy first, then runs through the process runner: in /bin/sh (the policy has refused
// every construct that could escape the allowlist), with the allowlisted environment, its own
// process group and a timeout. Output comes back as a capped tail; the full output can go to a
// file the caller names, which must be outside the worktree or the item's commit takes it in.
import { checkCommand, posixSh, type CommandDecision } from "../../kernel/command-policy/index.js";
import type { ProcessRunner } from "../../kernel/process/index.js";

export type CheckOutcome =
  | "passed"
  | "failed"
  | "timed-out"
  /** The caller's signal stopped it, or fired before it started. */
  | "aborted"
  /** The command policy refused it; it did not run. */
  | "refused"
  /** The shell did not start. */
  | "not-started";

/** One command's result. Plain JSON, with no paths. */
export interface CheckResult {
  readonly command: string;
  readonly outcome: CheckOutcome;
  /** null when it did not run or a signal ended it. */
  readonly exitCode: number | null;
  readonly durationMs: number;
  /** The end of stdout and stderr, line by line in arrival order; the refusal for a refused command. */
  readonly output: string;
  /** Earlier output was dropped to stay within the cap. */
  readonly outputTruncated: boolean;
}

export interface RunCommandOptions {
  /** The command policy's allowlist, e.g. `["pnpm test:*", "pnpm install"]`. */
  readonly rules: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  /** Added to the allowlisted environment, e.g. `{ CI: "1" }`. */
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  /** Characters of output kept in the result. Default: 16 000. */
  readonly outputCap?: number;
  /** Receives the full raw output (mode 0600). Never inside the worktree. */
  readonly outputFile?: string;
}

export const DEFAULT_OUTPUT_CAP = 16_000;

function refusal(decision: Exclude<CommandDecision, { allowed: true }>): string {
  return `refused by the command policy (${decision.reason}): ${decision.part}`;
}

/** Keeps the last `cap` characters of a stream of lines. */
function tail(cap: number) {
  const lines: string[] = [];
  let length = 0;
  let truncated = false;
  return {
    push(line: string) {
      lines.push(line);
      length += line.length + 1;
      while (length > cap && lines.length > 1) {
        length -= lines.shift()!.length + 1;
        truncated = true;
      }
    },
    result() {
      const text = lines.join("\n");
      return text.length > cap ? { output: text.slice(-cap), truncated: true } : { output: text, truncated };
    },
  };
}

/** Runs one command (a check or the setup command) if the command policy allows it. */
export async function runCommand(runner: ProcessRunner, command: string, options: RunCommandOptions): Promise<CheckResult> {
  const decision = checkCommand(command, options.rules, posixSh);
  if (!decision.allowed) {
    return { command, outcome: "refused", exitCode: null, durationMs: 0, output: refusal(decision), outputTruncated: false };
  }
  const output = tail(options.outputCap ?? DEFAULT_OUTPUT_CAP);
  const sink = { onLine: (line: string) => output.push(line),...(options.outputFile === undefined ? {} : { file: options.outputFile }) };
  const result = await runner.run({
    command: { shell: command },
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    stdout: sink,
    stderr: sink,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (result.kind === "not-started") {
    const outcome = result.reason === "aborted" ? "aborted" : "not-started";
    return { command, outcome, exitCode: null, durationMs: 0, output: result.message, outputTruncated: false };
  }
  const { output: text, truncated } = output.result();
  const outcome: CheckOutcome = result.timedOut
    ? "timed-out"
    : result.aborted
      ? "aborted"
      : result.exitCode === 0
        ? "passed"
        : "failed";
  return { command, outcome, exitCode: result.exitCode, durationMs: result.durationMs, output: text, outputTruncated: truncated };
}

/** Runs every command in order, each with its own timeout, and returns every result. */
export async function runChecks(runner: ProcessRunner, commands: readonly string[], options: Omit<RunCommandOptions, "outputFile">): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const command of commands) results.push(await runCommand(runner, command, options));
  return results;
}

/**
 * The loop guards' `checksPass(timeoutMs, signal)`: true when every command passes within
 * `timeoutMs` in total. False for an empty list (a step without checks is never idle-stopped),
 * at the first failure, and once `signal` fires (the running command is stopped).
 */
export function checksPass(
  runner: ProcessRunner,
  commands: readonly string[],
  options: Omit<RunCommandOptions, "timeoutMs" | "signal" | "outputFile">,
): (timeoutMs: number, signal: AbortSignal) => Promise<boolean> {
  return async (timeoutMs, signal) => {
    if (commands.length === 0) return false;
    const deadline = Date.now() + timeoutMs;
    for (const command of commands) {
      const left = deadline - Date.now();
      if (left <= 0 || signal.aborted) return false;
      const result = await runCommand(runner, command, { ...options, timeoutMs: left, signal });
      if (result.outcome !== "passed") return false;
    }
    return true;
  };
}
