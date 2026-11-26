// Installs a ready update, only while nothing runs. Tokama never installs by itself: this runs
// on a click on Restart now, or when the user quits and nothing runs. No Electron here.
//
// The order, each step only after the one before it succeeded: the update is ready; the engine
// itself says that nothing runs; the state is "installing"; the connection watch lets go of the
// engine (a watch left open would start a new engine from the old app while the old one stops);
// the app's own engine is stopped; the installer takes over, checks that the new app is signed by
// the same team, swaps it and (on a click) starts it. A failure to stop the engine puts it back
// from the old app, shows the error and keeps the old version. After the hand-over nothing is put
// back and the installer is never asked again (see handOver).
import type { InstallResult, UpdateState } from "../../shared/update.js";
import type { UpdateEvent } from "./state.js";

export interface InstallDeps {
  state(): UpdateState;
  dispatch(event: UpdateEvent): void;
  /** Items the engine runs now: 0 when there is no engine, undefined when that could not be told. */
  runningNow(): Promise<number | undefined>;
  /** Closes the engine connection for good until `resumeWatch`; gives the id of the engine it was connected to. */
  suspendWatch(): Promise<{ readonly engineId?: string }>;
  resumeWatch(): void;
  /** Stops the app's own engine; `engineId` is the one the connection had, so another engine's lock is left alone. */
  stopEngine(engineId: string | undefined): Promise<{ readonly ok: boolean }>;
  /** Hands over to the installer, which quits the app. Called at most once per app run. */
  quitAndInstall(relaunch: boolean): void;
  /** Quits the app. */
  quitApp(): void;
  /** The installer's failures, for as long as the returned function is not called. */
  watchInstallError(listener: () => void): () => void;
  /** Raises the install warning for diagnostics. */
  reportFailure(): void;
  now(): number;
  /** Calls `fn` after `ms`; returns a function that cancels it. */
  after(ms: number, fn: () => void): () => void;
  /** How long the installer may take before the install counts as failed. Default 3 minutes: it checks a large signature. */
  readonly installerMs?: number;
}

export interface InstallOptions {
  /** Start the new version after the swap. False when the user is quitting. */
  readonly relaunch: boolean;
  /** Called once if the installer refuses after the hand-over; nothing is put back, the engine stays stopped. */
  readonly onFailed?: () => void;
  /** Called once if the installer has not answered in time and nothing was put back: the engine stays stopped. */
  readonly onSilent?: () => void;
}

export const INSTALLER_MS = 3 * 60_000;

export function createInstaller(deps: InstallDeps): (options: InstallOptions) => Promise<InstallResult> {
  let running = false;
  return async (options) => {
    if (running) return { ok: false, reason: "not_ready" };
    // The installer already has the update and the engine is stopped: Restart Tokama only quits
    // the app, and the installer finishes on that quit. It is never asked a second time.
    if (deps.state().status === "stalled") {
      deps.quitApp();
      return { ok: true };
    }
    if (deps.state().status !== "ready") return { ok: false, reason: "not_ready" };
    running = true;
    try {
      const count = await deps.runningNow();
      // Fail closed: when the count cannot be told, the update waits.
      if (count === undefined || count > 0) return { ok: false, reason: "busy", ...(count !== undefined && { running: count }) };
      // The state may have changed while the engine was asked.
      if (deps.state().status !== "ready") return { ok: false, reason: "not_ready" };
      deps.dispatch({ type: "install_started" });
      const { engineId } = await deps.suspendWatch();
      // Counted again with the watch let go: an item started since the first count must not be stopped.
      const again = await deps.runningNow();
      if (again === undefined || again > 0) {
        deps.resumeWatch();
        deps.dispatch({ type: "install_aborted" });
        return { ok: false, reason: "busy", ...(again !== undefined && { running: again }) };
      }
      const stopped = await deps.stopEngine(engineId).catch(() => ({ ok: false }));
      if (!stopped.ok) return recover(deps, "failed");
      return handOver(deps, options);
    } finally {
      running = false;
    }
  };
}

/** The engine could not be stopped, so nothing was handed over: the old engine is back, the error shows, and the old version stays. */
function recover(deps: InstallDeps, reason: "failed"): InstallResult {
  deps.resumeWatch();
  deps.dispatch({ type: "install_failed", at: deps.now() });
  deps.reportFailure();
  return { ok: false, reason };
}

/**
 * Hands the update to the installer, once. From here on the installer may swap the app at any
 * moment, whatever the answer, so the engine is never started again by this process and the
 * installer is never asked a second time (a second ask would arm a second swap): a refusal or
 * silence only leaves the "stalled" state, whose Restart Tokama quits the app, and the installer
 * finishes on that quit (or the next start is a clean old version with a new engine).
 */
function handOver(deps: InstallDeps, options: InstallOptions): InstallResult {
  let over = false;
  let stopWatching: () => void = () => undefined;
  let cancelTimer: () => void = () => undefined;
  const stall = () => {
    over = true;
    stopWatching();
    cancelTimer();
    deps.dispatch({ type: "install_stalled" });
    deps.reportFailure();
  };
  // The installer's own failure: the caller hears of it, once.
  const refused = () => {
    if (over) return;
    stall();
    options.onFailed?.();
  };
  stopWatching = deps.watchInstallError(refused);
  // Silence is not a refusal: the installer may still be checking a large signature. The state
  // becomes "stalled" and the quit path stops waiting; a refusal that comes later is still reported.
  cancelTimer = deps.after(deps.installerMs ?? INSTALLER_MS, () => {
    if (over) return;
    deps.dispatch({ type: "install_stalled" });
    options.onSilent?.();
  });
  try {
    deps.quitAndInstall(options.relaunch);
  } catch {
    stall();
    return { ok: false, reason: "failed" };
  }
  return { ok: true };
}
