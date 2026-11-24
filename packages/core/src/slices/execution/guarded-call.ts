// Runs one agent call under the loop guards: reads its event stream, polls the working tree, and
// aborts the call when a guard fires. A stop is not an error of the call: the stream still ends
// with its own `end` event, and the report says which guard stopped it and how much time was wasted.
import type { Clock, TimerHandle } from "../../kernel/clock/index.js";
import type { AgentCallRequest, AgentRuntime } from "../../kernel/ports/index.js";
import type { AgentCallEvent } from "../../kernel/schemas/index.js";
import {
  createFileWatch,
  createStreamWatch,
  type FileWatch,
  type FileWatchOptions,
  type GuardReport,
  guardReport,
  localModelGuardDefaults,
  type LoopGuardSettings,
  pollIntervalMs,
  type StopReason,
} from "./loop-guard.js";

type EndEvent = Extract<AgentCallEvent, { type: "end" }>;

export interface GuardedCallOptions {
  readonly clock: Clock;
  /** Default: `localModelGuardDefaults`. */
  readonly settings?: LoopGuardSettings;
  /** Watches the working tree for the idle stop and the wasted-time figures. Without it there is no idle stop. */
  readonly files?: Pick<FileWatchOptions, "snapshot" | "checksPass">;
  /** Sees every event of the call as it arrives. */
  readonly onEvent?: (event: AgentCallEvent) => void;
}

export interface GuardedCallResult {
  readonly end: EndEvent;
  readonly guard: GuardReport;
}

const NO_END: EndEvent = {
  type: "end",
  outcome: "failed",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  error: "the agent stream ended without an end event",
};

/**
 * Runs `request` on `runtime` until it ends, `signal` fires, or a guard stops it. A guard stop
 * stands unless the call completed: a call that completed before the stop took effect keeps it.
 */
export async function runGuardedCall(runtime: AgentRuntime, request: AgentCallRequest, signal: AbortSignal, options: GuardedCallOptions): Promise<GuardedCallResult> {
  const { clock } = options;
  const settings = options.settings ?? localModelGuardDefaults;
  const startedAt = clock.now();
  const deadline = startedAt + settings.timeoutMs;
  const controller = new AbortController();

  let stop: StopReason | null = null;
  const requestStop = (reason: StopReason) => {
    if (stop !== null || controller.signal.aborted) return;
    stop = reason;
    controller.abort();
  };

  const stream = createStreamWatch(settings);
  const files: FileWatch | undefined = options.files
    ? await createFileWatch(
        { ...options.files, idleMs: settings.idleMs, turnsAfter: stream.turnsAfter, turns: stream.turns, onChange: stream.resetRepeats },
        startedAt,
      )
    : undefined;

  const forwardAbort = () => controller.abort();
  signal.addEventListener("abort", forwardAbort, { once: true });
  if (signal.aborted) controller.abort();

  const timeout = clock.setTimeout(() => requestStop("timeout"), settings.timeoutMs);
  let pollTimer: TimerHandle | undefined;
  let polling: Promise<void> = Promise.resolve();
  const schedulePoll = (watch: FileWatch) => {
    pollTimer = clock.setTimeout(() => {
      polling = watch
        .poll(clock.now(), deadline, controller.signal)
        // A failed snapshot or check run is not a stop; the next poll tries again.
        .catch(() => undefined)
        .then((reason) => {
          if (reason) requestStop(reason);
          if (!controller.signal.aborted) schedulePoll(watch);
        });
    }, pollIntervalMs(settings.idleMs));
  };
  if (files) schedulePoll(files);

  let end: EndEvent = NO_END;
  try {
    for await (const event of runtime.launch(request, controller.signal)) {
      options.onEvent?.(event);
      if (event.type === "end") {
        end = event;
        break;
      }
      const reason = stream.observe(event, clock.now());
      if (reason) requestStop(reason);
    }
  } finally {
    clock.clearTimeout(timeout);
    if (pollTimer !== undefined) clock.clearTimeout(pollTimer);
    signal.removeEventListener("abort", forwardAbort);
    // Ends a check run still in flight.
    controller.abort();
  }
  await polling;
  const endedAt = clock.now();
  await files?.finish(endedAt);
  return { end, guard: guardReport(stream, files, startedAt, endedAt, end.outcome === "completed" ? null : stop) };
}
