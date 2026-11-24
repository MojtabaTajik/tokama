// The renderer's engine state: the connection, the workspaces and their items. Queries run on
// every return to "connected" (events may have been missed while away), and `item_updated`
// events keep the items current in between.
import type { ItemRecord, WorkspaceSummary } from "@tokama/core";
import { useEffect, useRef, useState } from "react";
import type { ConnectionState, TokamaBridge } from "../shared/bridge.js";

export interface EngineData {
  readonly workspaces: readonly WorkspaceSummary[];
  /** Every workspace's items by id, in board order, with items started later at the end. */
  readonly items: ReadonlyMap<string, ItemRecord>;
}

export interface EngineView {
  readonly connection: ConnectionState;
  /** Undefined until the first load after connecting. */
  readonly data: EngineData | undefined;
  /** Why the last load failed, as the engine or the bridge said it. */
  readonly loadError: string | undefined;
}

type Loaded = { readonly ok: true; readonly data: EngineData } | { readonly ok: false; readonly error: string };

/** The workspaces, then each workspace's board. There is no all-items query. */
async function load(bridge: TokamaBridge): Promise<Loaded> {
  const reply = await bridge.query({ type: "workspaces" });
  if (!reply.ok) return { ok: false, error: reply.error.message };
  const workspaces = reply.data.workspaces;
  const boards = await Promise.all(workspaces.map((workspace) => bridge.query({ type: "board", workspaceId: workspace.id })));
  const items = new Map<string, ItemRecord>();
  for (const board of boards) {
    if (!board.ok) return { ok: false, error: board.error.message };
    for (const item of board.data.items) items.set(item.id, item);
  }
  return { ok: true, data: { workspaces, items } };
}

export function useEngine(bridge: TokamaBridge): EngineView {
  const [connection, setConnection] = useState<ConnectionState>({ status: "starting" });
  const [data, setData] = useState<EngineData | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
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
    const updated = new Map<string, ItemRecord>();
    updatedDuringLoad.current = updated;
    void load(bridge)
      .catch((error: unknown): Loaded => ({ ok: false, error: String(error) }))
      .then((result) => {
        if (!live) return;
        updatedDuringLoad.current = undefined;
        if (!result.ok) return setLoadError(result.error);
        const items = new Map(result.data.items);
        for (const [id, item] of updated) items.set(id, item);
        setLoadError(undefined);
        setData({ workspaces: result.data.workspaces, items });
      });
    return () => {
      live = false;
      if (updatedDuringLoad.current === updated) updatedDuringLoad.current = undefined;
    };
  }, [bridge, connection]);

  return { connection, data, loadError };
}
