// Loop guards for one agent call. An agent can finish its work and then keep calling tools without
// changing anything until the timeout, so the call is stopped when:
// - turn_cap: a turn asks for a tool call while the call already has `turnCap` turns;
// - repeat_limit: the same tool call comes `repeatLimit` times without a file change between;
// - idle: no file changed for `idleMs`, after at least one change, with the agent still taking
//   turns, and the step's checks pass;
// - timeout: the call ran for `timeoutMs`.
// Edit, test, edit, test is work, not a loop: a new edit or a file change starts the repeat counts
// again. One long file write is not idle: the idle stop needs turns after the last change.
import { z } from "zod";
import { ok, type Result } from "../../kernel/result/index.js";
import { type AgentCallEvent, parseWith, type ParseError } from "../../kernel/schemas/index.js";

/** The largest delay a platform timer takes. */
const MAX_TIMER_MS = 2_147_483_647;

export const LoopGuardSettingsSchema = z.strictObject({
  /** 0 turns the turn cap off. */
  turnCap: z.int().nonnegative(),
  /** 0 turns the repeat limit off; otherwise at least 2, since one call is no repeat. */
  repeatLimit: z
    .int()
    .nonnegative()
    .refine((limit) => limit === 0 || limit >= 2, { message: "0 or at least 2" }),
  /** 0 turns the idle stop off; file changes are still tracked for the wasted-time figures. */
  idleMs: z
    .int()
    .nonnegative()
    .refine((ms) => ms === 0 || ms >= 10_000, { message: "0 or at least 10000" }),
  /** Always on: the last stop after the other guards. */
  timeoutMs: z.int().positive().max(MAX_TIMER_MS),
});

export type LoopGuardSettings = z.output<typeof LoopGuardSettingsSchema>;

/** For a small local model, which finishes in few turns and then tends to loop. */
export const localModelGuardDefaults: LoopGuardSettings = { turnCap: 30, repeatLimit: 6, idleMs: 75_000, timeoutMs: 600_000 };

/** For Claude Code, which takes many more turns on a real task. */
export const claudeCodeGuardDefaults: LoopGuardSettings = { turnCap: 150, repeatLimit: 6, idleMs: 180_000, timeoutMs: 2_700_000 };

const LoopGuardOverridesSchema = LoopGuardSettingsSchema.partial();

/** A runtime's defaults with `overrides` applied, e.g. from the engine's settings file. */
export function loopGuardSettings(overrides: unknown = {}, defaults: LoopGuardSettings = localModelGuardDefaults): Result<LoopGuardSettings, ParseError> {
  const parsed = parseWith(LoopGuardOverridesSchema, overrides);
  if (!parsed.ok) return parsed;
  const { turnCap, repeatLimit, idleMs, timeoutMs } = parsed.value;
  return ok({
    turnCap: turnCap ?? defaults.turnCap,
    repeatLimit: repeatLimit ?? defaults.repeatLimit,
    idleMs: idleMs ?? defaults.idleMs,
    timeoutMs: timeoutMs ?? defaults.timeoutMs,
  });
}

export type StopReason = "turn_cap" | "repeat_limit" | "idle" | "timeout";

/** No idle stop until the agent took this many turns after the last change. */
export const MIN_TURNS_AFTER_CHANGE = 2;
/** An idle stop with more turns than this after the last change counts as a loop. */
export const LOOP_TURNS_AFTER_CHANGE = 5;
const MAX_POLL_MS = 10_000;
const MAX_TOUCHED_LISTED = 20;

/** Milliseconds between working-tree polls: every 10 s, or a quarter of a shorter idle window. */
export const pollIntervalMs = (idleMs: number): number => (idleMs > 0 ? Math.min(MAX_POLL_MS, idleMs / 4) : MAX_POLL_MS);

type ToolCall = Extract<AgentCallEvent, { type: "tool_call" }>;

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortKeys(record[key])]),
  );
};

/** What makes two tool calls the same: the tool name and its input, keys sorted. */
export function toolKey(call: Pick<ToolCall, "name" | "input">): string {
  try {
    return `${call.name}\n${JSON.stringify(sortKeys(call.input))}`;
  } catch {
    // Input nested too deep to walk: such calls count as one.
    return `${call.name}\n<unserializable>`;
  }
}

/** Counts turns and repeated tool calls in an agent call's event stream. */
export interface StreamWatch {
  /** Feeds one event that arrived at `now`. Returns `turn_cap` or `repeat_limit` to stop the call. */
  observe(event: AgentCallEvent, now: number): StopReason | undefined;
  /** A file changed: repeated calls before it are not a loop. */
  resetRepeats(): void;
  turns(): number;
  /** Turns that started after `at`. */
  turnsAfter(at: number): number;
}

export function createStreamWatch({ turnCap, repeatLimit }: Pick<LoopGuardSettings, "turnCap" | "repeatLimit">): StreamWatch {
  const turnTimes: number[] = [];
  const seenIds = new Set<string>();
  let counts = new Map<string, number>();

  return {
    observe(event, now) {
      if (event.type === "turn") {
        turnTimes.push(now);
        return undefined;
      }
      if (event.type !== "tool_call" || seenIds.has(event.id)) return undefined;
      seenIds.add(event.id);
      const key = toolKey(event);
      // A new edit: the repeats before it were work, not a loop.
      if (event.kind === "edit" && !counts.has(key)) counts = new Map();
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (repeatLimit > 0 && count >= repeatLimit) return "repeat_limit";
      // This turn asks for another one; the cap allows no more.
      if (turnCap > 0 && turnTimes.length >= turnCap) return "turn_cap";
      return undefined;
    },
    resetRepeats() {
      counts = new Map();
    },
    turns: () => turnTimes.length,
    turnsAfter: (at) => turnTimes.filter((time) => time > at).length,
  };
}

export interface FileState {
  /** Modification time, milliseconds since the Unix epoch. */
  readonly mtimeMs: number;
  readonly size: number;
}

/** The changed and untracked files of the working tree. `null`: listed, but gone (deleted). */
export type FileSnapshot = ReadonlyMap<string, FileState | null>;

export interface FileWatchOptions {
  /** The working tree now; `undefined` (or a throw) when it cannot be read. */
  readonly snapshot: () => Promise<FileSnapshot | undefined>;
  /**
   * True when every check of the step passes within `timeoutMs`; false when the step has no
   * checks, so a step without checks is never idle-stopped. Returns promptly once `signal` fires.
   */
  readonly checksPass: (timeoutMs: number, signal: AbortSignal) => Promise<boolean>;
  readonly idleMs: number;
  /** Turns after a time. Without it the idle stop does not wait for turns. */
  readonly turnsAfter?: (at: number) => number;
  /** Turns so far. With it, a check run during which the agent took a turn decides nothing. */
  readonly turns?: () => number;
  /** Called after each change seen. */
  readonly onChange?: () => void;
}

export interface IdleWatchStats {
  readonly checksRun: number;
  readonly checksFailed: number;
  /** Polls that skipped the idle stop because the agent took too few turns after the last change. */
  readonly skippedNoActivity: number;
  /** Files the checks changed, up to 20: not the agent's, ignored from then on. */
  readonly checkTouchedFiles: readonly string[];
}

/** Polls the working tree for changes and decides the idle stop. */
export interface FileWatch {
  /** Called every poll interval while the call runs. Returns `idle` to stop the call. */
  poll(now: number, deadline: number, signal: AbortSignal): Promise<"idle" | undefined>;
  /** Last look after the call ended, so a short call's changes are seen too. */
  finish(now: number): Promise<void>;
  lastChangeAt(): number | null;
  stats(): IdleWatchStats;
}

const sameState = (a: FileState | null | undefined, b: FileState | null | undefined) =>
  a === b || (a != null && b != null && a.mtimeMs === b.mtimeMs && a.size === b.size);

const changedPaths = (before: FileSnapshot, after: FileSnapshot) =>
  [...new Set([...before.keys(), ...after.keys()])].filter((path) => !sameState(before.get(path), after.get(path)));

/** When the change between two snapshots happened: the newest mtime of a changed file, within [lo, hi]. */
export function changeTime(before: FileSnapshot, after: FileSnapshot, lo: number, hi: number): number {
  const mtimes = changedPaths(before, after).flatMap((path) => {
    const state = after.get(path);
    return state ? [state.mtimeMs] : [];
  });
  return mtimes.length > 0 ? Math.min(Math.max(Math.max(...mtimes), lo), hi) : hi;
}

export async function createFileWatch(options: FileWatchOptions, now: number): Promise<FileWatch> {
  const { idleMs, turnsAfter, turns, onChange } = options;
  const checkTouched = new Set<string>();
  let checksRun = 0;
  let checksFailed = 0;
  let skippedNoActivity = 0;
  let lastChangeAt: number | null = null;
  // The last change the checks ran for: they run once per quiet period.
  let checkedFor: number | null = null;

  const take = async (): Promise<FileSnapshot | undefined> => {
    let snapshot: FileSnapshot | undefined;
    try {
      snapshot = await options.snapshot();
    } catch {
      return undefined;
    }
    if (snapshot === undefined) return undefined;
    return new Map([...snapshot].filter(([path]) => !checkTouched.has(path)));
  };
  const same = (a: FileSnapshot, b: FileSnapshot) => changedPaths(a, b).length === 0;

  let prev: FileSnapshot = (await take()) ?? new Map();
  let prevAt = now;

  const observeWith = (current: FileSnapshot | undefined, at: number) => {
    if (current === undefined) return;
    if (!same(current, prev)) {
      lastChangeAt = changeTime(prev, current, prevAt, at);
      prev = current;
      onChange?.();
    }
    prevAt = at;
  };

  return {
    async poll(at, deadline, signal) {
      observeWith(await take(), at);
      if (idleMs <= 0 || lastChangeAt === null || at - lastChangeAt < idleMs) return undefined;
      if (checkedFor === lastChangeAt) return undefined;
      if (turnsAfter && turnsAfter(lastChangeAt) < MIN_TURNS_AFTER_CHANGE) {
        // Maybe one long write in progress: wait.
        skippedNoActivity++;
        return undefined;
      }
      const before = await take();
      if (before === undefined || !same(before, prev)) {
        // A change right now: not idle.
        observeWith(before, at);
        return undefined;
      }
      checkedFor = lastChangeAt;
      checksRun++;
      const turnsBefore = turns?.();
      const passed = await options.checksPass(Math.max(1_000, deadline - at), signal);
      const after = await take();
      if (after === undefined) return undefined;
      if (turnsBefore !== undefined && turns?.() !== turnsBefore) {
        // The agent kept working during the run: what changed may be its edits, and the result is stale.
        observeWith(after, at);
        return undefined;
      }
      for (const path of changedPaths(before, after)) checkTouched.add(path);
      prev = new Map([...after].filter(([path]) => !checkTouched.has(path)));
      // The poll's start: a lower bound for later change times.
      prevAt = at;
      if (!passed) {
        checksFailed++;
        return undefined;
      }
      return "idle";
    },
    async finish(at) {
      observeWith(await take(), at);
    },
    lastChangeAt: () => lastChangeAt,
    stats: () => ({ checksRun, checksFailed, skippedNoActivity, checkTouchedFiles: [...checkTouched].sort().slice(0, MAX_TOUCHED_LISTED) }),
  };
}

/** What the guards recorded about one call. Plain JSON. */
export interface GuardReport {
  /** The guard that stopped the call; `null` when it ended on its own or the caller aborted it. */
  readonly stop: StopReason | null;
  readonly turns: number;
  /** Turns that started, and milliseconds that passed, after the last file change; the whole call when no file changed. */
  readonly turnsAfterLastChange: number;
  readonly msAfterLastChange: number;
  readonly lastChangeAt: number | null;
  /** Time burned in a loop: the time after the last file change of a call a guard stopped, else 0. */
  readonly wastedMs: number;
  /** A call stopped by the turn cap, repeat limit or timeout, or idle-stopped long after its last change. */
  readonly loop: boolean;
  /** Absent when the working tree was not watched. */
  readonly idleWatch?: IdleWatchStats;
}

export function guardReport(stream: StreamWatch, files: FileWatch | undefined, startedAt: number, endedAt: number, stop: StopReason | null): GuardReport {
  const lastChangeAt = files?.lastChangeAt() ?? null;
  const since = lastChangeAt ?? startedAt;
  const turnsAfterLastChange = stream.turnsAfter(since);
  const msAfterLastChange = Math.max(0, endedAt - since);
  const loop = stop === "idle" ? turnsAfterLastChange > LOOP_TURNS_AFTER_CHANGE : stop !== null;
  return {
    stop,
    turns: stream.turns(),
    turnsAfterLastChange,
    msAfterLastChange,
    lastChangeAt,
    wastedMs: stop === null ? 0 : msAfterLastChange,
    loop,
    ...(files ? { idleWatch: files.stats() } : {}),
  };
}
