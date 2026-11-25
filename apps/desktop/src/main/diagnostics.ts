// What the desktop app reports to the engine's diagnostics: its own errors and crashes, and the
// renderer's errors. The engine cleans and records them; the app sends nothing anywhere else. No
// Electron here, so it is tested without the app.
//
// The renderer is untrusted input: it may send a message and a stack, two strings, and nothing
// else, at a bounded rate. It never names the source, the kind or any other field.
import { closeSync, constants, fstatSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { type CrashKind, type DiagnosticReportInput, type ErrorWhere, MAX_REPORTED_STACK_CHARS } from "@tokama/core";
import { RENDERER_USAGE_ACTIONS, type RendererUsageAction } from "../shared/bridge.js";

/** What the renderer may report through its narrow channel: the error's message and stack. */
export function rendererErrorReport(input: unknown): DiagnosticReportInput | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const { message, stack } = input as { message?: unknown; stack?: unknown };
  const text = (value: unknown) => (typeof value === "string" ? value.slice(0, MAX_REPORTED_STACK_CHARS).trim() : "");
  const messageText = text(message);
  const stackText = text(stack);
  // A browser stack starts with `Name: message`; without one, the message is all there is.
  const combined = stackText !== "" ? stackText : messageText !== "" ? `Error: ${messageText}` : "";
  if (combined === "") return undefined;
  return { type: "error", source: "renderer", where: "uncaught", stack: combined.slice(0, MAX_REPORTED_STACK_CHARS) };
}

/** A usage action the renderer may count: one of the fixed names of the actions only the window sees. */
export function rendererUsageReport(input: unknown): DiagnosticReportInput | undefined {
  const known = (RENDERER_USAGE_ACTIONS as readonly unknown[]).find((action) => action === input);
  return known === undefined ? undefined : { type: "usage", action: known as RendererUsageAction };
}

/** A main-process error as a report. */
export function mainErrorReport(thrown: unknown, where: ErrorWhere): DiagnosticReportInput {
  let stack: string;
  try {
    stack = thrown instanceof Error ? (thrown.stack ?? `${thrown.name}: ${thrown.message}`) : `NonError: ${String(thrown)}`;
  } catch {
    stack = "NonError: (unprintable value)";
  }
  return { type: "error", source: "desktop", where, stack: (stack.trim() || "Error").slice(0, MAX_REPORTED_STACK_CHARS) };
}

const GONE_REASONS: Readonly<Record<string, CrashKind>> = {
  crashed: "crashed",
  oom: "oom",
  killed: "killed",
  "launch-failed": "launch_failed",
  "integrity-failure": "integrity_failure",
  "abnormal-exit": "abnormal_exit",
  "memory-eviction": "memory_eviction",
};

/** The crash kind of a renderer that went away; undefined for a clean exit or an unknown reason. */
export function rendererGoneKind(reason: string): CrashKind | undefined {
  return Object.hasOwn(GONE_REASONS, reason) ? GONE_REASONS[reason] : undefined;
}

/** True at most `max` times per `windowMs`. */
export function rateLimit(max: number, windowMs: number, now: () => number = Date.now): () => boolean {
  const times: number[] = [];
  return () => {
    const at = now();
    while (times.length > 0 && times[0]! <= at - windowMs) times.shift();
    if (times.length >= max) return false;
    times.push(at);
    return true;
  };
}

/** What became of a send: sent, try again once connected, or dropped (an older engine refused it). */
export type SendOutcome = "sent" | "retry" | "dropped";

export interface Reporter {
  /** Queues a report and sends it when it can. */
  report(report: DiagnosticReportInput): void;
  /** Sends what is queued, in order; stops at the first one that must wait for a connection. */
  flush(): Promise<void>;
}

/** Keeps at most `max` reports while there is no engine; the oldest go first. */
export function createReporter(send: (report: DiagnosticReportInput) => Promise<SendOutcome>, max = 50): Reporter {
  const queue: DiagnosticReportInput[] = [];
  let flushing: Promise<void> | undefined;
  const drain = async () => {
    while (queue.length > 0) {
      let outcome: SendOutcome;
      try {
        outcome = await send(queue[0]!);
      } catch {
        outcome = "retry";
      }
      if (outcome === "retry") return;
      queue.shift();
    }
  };
  const flush = () => {
    flushing ??= drain().finally(() => (flushing = undefined));
    return flushing;
  };
  return {
    report: (report) => {
      queue.push(report);
      if (queue.length > max) queue.splice(0, queue.length - max);
      void flush();
    },
    flush,
  };
}

/**
 * The app's running marker: written at start with the app's pid, removed on a clean quit. Found
 * at start with the pid of a process that is gone, it means the last run crashed. A live pid is
 * another copy of the app still running, not a crash.
 */
export function runMarker(path: string, pid: number, alive: (pid: number) => boolean): { readonly crashedBefore: boolean; clear(): void } {
  const previous = readPid(path);
  const crashedBefore = previous !== undefined && previous !== pid && !alive(previous);
  writeAtomic(path, `${pid}\n`);
  return {
    crashedBefore,
    clear: () => {
      if (readPid(path) !== pid) return;
      try {
        unlinkSync(path);
      } catch {
        // Already gone.
      }
    },
  };
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readPid(path: string): number | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return undefined;
    const buffer = Buffer.alloc(32);
    const word = buffer.subarray(0, readSync(fd, buffer, 0, 32, 0)).toString("utf8").trim();
    return /^[1-9]\d{0,9}$/.test(word) ? Number(word) : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeAtomic(path: string, text: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    try {
      unlinkSync(temp);
    } catch {
      // No stale temp file.
    }
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  } catch {
    // Without a marker a crash goes unnoticed; the app works the same.
  }
}
