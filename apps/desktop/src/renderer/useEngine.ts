// The renderer's engine state: the connection, the setup, the open items and the counts of the
// finished ones. The setup and the board load in parallel on every return to "connected" (events
// may have been missed while away) and on a `setup_changed` event, and `item_updated` events keep
// the open items current in between. An item that finishes leaves the items, and the board alone
// loads again shortly after for its counts; the finished rows come from item_list pages.
// The setup alone loads again when the window gets focus or on refreshSetup(), so the engine's
// health checks (a CLI logged in meanwhile) show without a restart. A failed load is retried once after a short delay;
// after that the last data stays, marked stale, until a retry succeeds. A failed connection
// drops the data.
import type { BoardCount, BoardResult, ItemRecord, Setup } from "@tokama/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionState, TokamaBridge } from "../shared/bridge.js";
import { isOpen } from "./model.js";

export interface EngineData {
  readonly setup: Setup;
  /** The open items by id, in board order, with items started later at the end. */
  readonly items: ReadonlyMap<string, ItemRecord>;
  /** The done and failed items, counted by start day, workflow and repos. */
  readonly counts: readonly BoardCount[];
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
  /** Loads the setup again, e.g. for fresh health checks; a failure keeps the setup there is. */
  readonly refreshSetup: () => void;
}

/** Delay before the one automatic retry of a failed load. */
export const RETRY_DELAY_MS = 2_000;
/** Wait after an item finishes before the board loads again, so a burst of events loads once. */
export const COUNTS_DELAY_MS = 150;

type Loaded = { readonly ok: true; readonly setup: Setup; readonly board: BoardResult } | { readonly ok: false; readonly error: string };

/** The setup, then the board. */
async function load(bridge: TokamaBridge): Promise<Loaded> {
  const [setup, board] = await Promise.all([bridge.query({ type: "setup" }), bridge.query({ type: "board" })]);
  if (!setup.ok) return { ok: false, error: setup.error.message };
  if (!board.ok) return { ok: false, error: board.error.message };
  return { ok: true, setup: setup.data, board: board.data };
}

/** The open items with the given updates, which are newer: an item that finished leaves. */
function openItems(items: Iterable<ItemRecord>, updates: Iterable<ItemRecord>): Map<string, ItemRecord> {
  const open = new Map<string, ItemRecord>();
  for (const item of items) open.set(item.id, item);
  for (const item of updates) {
    if (isOpen(item)) open.set(item.id, item);
    else open.delete(item.id);
  }
  return open;
}

export function useEngine(bridge: TokamaBridge, retryDelayMs = RETRY_DELAY_MS): EngineView {
  const [connection, setConnection] = useState<ConnectionState>({ status: "starting" });
  const [data, setData] = useState<EngineData | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  // Bumped by retry(), which re-runs the load effect.
  const [reloads, setReloads] = useState(0);
  // Bumped when an item finishes, which loads the board again.
  const [countReloads, setCountReloads] = useState(0);
  // Items updated by events while a load is in flight, one map per load: newer than what it returns.
  const updatedDuringLoad = useRef(new Set<Map<string, ItemRecord>>());

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
      if (!live) return;
      // Repos (or other setup) changed: load the setup and the board again.
      if (event.type === "setup_changed") return setReloads((count) => count + 1);
      if (event.type !== "item_updated") return;
      const item = event.item;
      for (const updated of updatedDuringLoad.current) updated.set(item.id, item);
      setData((current) => {
        // A finished item the board does not hold changes nothing here.
        if (current === undefined || (!isOpen(item) && !current.items.has(item.id))) return current;
        return { ...current, items: openItems(current.items.values(), [item]) };
      });
      if (!isOpen(item)) setCountReloads((count) => count + 1);
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
    let updated: Map<string, ItemRecord> | undefined;
    const run = (attempt: number) => {
      updated = new Map<string, ItemRecord>();
      const during = updated;
      updatedDuringLoad.current.add(during);
      void load(bridge)
        .catch((error: unknown): Loaded => ({ ok: false, error: String(error) }))
        .then((result) => {
          updatedDuringLoad.current.delete(during);
          if (!live) return;
          if (!result.ok) {
            setLoadError(result.error);
            if (attempt === 0) timer = setTimeout(() => run(1), retryDelayMs);
            return;
          }
          setLoadError(undefined);
          setData({ setup: result.setup, items: openItems(result.board.items, during.values()), counts: result.board.counts });
        });
    };
    run(0);
    return () => {
      live = false;
      clearTimeout(timer);
      if (updated !== undefined) updatedDuringLoad.current.delete(updated);
    };
  }, [bridge, connection, reloads, retryDelayMs]);

  // An item finished: the board alone loads again for its counts. A failure keeps the counts there are. A new
  // finish while the timer waits starts the wait again; one while the query runs makes this reply stale, and the newer one wins.
  useEffect(() => {
    if (countReloads === 0 || connection.status !== "connected") return;
    let live = true;
    const during = new Map<string, ItemRecord>();
    const timer = setTimeout(() => {
      updatedDuringLoad.current.add(during);
      void bridge
        .query({ type: "board" })
        .catch(() => undefined)
        .then((reply) => {
          updatedDuringLoad.current.delete(during);
          if (!live || reply === undefined || !reply.ok) return;
          setData((current) => (current === undefined ? current : { ...current, items: openItems(reply.data.items, during.values()), counts: reply.data.counts }));
        });
    }, COUNTS_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
      updatedDuringLoad.current.delete(during);
    };
  }, [bridge, connection, countReloads]);

  const connected = connection.status === "connected";
  const refreshSetup = useCallback(() => {
    if (!connected) return;
    void bridge
      .query({ type: "setup" })
      .then((reply) => {
        if (reply.ok) setData((current) => (current === undefined ? current : { ...current, setup: reply.data }));
      })
      .catch(() => undefined);
  }, [bridge, connected]);
  useEffect(() => {
    window.addEventListener("focus", refreshSetup);
    return () => window.removeEventListener("focus", refreshSetup);
  }, [refreshSetup]);

  const failed = connection.status === "failed";
  return {
    connection,
    data: failed ? undefined : data,
    loadError: failed ? undefined : loadError,
    stale: !failed && data !== undefined && loadError !== undefined,
    retry: () => setReloads((count) => count + 1),
    refreshSetup,
  };
}
