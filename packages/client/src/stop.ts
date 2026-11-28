// Stops the engine that a lock names. One path for every caller (an update, a replace, the user's
// "Restart engine now"): ask the engine to stop, wait, and only then, when allowed, signal it.
//
// The engine's own socket says whether it lives: a connect that is refused, or finds no socket
// file, means it is dead; an accepted connect means it lives. No process list is read. A signal
// goes out only to the pid in the lock, and only when, right before it, one of two things holds:
//
//  - Identity proven: the engine behind the socket answered a token-checked shutdown request with
//    the engine id and pid of the lock. Nothing else can answer there.
//  - Identity not proven (an engine of an older build sends no pid, or accepts and never answers):
//    the lock is valid, unchanged since it was read, its folder is ours and private, and its
//    socket accepts a connection. A socket that is dead never gets a signal, so a stale lock whose
//    pid another process took over is never acted on.
//
// A probe that times out, or fails for any other reason, is "cannot tell", and nothing is signalled
// on a guess.
//
// An engine is stopped on Tokama's own initiative only with `ifIdle`: the engine itself refuses
// while an item runs, so no item can start between the count and the stop. Signals follow only an
// engine that said it was idle (or was idle when the caller last counted); a busy or silent engine
// is signalled only when the user asked for it (`ifIdle` false).
import { dirname } from "node:path";
import { checkEngineDir, type Clock, type EngineLock, type Liveness, probeSocket, readEngineLock, SHUTDOWN_IF_IDLE_SINCE, sleep, systemClock, tokenPathOf } from "@tokama/core";
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

export interface StopOptions {
  /** The engine's lock file. */
  readonly lockPath: string;
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
  /**
   * Called with the engine's pid right before SIGKILL, the one signal after which the engine
   * cannot end cleanly. The desktop app leaves the note there that tells the next engine this
   * was not a crash. It must not throw (a throw cancels the kill). The function it returns, if
   * any, is called when the signal could not be sent, to take the note back.
   */
  readonly beforeKill?: (pid: number) => (() => void) | void;
  /** Default: the system clock. */
  readonly clock?: Clock;
  /** How long each step waits for the engine to stop. Default 15 s. */
  readonly stepMs?: number;
  /** How often it looks meanwhile. Default 200 ms. */
  readonly pollMs?: number;
  /** Tells whether something listens on the socket. Default: one connect. A test stands in for it. */
  readonly probe?: (socketPath: string) => Promise<Liveness>;
}

export async function stopEngine(options: StopOptions): Promise<StopResult> {
  const clock = options.clock ?? systemClock;
  const stepMs = options.stepMs ?? 15_000;
  const pollMs = options.pollMs ?? 200;
  const probe = options.probe ?? ((path: string) => probeSocket(path));
  const expected = options.expectedEngineId;
  const named = () => readEngineLock(options.lockPath);
  const first = named();
  // No lock, no engine to stop.
  if (first === undefined) return { kind: "stopped", forced: false };
  // The engine the caller meant: the one it named, or else the one the lock named when this began.
  const meant = (lock: EngineLock | undefined) => lock !== undefined && (expected !== undefined ? lock.engineId === expected : lock.text === first.text);
  const filesOf = (lock: EngineLock) => ({ socketPath: lock.socketPath, tokenPath: tokenPathOf(lock.socketPath) });
  const stillRunning = (): StopResult => {
    const lock = named();
    return lock === undefined ? { kind: "still_running" } : { kind: "still_running", pid: lock.pid };
  };

  if (expected !== undefined && first.engineId !== expected) return { kind: "replaced" };
  if ((await probe(first.socketPath)) === "dead") return { kind: "stopped", forced: false };

  // An engine that does not know `ifIdle` would stop whatever it runs, so it is asked nothing
  // unless its handshake said that it runs nothing.
  let ifIdle = options.ifIdle;
  const info = options.engine;
  if (ifIdle && info !== undefined && info.apiVersion < SHUTDOWN_IF_IDLE_SINCE) {
    if (info.runningItems !== 0) return { kind: "refused", ...(info.runningItems !== undefined && { runningItems: info.runningItems }) };
    ifIdle = false;
  }
  const answer = await sendShutdown(filesOf(first), { ifIdle });
  if (answer.kind === "refused") return { kind: "refused", ...(answer.runningItems !== undefined && { runningItems: answer.runningItems }) };

  // Gone: nothing listens, and (while the engine ends cleanly) its lock is released. After a kill
  // the lock stays behind, so at the end of the wait a dead socket is enough.
  const waitGone = async (lockMustGo: boolean): Promise<boolean> => {
    const deadline = clock.now() + stepMs;
    for (;;) {
      const dead = (await probe(first.socketPath)) === "dead";
      if (dead && (!lockMustGo || !meant(named()))) return true;
      if (clock.now() >= deadline) return dead;
      await sleep(clock, pollMs);
    }
  };

  /** The signal, only for a proven engine, or an unproven one whose lock and live socket are checked right before. */
  const signalGuarded = async (signal: "SIGTERM" | "SIGKILL"): Promise<"sent" | StopResult> => {
    const lock = named();
    if (lock === undefined) return (await probe(first.socketPath)) === "dead" ? { kind: "stopped", forced: false } : stillRunning();
    // Only the engine the caller meant: a newer engine that took the lock meanwhile is never signalled.
    if (!meant(lock)) return { kind: "replaced" };
    // The pid is trusted only in a folder that is ours and private, and is never this process or a group.
    if (!checkEngineDir(dirname(lock.socketPath)).ok || lock.pid === process.pid || lock.pid <= 1) return stillRunning();
    // Ask the engine behind the socket who it is, over the token-checked connection.
    const proof = await sendShutdown(filesOf(lock), { ifIdle });
    if (proof.kind === "refused") return { kind: "refused", ...(proof.runningItems !== undefined && { runningItems: proof.runningItems }) };
    if (proof.kind !== "none" && proof.engineId !== undefined && proof.pid !== undefined) {
      // Another engine listens where the lock says this one does: not the one to signal.
      if (proof.engineId !== lock.engineId || proof.pid !== lock.pid) return { kind: "replaced" };
    } else {
      // Not proven: the socket must accept right now (a dead socket means the engine is gone).
      const state = await probe(lock.socketPath);
      if (state === "dead") return { kind: "stopped", forced: false };
      if (state === "unknown") return stillRunning();
    }
    // The lock must read the same as when this began, right before the signal.
    if (named()?.text !== lock.text) return { kind: "replaced" };
    const undo = signal === "SIGKILL" ? options.beforeKill?.(lock.pid) : undefined;
    try {
      options.signal(lock.pid, signal);
    } catch {
      undo?.();
      // A signal that cannot be sent (no right to it) leaves the engine running.
      return stillRunning();
    }
    return "sent";
  };

  if (answer.kind === "accepted" && (await waitGone(true))) return { kind: "stopped", forced: false };

  // Signals: only for a caller that may force, and only an engine that is known to be idle, or one
  // the user chose to stop.
  // An engine that knows ifIdle proves it by accepting; an older count is trusted only for one that cannot.
  const knownIdle = answer.kind === "accepted" || (info?.runningItems === 0 && info.apiVersion < SHUTDOWN_IF_IDLE_SINCE);
  if (!options.force || (options.ifIdle && !knownIdle)) return stillRunning();
  for (const [signal, forced] of [["SIGTERM", false], ["SIGKILL", true]] as const) {
    const sent = await signalGuarded(signal);
    if (sent !== "sent") return sent;
    if (await waitGone(!forced)) return { kind: "stopped", forced };
  }
  return stillRunning();
}
