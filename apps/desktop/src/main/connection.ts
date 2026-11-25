// The desktop app's engine connection state. No Electron here, so it is tested with a fake client.
//
// An engine of an older API version that still runs after an update is replaced: at once when
// it runs nothing, otherwise only after the user picks Restart now, or Wait (the app checks again
// every few seconds and restarts it once nothing runs). A newer engine is never stopped.
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
  readonly replaceOlder?: () => Promise<ReplaceResult>;
  /** The older engine's lock path and pid, shown with the question. */
  readonly olderLock?: () => Pick<OlderEngine, "lockPath" | "pid">;
  /** How often Wait checks again. Default 5 s. */
  readonly waitPollMs?: number;
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
    // Right after a replace, an older engine again is not replaced again without asking.
    if (!replaced && (mode === "now" || engine.runningItems === 0)) return replace(mine, options.replaceOlder);
    const { runningItems } = engine;
    const waiting = mode === "wait" && runningItems !== undefined && !replaced;
    const lock = options.olderLock?.() ?? { lockPath: "" };
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
    client = result.value;
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
    close: async () => {
      closed = true;
      clearTimeout(waitTimer);
      await client?.close();
    },
  };
}
