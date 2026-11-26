import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { systemClock, type Clock, type TimerHandle } from "../../../kernel/clock/index.js";
import { replaceTextSync } from "../../../kernel/fs-safe/index.js";
import { createProcessRunner, type ProcessRunner, type RunResult } from "../../../kernel/process/index.js";
import type { AgentCallRequest, AgentRuntime } from "../../../kernel/ports/index.js";
import type { AgentCallErrorKind, AgentCallEvent, TokenUsage } from "../../../kernel/schemas/index.js";
import { buildArgs, userMessage, usesShell } from "./args.js";
import { hookSettings } from "./permission-hook.js";
import { classifyFailure, createStreamParser, type StreamParser, type StreamState } from "./stream.js";
import { CLAUDE_CODE_COMMAND } from "./command.js";
import { commandRulesProblem, readClaudeVersion } from "./version.js";

export interface ClaudeCodeOptions {
  /** argv that starts the CLI. Default: `[CLAUDE_CODE_COMMAND]`, found on the allowlisted PATH. */
  readonly command?: readonly [string, ...string[]];
  /** Variables added to the allowlisted environment, e.g. for local-model routing. */
  readonly env?: Readonly<Record<string, string>>;
  readonly runner?: ProcessRunner;
  /** Timers for the stop after a result. Default: the system clock. */
  readonly clock?: Clock;
  /** How long the CLI may keep running after it reported its result. Default: 10 s. */
  readonly resultGraceMs?: number;
  /** argv of the command-policy hook, before the rules file. Default: this Node running hook.js. */
  readonly hookCommand?: readonly [string, ...string[]];
}

const NO_TOKENS: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const STDERR_LINES = 20;
const ERROR_CHARS = 1_000;
const RESULT_GRACE_MS = 10_000;

/**
 * Drives `claude -p` headless: one call per launch, stream-json in and out. Every request needs
 * `timeoutMs`: the runtime owns the call's timeout and reports it as a run failure. Run it under
 * the execution slice's `claudeCodeGuardDefaults`, whose timeout is only a backstop.
 */
export function createClaudeCodeRuntime(options: ClaudeCodeOptions = {}): AgentRuntime {
  const command = options.command ?? [CLAUDE_CODE_COMMAND];
  const runner = options.runner ?? createProcessRunner();
  const clock = options.clock ?? systemClock;
  const resultGraceMs = options.resultGraceMs ?? RESULT_GRACE_MS;
  const hookCommand = options.hookCommand ?? [process.execPath, fileURLToPath(new URL("./hook.js", import.meta.url))];

  return {
    async *launch(request, signal) {
      if (request.timeoutMs === undefined) {
        yield { type: "end", outcome: "failed", usage: NO_TOKENS, error: "a Claude Code call needs timeoutMs", errorKind: "crash" };
        return;
      }
      const timeoutMs = request.timeoutMs;
      // Older versions ignore or reject the hook's `onFailure`, so a hook that cannot start would
      // let a command run unchecked. Calls without the shell have no hook and need no check. The
      // version is read on every call: the runtime outlives updates and downgrades of the CLI.
      if (usesShell(request)) {
        const read = await readClaudeVersion({ command, runner, signal, ...(options.env !== undefined && { env: options.env }) });
        if (read.kind === "aborted") {
          yield { type: "end", outcome: "aborted", usage: NO_TOKENS };
          return;
        }
        const problem = commandRulesProblem(read.kind === "version" ? read.version : undefined, read.kind === "unknown" ? read.why : undefined);
        if (problem !== undefined) {
          yield { type: "end", outcome: "failed", usage: NO_TOKENS, error: problem, errorKind: "crash" };
          return;
        }
      }
      let callDir: string | undefined;
      try {
        callDir = usesShell(request) ? writeHookFiles(request, hookCommand) : undefined;
      } catch (error) {
        yield { type: "end", outcome: "failed", usage: NO_TOKENS, error: `could not write the call's settings: ${String(error)}`, errorKind: "crash" };
        return;
      }
      const args = buildArgs(request, callDir === undefined ? undefined : join(callDir, "settings.json"));
      if (!args.ok) {
        if (callDir !== undefined) rmSync(callDir, { recursive: true, force: true });
        yield { type: "end", outcome: "failed", usage: NO_TOKENS, error: args.error, errorKind: "crash" };
        return;
      }
      // Stops the call when the caller stops reading, and shortly after a result if the CLI
      // lingers, so the process tree never outlives the call.
      const stop = new AbortController();
      let grace: TimerHandle | undefined;
      const events = eventQueue();
      const parser = createStreamParser(request.cwd);
      const stderr: string[] = [];
      const onLine = (line: string) => {
        parser.line(line).forEach(events.push);
        if (grace === undefined && parser.state().result !== undefined) grace = clock.setTimeout(() => stop.abort(), resultGraceMs);
      };
      const run = runner
        .run({
          command: { argv: [...command, ...args.value] },
          cwd: request.cwd,
          ...(options.env !== undefined && { env: options.env }),
          stdin: userMessage(request.prompt),
          timeoutMs,
          signal: AbortSignal.any([signal, stop.signal]),
          onSpawn: (pid) => events.push({ type: "started", pid }),
          stdout: { onLine },
          stderr: {
            onLine: (line) => {
              stderr.push(line);
              if (stderr.length > STDERR_LINES) stderr.shift();
            },
          },
        })
        .then(
          (result) => endEvent(result, parser, stderr.join("\n"), signal, timeoutMs),
          (error: unknown) => failed(parser.state(), `the call failed: ${String(error)}`, "crash"),
        )
        .then((end) => {
          events.push(end);
          events.close();
        });
      try {
        yield* events;
      } finally {
        stop.abort();
        await run;
        if (grace !== undefined) clock.clearTimeout(grace);
        if (callDir !== undefined) rmSync(callDir, { recursive: true, force: true });
      }
    },
  };
}

/**
 * Writes the hook's settings and the step's command rules to a new folder outside the worktree,
 * readable by the user only, so the agent cannot change them. Returns the folder.
 */
function writeHookFiles(request: AgentCallRequest, hookCommand: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "tokama-claude-call-"));
  chmodSync(dir, 0o700);
  const rules = join(dir, "rules.json");
  for (const [path, text] of [
    [rules, JSON.stringify({ commands: request.limits?.commands ?? [] })],
    [join(dir, "settings.json"), JSON.stringify(hookSettings([...hookCommand, rules]))],
  ] as const) {
    const written = replaceTextSync(path, text, 0o600);
    if (!written.ok) throw new Error(written.error.message);
  }
  return dir;
}

type EndEvent = Extract<AgentCallEvent, { type: "end" }>;

function endEvent(result: RunResult, parser: StreamParser, stderr: string, signal: AbortSignal, timeoutMs: number): EndEvent {
  const state = parser.state();
  if (result.kind === "not-started") {
    if (result.reason === "aborted") return { type: "end", outcome: "aborted", usage: NO_TOKENS };
    return failed(state, `Claude Code did not start: ${parser.scrub(result.message)}`, "crash");
  }
  const { durationMs } = result;
  // A result that arrived first wins over a stop or timeout that came after it.
  if (state.result !== undefined) {
    if (!state.result.isError) return { type: "end", outcome: "completed", ...ending(state), durationMs };
    const subtype = state.result.subtype !== undefined && state.result.subtype !== "success" ? state.result.subtype : undefined;
    const words = state.result.text || state.assistantError?.text || stderr.trim();
    const said = subtype === undefined ? words || "Claude Code reported an error" : words ? `${words} (${subtype})` : subtype;
    return failed(state, parser.scrub(said), classifyFailure(state, stderr), durationMs);
  }
  if (result.aborted || signal.aborted) return { type: "end", outcome: "aborted", ...ending(state), durationMs };
  if (result.timedOut) return failed(state, `timed out after ${timeoutMs} ms`, "timeout", durationMs);
  const exit = result.exitCode !== null ? `exit code ${result.exitCode}` : `signal ${result.signal ?? "unknown"}`;
  const said = state.assistantError?.text || stderr.trim() || `Claude Code ended without a result (${exit})`;
  return failed(state, parser.scrub(said), classifyFailure(state, stderr), durationMs);
}

function failed(state: StreamState, error: string, errorKind: AgentCallErrorKind, durationMs?: number): EndEvent {
  return {
    type: "end",
    outcome: "failed",
    ...ending(state),
    error: error.slice(0, ERROR_CHARS),
    errorKind,
    ...(durationMs !== undefined && { durationMs }),
  };
}

function ending(state: StreamState) {
  return {
    usage: state.usage,
    ...(state.modelUsage !== undefined && { modelUsage: state.modelUsage }),
    ...(state.costUsd !== undefined && { costUsd: state.costUsd }),
    ...(state.sessionId !== undefined && { sessionId: state.sessionId }),
  };
}

/** Events pushed from process callbacks, read by the async generator in order. */
function eventQueue() {
  const items: AgentCallEvent[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  return {
    push: (event: AgentCallEvent) => {
      items.push(event);
      notify();
    },
    close: () => {
      closed = true;
      notify();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = items.shift();
        if (next !== undefined) yield next;
        else if (closed) return;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
}
