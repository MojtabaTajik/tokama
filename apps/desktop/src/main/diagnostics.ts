// What the desktop app reports to the engine's diagnostics: its own errors and crashes, and the
// renderer's errors. The engine cleans and records them; the app sends nothing anywhere else. No
// Electron here, so it is tested without the app.
//
// The renderer is untrusted input: it may send a message and a stack, two strings, and nothing
// else, at a bounded rate. It never names the source, the kind or any other field.
import { mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { type CrashKind, type DiagnosticReportInput, type ErrorWhere, MAX_REPORTED_STACK_CHARS, readPidFile, replaceTextSync } from "@tokama/core";
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

/** Keeps at most `max` reports while there is no engine; the oldest go first, and usage counts before any error or crash. */
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
      while (queue.length > max) {
        const count = queue.findIndex((queued) => queued.type === "usage");
        queue.splice(count === -1 ? 0 : count, 1);
      }
      void flush();
    },
    flush,
  };
}

/**
 * The app's running marker: written at start (creating its folder when missing) with the app's pid, removed on a clean quit. Found
 * at start with the pid of a process that is gone, it means the last run crashed. A live pid is
 * another copy of the app still running, not a crash.
 */
export function runMarker(path: string, pid: number, alive: (pid: number) => boolean): { readonly crashedBefore: boolean; clear(): void } {
  const previous = readPidFile(path)?.pid;
  const crashedBefore = previous !== undefined && previous !== pid && !alive(previous);
  try {
    // A first start comes before the engine has made the folder.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch {
    // The write below fails too, and the app goes on without a marker.
  }
  // Without a marker a crash goes unnoticed; the app works the same.
  replaceTextSync(path, `${pid}\n`, 0o600);
  return {
    crashedBefore,
    clear: () => {
      if (readPidFile(path)?.pid !== pid) return;
      try {
        unlinkSync(path);
      } catch {
        // Already gone.
      }
    },
  };
}
