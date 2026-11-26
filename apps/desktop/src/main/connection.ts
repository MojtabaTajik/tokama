// The desktop app's engine connection state. No Electron here, so it is tested with a fake client.
//
// An engine of an older API version that still runs after an update is replaced, and so is one of
// the same API version but a lower build when this app is packaged: at once when it runs nothing,
// otherwise only after the user picks Restart now, or Wait (the app checks again every few seconds
// and restarts it once nothing runs). A newer engine (API or build) is never stopped.
import type { ConnectError, EngineClient } from "@tokama/client";
import type { Result } from "@tokama/core";
import type { BridgeEvent, ConnectionState, OlderEngine } from "../shared/bridge.js";
import type { ReplaceResult } from "./replace.js";

export interface WatchOptions {
  /** Connects to the engine (and starts it when needed), e.g. `() => connect({ dir, start })`. */
  readonly connect: () => Promise<Result<EngineClient, ConnectError>>;
  /** The engine's log file, shown with a failure. */
  readonly logPath: string;
  /** The last lines of the log; must not throw. */
  readonly readLogTail: (path: string) => string[];
  /** Called on every change after the initial "starting". */
  readonly onState: (state: ConnectionState) => void;
  /** Called with every engine event (item and usage updates). */
  readonly onEvent: (event: BridgeEvent) => void;
  /** This app's API version: an engine below it is older, one above it newer. */
  readonly apiVersion: number;
  /** Stops the older engine, after checking that it is this app's own. Without it, nothing is replaced. */
  readonly replaceOlder?: (expectedEngineId: string | undefined) => Promise<ReplaceResult>;
  /** The older engine's lock path and pid, shown with the question. */
  readonly olderLock?: () => Pick<OlderEngine, "lockPath" | "pid"> & { readonly engineId?: string };
  /** How often Wait checks again. Default 5 s. */
  readonly waitPollMs?: number;
  /**
   * This app's build version; only a packaged app gives it. An engine of the same API version
   * whose build is lower is replaced like an engine of an older API version.
   */
  readonly appVersion?: string;
}

/** The numbers of a plain `x.y.z` release; undefined for anything else, and for `0.0.0` (a dev build). */
function release(version: string | undefined): readonly [number, number, number] | undefined {
  const match = version === undefined ? null : /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) return undefined;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return parts.every((part) => part === 0) ? undefined : parts;
}

/** True when both are plain `x.y.z` releases (not `0.0.0`) and the engine's is lower. */
export function olderBuild(engineVersion: string | undefined, appVersion: string | undefined): boolean {
  const engine = release(engineVersion);
  const app = release(appVersion);
  if (engine === undefined || app === undefined) return false;
  for (const [index, part] of engine.entries()) {
    const other = app[index] ?? 0;
    if (part !== other) return part < other;
  }
  return false;
}

export interface ConnectionWatch {
  /** The current state. */
  state(): ConnectionState;
  /** The client while connected (or reconnecting), for queries and commands; undefined before and after. */
  client(): EngineClient | undefined;
  /** Connects again after a failure ("failed" becomes "starting"). Does nothing in any other state. */
  retry(): void;
  /** With an older engine on screen: replace it now. Does nothing in any other state. */
  restartEngine(): void;
  /** With an older engine that reports running items: replace it once none runs. Does nothing in any other state. */
  waitForEngine(): void;
  /**
   * Lets go of the engine without ever connecting again until `resume`: the client is closed (a
   * client left open would reconnect, and start an engine) and the state is "starting". Returns the
   * id of the engine it was connected to, if any. Used while that engine is stopped for an update.
   */
  suspend(): Promise<{ readonly engineId?: string }>;
  /** Connects again, and starts an engine if none runs. Does nothing unless suspended. */
  resume(): void;
  /** Closes the client. The engine keeps running. */
  close(): Promise<void>;
}

/** How an attempt treats an older engine: ask (or replace when idle), replace now, or wait until idle. */
type Mode = "ask" | "now" | "wait";

const OLDER = "An older Tokama engine is still running. Restart it?";
const NEWER =
  "A newer Tokama engine is running, and this app is older. Tokama never stops a newer engine. Update the app, or quit that engine yourself, then press Retry.";

/**
 * Connects, then follows the client's events: a lost connection is "reconnecting" until the
 * client is back ("connected") or gives up ("failed", which is final).
 */
export function watchConnection(options: WatchOptions): ConnectionWatch {
  let state: ConnectionState = { status: "starting" };
  let client: EngineClient | undefined;
  let closed = false;
  let suspended = false;
  // Each attempt has its own number; a follower of an earlier attempt's client stops hearing events.
  let attempt = 0;
  let waitTimer: ReturnType<typeof setTimeout> | undefined;

  const set = (next: ConnectionState) => {
    state = next;
    options.onState(next);
  };
  const fail = (reason: string, older?: OlderEngine) =>
    set({ status: "failed", reason, logPath: options.logPath, logTail: options.readLogTail(options.logPath), ...(older !== undefined && { older }) });

  /** Checks again after the Wait interval, while the user still waits. */
  const waitAgain = (mine: number) => {
    clearTimeout(waitTimer);
    waitTimer = setTimeout(() => {
      if (!closed && mine === attempt && state.status === "failed" && state.older?.waiting === true) start("wait");
    }, options.waitPollMs ?? 5_000);
  };

  /** A refused connection: an older engine is replaced or asked about, anything else is a failure. */
  const refused = async (error: ConnectError, mine: number, mode: Mode, replaced: boolean): Promise<void> => {
    const engine = error.engine;
    if (error.code !== "unsupported_version" || engine === undefined || options.replaceOlder === undefined) return fail(error.message);
    if (engine.apiVersion > options.apiVersion) return fail(NEWER);
    if (engine.apiVersion === options.apiVersion) return fail(error.message);
    return older(engine.runningItems, mine, mode, replaced, error.message);
  };

  /** An older engine runs: replace it when idle (or on request), otherwise ask. `reason` is the failure text if no replacer is set. */
  const older = async (runningItems: number | undefined, mine: number, mode: Mode, replaced: boolean, reason: string, probedEngineId?: string): Promise<void> => {
    // Right after a replace, an older engine again is not replaced again without asking.
    // The lock as it is right after the refusal: only the engine it names may be stopped.
    const { engineId: lockedEngineId, ...lock } = options.olderLock?.() ?? { lockPath: "" };
    // An engine that was connected to is the one that was compared, so it is the one to stop,
    // even if the lock names another by now.
    const engineId = probedEngineId ?? lockedEngineId;
    if (!replaced && (mode === "now" || runningItems === 0)) return replace(mine, () => options.replaceOlder?.(engineId) ??Promise.resolve({ ok: false, reason }));
    const waiting = mode === "wait" && runningItems !== undefined && !replaced;
    fail(OLDER, {
      ...lock,
      waiting,
      ...(runningItems !== undefined && { runningItems }),
    });
    if (waiting) waitAgain(mine);
  };

  const replace = async (mine: number, replaceOlder: () => Promise<ReplaceResult>): Promise<void> => {
    set({ status: "starting", updating: true });
    const outcome = await replaceOlder();
    if (closed || mine !== attempt) return;
    if (!outcome.ok) return fail(outcome.reason);
    return run(mine, "ask", true, outcome.forced);
  };

  const run = async (mine: number, mode: Mode, replaced = false, forced = false): Promise<void> => {
    const result = await options.connect();
    if (closed || mine !== attempt) {
      if (result.ok) await result.value.close();
      return;
    }
    if (!result.ok) return refused(result.error, mine, mode, replaced);
    const connected = result.value;
    if (options.replaceOlder !== undefined && olderBuild(connected.engine.engineVersion, options.appVersion)) {
      // Closed first: a client left open would reconnect, and start an engine, while the old one stops.
      await connected.close();
      if (closed || mine !== attempt) return;
      return older(connected.engine.runningItems, mine, mode, replaced, OLDER, connected.engineId);
    }
    client = connected;
    // events() is called in the same tick as the connect result, so no event is missed.
    const events = client.events();
    // A killed engine left its crash marker; that stop was this app's, not a crash.
    if (forced) await client.command({ type: "diagnostics_settings", crashSeen: true }).catch(() => undefined);
    if (closed || mine !== attempt) return;
    set({ status: "connected", engineId: client.engineId });
    for await (const event of events) {
      if (mine !== attempt) break;
      if (event.kind === "disconnected") set({ status: "reconnecting" });
      else if (event.kind === "reconnected") set({ status: "connected", engineId: event.engineId });
      else if (event.kind === "failed") fail(event.error.message);
      else options.onEvent(event);
    }
  };
  const start = (mode: Mode = "ask") => {
    clearTimeout(waitTimer);
    const mine = ++attempt;
    run(mine, mode).catch((error: unknown) => {
      if (!closed && mine === attempt) fail(`unexpected error: ${String(error)}`);
    });
  };
  const again = (mode: Mode) => {
    const previous = client;
    client = undefined;
    void previous?.close().catch(() => undefined);
    set({ status: "starting" });
    start(mode);
  };
  start();

  return {
    state: () => state,
    client: () => (state.status === "connected" || state.status === "reconnecting" ? client : undefined),
    retry: () => {
      if (closed || state.status !== "failed") return;
      again("ask");
    },
    restartEngine: () => {
      if (closed || state.status !== "failed" || state.older === undefined) return;
      again("now");
    },
    waitForEngine: () => {
      if (closed || state.status !== "failed" || state.older?.runningItems === undefined || state.older.waiting) return;
      set({ ...state, older: { ...state.older, waiting: true } });
      waitAgain(attempt);
    },
    suspend: async () => {
      if (closed) return {};
      suspended = true;
      const previous = client;
      const engineId = previous?.engineId;
      client = undefined;
      // A new attempt number: the follower of the closed client stops hearing events.
      attempt += 1;
      clearTimeout(waitTimer);
      set({ status: "starting", updating: true });
      await previous?.close().catch(() => undefined);
      return engineId === undefined ? {} : { engineId };
    },
    resume: () => {
      if (closed || !suspended) return;
      suspended = false;
      set({ status: "starting" });
      start("ask");
    },
    close: async () => {
      closed = true;
      clearTimeout(waitTimer);
      await client?.close();
    },
  };
}
