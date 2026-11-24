import { createProcessRunner, type ProcessRunner, type RunResult } from "../../../kernel/process/index.js";
import type { AgentRuntime } from "../../../kernel/ports/index.js";
import type { AgentCallErrorKind, AgentCallEvent, TokenUsage } from "../../../kernel/schemas/index.js";
import { buildArgs, userMessage } from "./args.js";
import { classifyFailure, createStreamParser, type StreamState } from "./stream.js";

export interface ClaudeCodeOptions {
  /** argv that starts the CLI. Default: `["claude"]`, found on the allowlisted PATH. */
  readonly command?: readonly [string, ...string[]];
  /** Variables added to the allowlisted environment, e.g. for local-model routing. */
  readonly env?: Readonly<Record<string, string>>;
  readonly runner?: ProcessRunner;
}

const NO_TOKENS: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const STDERR_LINES = 20;
const ERROR_CHARS = 1_000;

/** Drives `claude -p` headless: one call per launch, stream-json in and out. */
export function createClaudeCodeRuntime(options: ClaudeCodeOptions = {}): AgentRuntime {
  const command = options.command ?? ["claude"];
  const runner = options.runner ?? createProcessRunner();

  return {
    async *launch(request, signal) {
      const args = buildArgs(request);
      if (!args.ok) {
        yield { type: "end", outcome: "failed", usage: NO_TOKENS, error: args.error, errorKind: "crash" };
        return;
      }
      // Stops the call when the caller stops reading too, so the process tree never outlives it.
      const stop = new AbortController();
      const events = eventQueue();
      const parser = createStreamParser(request.cwd);
      const stderr: string[] = [];
      const run = runner
        .run({
          command: { argv: [...command, ...args.value] },
          cwd: request.cwd,
          ...(options.env !== undefined && { env: options.env }),
          stdin: userMessage(request.prompt),
          ...(request.timeoutMs !== undefined && { timeoutMs: request.timeoutMs }),
          signal: AbortSignal.any([signal, stop.signal]),
          onSpawn: (pid) => events.push({ type: "started", pid }),
          stdout: { onLine: (line) => parser.line(line).forEach(events.push) },
          stderr: {
            onLine: (line) => {
              stderr.push(line);
              if (stderr.length > STDERR_LINES) stderr.shift();
            },
          },
        })
        .then(
          (result) => endEvent(result, parser.state(), stderr.join("\n"), signal, request.timeoutMs),
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
      }
    },
  };
}

type EndEvent = Extract<AgentCallEvent, { type: "end" }>;

function endEvent(result: RunResult, state: StreamState, stderr: string, signal: AbortSignal, timeoutMs?: number): EndEvent {
  if (result.kind === "not-started") {
    if (result.reason === "aborted") return { type: "end", outcome: "aborted", usage: NO_TOKENS };
    return failed(state, `Claude Code did not start: ${result.message}`, "crash");
  }
  const { durationMs } = result;
  // A result that arrived first wins over a stop or timeout that came after it.
  if (state.result !== undefined && !state.result.isError) return { type: "end", outcome: "completed", ...ending(state), durationMs };
  if (result.aborted || (signal.aborted && state.result === undefined)) return { type: "end", outcome: "aborted", ...ending(state), durationMs };
  if (result.timedOut) return failed(state, `timed out after ${timeoutMs ?? 0} ms`, "timeout", durationMs);
  const exit = result.exitCode !== null ? `exit code ${result.exitCode}` : `signal ${result.signal ?? "unknown"}`;
  const said = state.result?.text || state.assistantError?.text || stderr.trim() || `Claude Code ended without a result (${exit})`;
  return failed(state, said, classifyFailure(state, stderr), durationMs);
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
