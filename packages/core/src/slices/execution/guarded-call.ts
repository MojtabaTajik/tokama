// Runs one agent call under the loop guards: reads its event stream, polls the working tree, and
// aborts the call when a guard fires. It also tracks the call's activity (activity.ts): the latest
// action, the last event time and the tool still running, for the live display and the guards. A stop is not an error of the call: the stream still ends
// with its own `end` event, and the report says which guard stopped it and how much time was wasted.
import type { Clock, TimerHandle } from "../../kernel/clock/index.js";
import type { AgentCallRequest, AgentRuntime } from "../../kernel/ports/index.js";
import type { AgentCallEvent, PlanSnapshot } from "../../kernel/schemas/index.js";
import { type ActivityState, createActivityTracker } from "./activity.js";
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
  /** Sees the call's activity at its start and after each of the agent's events. */
  readonly onActivity?: (activity: ActivityState) => void;
}

export interface GuardedCallResult {
  readonly end: EndEvent;
  readonly guard: GuardReport;
  readonly startedAt: number;
  readonly endedAt: number;
  /** The plan windows of the call's last rate-limit event. */
  readonly plan?: PlanSnapshot;
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
  const activity = createActivityTracker(startedAt);
  options.onActivity?.(activity.state());
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
  // One timer for both silence stops. The limit that applies is `silentMs` while no tool runs and
  // `toolSilentMs` while one does. The timer is due when the silence would reach that limit, or
  // after the other limit, since an event in between can start or end a tool; an event since
  // moves the due time later.
  let silenceTimer: TimerHandle | undefined;
  const silenceLimit = (toolRunning: boolean) => (toolRunning ? { reason: "tool_silent" as const, ms: settings.toolSilentMs } : { reason: "silent" as const, ms: settings.silentMs });
  const scheduleSilenceCheck = (delayMs: number) => {
    silenceTimer = clock.setTimeout(() => {
      if (controller.signal.aborted) return;
      const state = activity.state();
      const now = clock.now();
      const limit = silenceLimit(state.toolRunning !== null);
      if (limit.ms > 0 && now - state.lastEventAt >= limit.ms) return requestStop(limit.reason);
      const other = silenceLimit(state.toolRunning === null).ms;
      const due = Math.min(limit.ms > 0 ? state.lastEventAt + limit.ms - now : Infinity, other > 0 ? other : Infinity);
      scheduleSilenceCheck(Math.max(1, due));
    }, delayMs);
  };
  // The first look comes at the shorter limit: a tool may start at once.
  const firstCheck = Math.min(...[settings.silentMs, settings.toolSilentMs].filter((ms) => ms > 0));
  if (Number.isFinite(firstCheck)) scheduleSilenceCheck(firstCheck);
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
  let plan: PlanSnapshot | undefined;
  try {
    for await (const event of runtime.launch(request, controller.signal)) {
      options.onEvent?.(event);
      if (activity.observe(event, clock.now())) options.onActivity?.(activity.state());
      if (event.type === "rate_limit") plan = { status: event.status, windows: event.windows, at: clock.now() };
      if (event.type === "end") {
        end = event;
        break;
      }
      const reason = stream.observe(event, clock.now());
      if (reason) requestStop(reason);
    }
  } finally {
    clock.clearTimeout(timeout);
    if (silenceTimer !== undefined) clock.clearTimeout(silenceTimer);
    if (pollTimer !== undefined) clock.clearTimeout(pollTimer);
    signal.removeEventListener("abort", forwardAbort);
    // Ends a check run still in flight.
    controller.abort();
  }
  await polling;
  const endedAt = clock.now();
  await files?.finish(endedAt);
  return { end, guard: guardReport(stream, files, startedAt, endedAt, end.outcome === "completed" ? null : stop), startedAt, endedAt, ...(plan !== undefined && { plan }) };
}
