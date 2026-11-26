// Stops the engine of one engine dir. One path for every caller (an update, a replace, the user's
// "Restart engine now"): ask the engine to stop, wait, and only then, when allowed, signal it.
//
// The engine's own socket says whether it lives: a connect that is refused, or finds no socket
// file, means it is dead; an accepted connect means it lives. No process list is read. A signal
// goes out only when, right before it, the socket accepts a connection and the lock still names the
// engine the caller meant: while the socket accepts, the lock's pid is that live engine, so a pid
// that another process took over is never hit. A probe that times out, or fails for any other
// reason, is "cannot tell", and nothing is signalled on a guess.
//
// An engine is stopped on Tokama's own initiative only with `ifIdle`: the engine itself refuses
// while an item runs, so no item can start between the count and the stop. Signals follow only an
// engine that said it was idle (or was idle when the caller last counted); a busy or silent engine
// is signalled only when the user asked for it (`ifIdle` false).
import { connect as connectSocket } from "node:net";
import { checkEngineDir, type Clock, engineEndpoint, hasCode, readEngineLock, SHUTDOWN_IF_IDLE_SINCE, sleep, systemClock } from "@tokama/core";
import { type EngineInfo, sendShutdown } from "./client.js";

export type StopResult =
  /** The engine is gone. `forced`: it took SIGKILL, so it could not end cleanly. */
  | { readonly kind: "stopped"; readonly forced: boolean }
  /** `ifIdle` and items run (or the engine could not count them): it was not asked to stop, or refused. Nothing was signalled. */
  | { readonly kind: "refused"; readonly runningItems?: number }
  /** The lock names another engine than the one the caller meant: someone else replaced it. Nothing more was sent. */
  | { readonly kind: "replaced" }
  /** Still running, or not known to be stopped, and nothing more may be sent. `pid` is the lock's, when it names one. */
  | { readonly kind: "still_running"; readonly pid?: number };

export type Liveness = "alive" | "dead" | "unknown";

export interface StopOptions {
  /** The engine dir. */
  readonly dir: string;
  /** The engine id the lock named when the caller decided to stop it; a lock naming another engine is left alone. */
  readonly expectedEngineId?: string;
  /** What the engine said about itself in its handshake, when the caller has it. */
  readonly engine?: Pick<EngineInfo, "apiVersion" | "runningItems">;
  /** Stop only an idle engine. */
  readonly ifIdle: boolean;
  /** After the request, signal the engine when it does not stop: SIGTERM, then SIGKILL. */
  readonly force: boolean;
  /** Sends one signal to one pid, e.g. `posixEngineProcesses.signal`. */
  readonly signal: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  /** Default: the system clock. */
  readonly clock?: Clock;
  /** How long each step waits for the engine to stop. Default 15 s. */
  readonly stepMs?: number;
  /** How often it looks meanwhile. Default 200 ms. */
  readonly pollMs?: number;
  /** Tells whether something listens on the socket. Default: one connect. A test stands in for it. */
  readonly probe?: (socketPath: string) => Promise<Liveness>;
}

const PROBE_TIMEOUT_MS = 2_000;

/** One connect to the socket: accepted is alive, refused or no such file is dead, anything else is not knowing. */
export function probeSocket(socketPath: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<Liveness> {
  return new Promise((resolve) => {
    const socket = connectSocket(socketPath);
    const done = (state: Liveness) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(state);
    };
    const timer = setTimeout(() => done("unknown"), timeoutMs);
    socket.once("connect", () => done("alive"));
    socket.once("error", (error) => done(hasCode(error, "ECONNREFUSED") || hasCode(error, "ENOENT") ? "dead" : "unknown"));
  });
}

export async function stopEngine(options: StopOptions): Promise<StopResult> {
  const endpoint = engineEndpoint(options.dir);
  // No engine listens on a socket that has no valid path.
  if (!endpoint.ok) return { kind: "stopped", forced: false };
  const { socketPath, lockPath } = endpoint.value;
  const clock = options.clock ?? systemClock;
  const stepMs = options.stepMs ?? 15_000;
  const pollMs = options.pollMs ?? 200;
  const probe = options.probe ?? ((path: string) => probeSocket(path));
  const expected = options.expectedEngineId;
  const named = () => readEngineLock(lockPath);
  const first = named();
  // The engine the caller meant: the one it named, or else the one the lock named when this began.
  const meant = (lock: ReturnType<typeof named>) => lock !== undefined && (expected !== undefined ? lock.engineId === expected : lock.pid === first?.pid && lock.engineId === first.engineId);
  const stillRunning = (): StopResult => {
    const lock = named();
    return lock === undefined ? { kind: "still_running" } : { kind: "still_running", pid: lock.pid };
  };

  if (expected !== undefined && first !== undefined && first.engineId !== expected) return { kind: "replaced" };
  if ((await probe(socketPath)) === "dead") return { kind: "stopped", forced: false };

  // An engine that does not know `ifIdle` would stop whatever it runs, so it is asked nothing
  // unless its handshake said that it runs nothing.
  let ifIdle = options.ifIdle;
  const info = options.engine;
  if (ifIdle && info !== undefined && info.apiVersion < SHUTDOWN_IF_IDLE_SINCE) {
    if (info.runningItems !== 0) return { kind: "refused", ...(info.runningItems !== undefined && { runningItems: info.runningItems }) };
    ifIdle = false;
  }
  const answer = await sendShutdown(options.dir, { ifIdle });
  if (answer.kind === "refused") return { kind: "refused", ...(answer.runningItems !== undefined && { runningItems: answer.runningItems }) };

  // Gone: nothing listens, and (while the engine ends cleanly) its lock is released. After a kill
  // the lock stays behind, so at the end of the wait a dead socket is enough.
  const waitGone = async (lockMustGo: boolean): Promise<boolean> => {
    const deadline = clock.now() + stepMs;
    for (;;) {
      const dead = (await probe(socketPath)) === "dead";
      if (dead && (!lockMustGo || !meant(named()))) return true;
      if (clock.now() >= deadline) return dead;
      await sleep(clock, pollMs);
    }
  };

  /** The signal, only if the socket accepts and the lock still names the same engine, checked right before. */
  const signalGuarded = async (signal: "SIGTERM" | "SIGKILL"): Promise<"sent" | StopResult> => {
    const lock = named();
    if (lock === undefined) return (await probe(socketPath)) === "dead" ? { kind: "stopped", forced: false } : stillRunning();
    if (expected !== undefined && lock.engineId !== expected) return { kind: "replaced" };
    // The pid is trusted only in a folder that is ours and private, and is never this process.
    if (!checkEngineDir(options.dir).ok || lock.pid === process.pid) return stillRunning();
    const state = await probe(socketPath);
    if (state === "dead") return { kind: "stopped", forced: false };
    if (state === "unknown") return stillRunning();
    const after = named();
    if (after === undefined || after.pid !== lock.pid || after.engineId !== lock.engineId) return { kind: "replaced" };
    try {
      options.signal(lock.pid, signal);
    } catch {
      // A signal that cannot be sent (no right to it) leaves the engine running.
      return stillRunning();
    }
    return "sent";
  };

  if (answer.kind === "accepted" && (await waitGone(true))) return { kind: "stopped", forced: false };

  // Signals: only for a caller that may force, and only an engine that is known to be idle, or one
  // the user chose to stop.
  const knownIdle = answer.kind === "accepted" || info?.runningItems === 0;
  if (!options.force || (options.ifIdle && !knownIdle)) return stillRunning();
  for (const [signal, forced] of [["SIGTERM", false], ["SIGKILL", true]] as const) {
    const sent = await signalGuarded(signal);
    if (sent !== "sent") return sent;
    if (await waitGone(!forced)) return { kind: "stopped", forced };
  }
  return stillRunning();
}
