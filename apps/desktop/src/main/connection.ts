// The desktop app's engine connection state. No Electron here, so it is tested with a fake client.
//
// What happens with an engine that already runs is decided by `engineAction` in `@tokama/client`.
// An older engine that runs nothing is replaced at once. An older engine of the same API version
// that runs items is used as it is, and replaced at the watch's next connect when it is idle. An
// older engine of another API version that runs items stays until the user picks Restart engine
// now (the running steps stop and wait at Retry step / Stop) or Try again. A newer engine of
// another API version is never stopped.
import { type ConnectError, type EngineClient, type EngineInfo, engineAction, type StopResult } from "@tokama/client";
import type { Result } from "@tokama/core";
import type { BridgeEvent, ConnectionState, OlderEngine } from "../shared/bridge.js";

/** What the watch asks of its stopper: stop the older engine, which the handshake described as `engine`. */
export interface StopRequest {
  /** The engine that was compared, so a lock naming another engine by now is left alone. */
  readonly engineId: string | undefined;
  readonly engine: EngineInfo;
  /** True for a replace nobody asked for (only an idle engine may be stopped); false when the user chose to restart a busy one. */
  readonly ifIdle: boolean;
}

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
  /** Stops the older engine of this app. Without it, nothing is replaced. */
  readonly stopEngine?: (request: StopRequest) => Promise<StopResult>;
  /** The older engine's lock path and pid, shown with the question. */
  readonly olderLock?: () => Pick<OlderEngine, "lockPath" | "pid"> & { readonly engineId?: string };
  /**
   * This app's build version; only a packaged app gives it. An engine of the same API version
   * whose build is lower is replaced like an engine of an older API version.
   */
  readonly appVersion?: string;
}

export interface ConnectionWatch {
  /** The current state. */
  state(): ConnectionState;
  /** The client while connected (or reconnecting), for queries and commands; undefined before and after. */
  client(): EngineClient | undefined;
  /** Connects again after a failure ("failed" becomes "starting"). Does nothing in any other state. */
  retry(): void;
  /** With an older engine on screen: stop it now, whatever it runs, and start this version's. Does nothing in any other state. */
  restartEngine(): void;
  /**
   * Lets go of the engine without ever connecting again until `resume`: the client is closed (a
   * client left open would reconnect, and start an engine) and the state is "starting". Returns the
   * id and handshake of the engine it was connected to, if any. Used while that engine is stopped for an update.
   */
  suspend(): Promise<{ readonly engineId?: string; readonly engine?: EngineInfo }>;
  /** Connects again, and starts an engine if none runs. Does nothing unless suspended. */
  resume(): void;
  /** Closes the client. The engine keeps running. */
  close(): Promise<void>;
}

/** How an attempt treats an older engine of another API version that runs items: ask, or restart it now. */
type Mode = "ask" | "now";

const OLDER = "An older Tokama engine is still running. Restart it?";
const NEWER =
  "A newer Tokama engine is running, and this app is older. Tokama never stops a newer engine. Update the app, or quit that engine yourself, then press Try again.";

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
  // The attempt the user started with Try again: only that one says when it checked.
  let checkedAttempt: number | undefined;

  const set = (next: ConnectionState) => {
    state = next;
    options.onState(next);
  };
  const fail = (reason: string, older?: OlderEngine) =>
    set({ status: "failed", reason, logPath: options.logPath, logTail: options.readLogTail(options.logPath), ...(older !== undefined && { older }) });
  const action = (engine: EngineInfo) => engineAction(engine, { apiVersion: options.apiVersion, ...(options.appVersion !== undefined && { appVersion: options.appVersion }) });

  /** A refused connection: an engine of another API version is replaced, asked about or left alone; anything else is a failure. */
  const refused = async (error: ConnectError, mine: number, mode: Mode, replaced: boolean): Promise<void> => {
    const engine = error.engine;
    const { stopEngine } = options;
    if (error.code !== "unsupported_version" || engine === undefined || stopEngine === undefined || engine.apiVersion === options.apiVersion) return fail(error.message);
    if (action(engine) === "newer") return fail(NEWER);
    return older(stopEngine, engine, undefined, mine, mode, replaced);
  };

  /** An older engine runs: replace it when idle (or on request), otherwise ask. */
  const older = async (stopEngine: NonNullable<WatchOptions["stopEngine"]>, engine: EngineInfo, probedEngineId: string | undefined, mine: number, mode: Mode, replaced: boolean): Promise<void> => {
    // The lock as it is right after the refusal: only the engine it names may be stopped.
    const { engineId: lockedEngineId, ...lock } = options.olderLock?.() ?? { lockPath: "" };
    // An engine that was connected to is the one that was compared, so it is the one to stop,
    // even if the lock names another by now.
    const engineId = probedEngineId ?? lockedEngineId;
    // Right after a replace, an older engine again is not replaced again without asking.
    if (!replaced && (mode === "now" || engine.runningItems === 0)) return replace(stopEngine, mine, { engineId, engine, ifIdle: mode !== "now" });
    fail(OLDER, {
      ...lock,
      ...(engine.runningItems !== undefined && { runningItems: engine.runningItems }),
      ...(checkedAttempt === mine && { checkedAt: Date.now() }),
    });
  };

  const replace = async (stopEngine: NonNullable<WatchOptions["stopEngine"]>, mine: number, request: StopRequest): Promise<void> => {
    set({ status: "starting", updating: true });
    const outcome = await stopEngine(request);
    if (closed || mine !== attempt) return;
    switch (outcome.kind) {
      // Connect again: the new engine starts, or the older one that is busy again is used or asked about.
      case "stopped":
        return run(mine, "ask", true, outcome.forced);
      case "replaced":
      case "refused":
        return run(mine, "ask", true);
      case "still_running":
        return fail(`The older Tokama engine${outcome.pid === undefined ? "" : ` (pid ${outcome.pid})`} did not stop. Press Try again.`);
    }
  };

  const run = async (mine: number, mode: Mode, replaced = false, forced = false): Promise<void> => {
    const result = await options.connect();
    if (closed || mine !== attempt) {
      if (result.ok) await result.value.close();
      return;
    }
    if (!result.ok) return refused(result.error, mine, mode, replaced);
    const connected = result.value;
    const { stopEngine } = options;
    // After a replace attempt the engine is used as it is: the engine refused (an item is queued, or a
    // command is in flight, which its handshake count leaves out), or it answered again; either way
    // it speaks this API, so there is nothing to ask.
    if (stopEngine !== undefined && !replaced && action(connected.engine) === "replace") {
      // Closed first: a client left open would reconnect, and start an engine, while the old one stops.
      await connected.close();
      if (closed || mine !== attempt) return;
      return older(stopEngine, connected.engine, connected.engineId, mine, mode, replaced);
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
      // The attempt this starts: the screen then says when it was checked.
      checkedAttempt = attempt + 1;
      again("ask");
    },
    restartEngine: () => {
      if (closed || state.status !== "failed" || state.older === undefined) return;
      again("now");
    },
    suspend: async () => {
      if (closed) return {};
      suspended = true;
      const previous = client;
      const engineId = previous?.engineId;
      const engine = previous?.engine;
      client = undefined;
      // A new attempt number: the follower of the closed client stops hearing events.
      attempt += 1;
      set({ status: "starting", updating: true });
      await previous?.close().catch(() => undefined);
      return engineId === undefined || engine === undefined ? {} : { engineId, engine };
    },
    resume: () => {
      if (closed || !suspended) return;
      suspended = false;
      set({ status: "starting" });
      start("ask");
    },
    close: async () => {
      closed = true;
      await client?.close();
    },
  };
}
