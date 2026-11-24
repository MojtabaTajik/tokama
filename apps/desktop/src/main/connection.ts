// The desktop app's engine connection state. No Electron here, so it is tested with a fake client.
import type { ConnectError, EngineClient } from "@tokama/client";
import type { Result } from "@tokama/core";
import type { BridgeEvent, ConnectionState } from "../shared/bridge.js";

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
}

export interface ConnectionWatch {
  /** The current state. */
  state(): ConnectionState;
  /** The client while connected (or reconnecting), for queries and commands; undefined before and after. */
  client(): EngineClient | undefined;
  /** Connects again after a failure ("failed" becomes "starting"). Does nothing in any other state. */
  retry(): void;
  /** Closes the client. The engine keeps running. */
  close(): Promise<void>;
}

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

  const set = (next: ConnectionState) => {
    state = next;
    options.onState(next);
  };
  const fail = (reason: string) =>
    set({ status: "failed", reason, logPath: options.logPath, logTail: options.readLogTail(options.logPath) });

  const run = async (mine: number) => {
    const result = await options.connect();
    if (closed || mine !== attempt) {
      if (result.ok) await result.value.close();
      return;
    }
    if (!result.ok) return fail(result.error.message);
    client = result.value;
    set({ status: "connected", engineId: client.engineId });
    // events() is called in the same tick as the connect result, so no event is missed.
    for await (const event of client.events()) {
      if (mine !== attempt) break;
      if (event.kind === "disconnected") set({ status: "reconnecting" });
      else if (event.kind === "reconnected") set({ status: "connected", engineId: event.engineId });
      else if (event.kind === "failed") fail(event.error.message);
      else options.onEvent(event);
    }
  };
  const start = () => {
    const mine = ++attempt;
    run(mine).catch((error: unknown) => {
      if (!closed && mine === attempt) fail(`unexpected error: ${String(error)}`);
    });
  };
  start();

  return {
    state: () => state,
    client: () => (state.status === "connected" || state.status === "reconnecting" ? client : undefined),
    retry: () => {
      if (closed || state.status !== "failed") return;
      const previous = client;
      client = undefined;
      void previous?.close().catch(() => undefined);
      set({ status: "starting" });
      start();
    },
    close: async () => {
      closed = true;
      await client?.close();
    },
  };
}
