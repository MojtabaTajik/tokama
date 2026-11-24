// The renderer's engine state: the connection, the setup and the items. The setup and
// the board load in parallel on every return to "connected" (events may have been missed while
// away), and `item_updated` events keep the items current in between. A failed load is retried once after a short delay;
// after that the last data stays, marked stale, until a retry succeeds. A failed connection
// drops the data.
import type { ItemRecord, Setup } from "@tokama/core";
import { useEffect, useRef, useState } from "react";
import type { ConnectionState, TokamaBridge } from "../shared/bridge.js";

export interface EngineData {
  readonly setup: Setup;
  /** Every item by id, in board order, with items started later at the end. */
  readonly items: ReadonlyMap<string, ItemRecord>;
}

export interface EngineView {
  readonly connection: ConnectionState;
  /** Undefined until the first load after connecting, and after the connection failed. */
  readonly data: EngineData | undefined;
  /** Why the last load failed, as the engine or the bridge said it. */
  readonly loadError: string | undefined;
  /** The data is from an earlier load: the last one failed. */
  readonly stale: boolean;
  /** Loads again now. */
  readonly retry: () => void;
}

/** Delay before the one automatic retry of a failed load. */
export const RETRY_DELAY_MS = 2_000;

type Loaded = { readonly ok: true; readonly data: EngineData } | { readonly ok: false; readonly error: string };

/** The setup, then the board. */
async function load(bridge: TokamaBridge): Promise<Loaded> {
  const [setup, board] = await Promise.all([bridge.query({ type: "setup" }), bridge.query({ type: "board" })]);
  if (!setup.ok) return { ok: false, error: setup.error.message };
  if (!board.ok) return { ok: false, error: board.error.message };
  return { ok: true, data: { setup: setup.data, items: new Map(board.data.items.map((item) => [item.id, item])) } };
}

export function useEngine(bridge: TokamaBridge, retryDelayMs = RETRY_DELAY_MS): EngineView {
  const [connection, setConnection] = useState<ConnectionState>({ status: "starting" });
  const [data, setData] = useState<EngineData | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  // Bumped by retry(), which re-runs the load effect.
  const [reloads, setReloads] = useState(0);
  // Items updated by events while a load is in flight: newer than what the load returns.
  const updatedDuringLoad = useRef<Map<string, ItemRecord> | undefined>(undefined);

  useEffect(() => {
    let live = true;
    // Subscribe first, then read the current state, so a change in between is not lost.
    const stop = bridge.onConnection((next) => {
      if (live) setConnection(next);
    });
    void bridge.getConnection().then((current) => {
      if (live) setConnection(current);
    });
    return () => {
      live = false;
      stop();
    };
  }, [bridge]);

  // Declared before the load below, so events are heard before the first query is sent.
  useEffect(() => {
    let live = true;
    const stop = bridge.onEvent(({ event }) => {
      if (!live || event.type !== "item_updated") return;
      const item = event.item;
      updatedDuringLoad.current?.set(item.id, item);
      setData((current) => (current === undefined ? current : { ...current, items: new Map(current.items).set(item.id, item) }));
    });
    return () => {
      live = false;
      stop();
    };
  }, [bridge]);

  useEffect(() => {
    if (connection.status !== "connected") return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = (attempt: number) => {
      const updated = new Map<string, ItemRecord>();
      updatedDuringLoad.current = updated;
      void load(bridge)
        .catch((error: unknown): Loaded => ({ ok: false, error: String(error) }))
        .then((result) => {
          if (!live) return;
          updatedDuringLoad.current = undefined;
          if (!result.ok) {
            setLoadError(result.error);
            if (attempt === 0) timer = setTimeout(() => run(1), retryDelayMs);
            return;
          }
          const items = new Map(result.data.items);
          for (const [id, item] of updated) items.set(id, item);
          setLoadError(undefined);
          setData({ setup: result.data.setup, items });
        });
    };
    run(0);
    return () => {
      live = false;
      clearTimeout(timer);
      updatedDuringLoad.current = undefined;
    };
  }, [bridge, connection, reloads, retryDelayMs]);

  const failed = connection.status === "failed";
  return {
    connection,
    data: failed ? undefined : data,
    loadError: failed ? undefined : loadError,
    stale: !failed && data !== undefined && loadError !== undefined,
    retry: () => setReloads((count) => count + 1),
  };
}
