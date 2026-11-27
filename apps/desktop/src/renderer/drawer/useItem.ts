// One item, kept current for the drawer: the `item` query when the drawer opens, on every return
// to "connected" and on refresh(); `item_updated` events for that item in between. An event that
// arrives while a query is in flight is newer than the query's answer, so the answer is dropped;
// so is an answer for an item the drawer no longer shows.
import type { ItemRecord, ItemUsage } from "@tokama/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TokamaBridge } from "../../shared/bridge.js";
import { hasEnded } from "./describe.js";

export interface ItemView {
  /** Undefined until the first answer, and after the engine said the item does not exist. */
  readonly item: ItemRecord | undefined;
  /** What the item used, as of the last query; absent when the engine has no calls of it. Read again when the item ends. */
  readonly usage: ItemUsage | undefined;
  /** Why the last query failed, as the engine or the bridge said it. */
  readonly error: { readonly code: string; readonly message: string } | undefined;
  /** Queries the item again. */
  readonly refresh: () => void;
}

export function useItem(bridge: TokamaBridge, itemId: string): ItemView {
  const [item, setItem] = useState<ItemRecord | undefined>(undefined);
  const [usage, setUsage] = useState<ItemUsage | undefined>(undefined);
  const [error, setError] = useState<ItemView["error"]>(undefined);
  // Moves on with every event for this item, every item change and unmount: a query answer that
  // finds it moved is out of date and is dropped.
  const epoch = useRef(0);
  // The item shown now. A refresh() kept from an earlier render can still ask for an older item.
  const current = useRef(itemId);
  current.current = itemId;

  const refresh = useCallback(() => {
    const seen = epoch.current;
    void bridge
      .query({ type: "item", itemId })
      .catch((cause: unknown) => ({ ok: false as const, error: { code: "bridge_error", message: String(cause) } }))
      .then((reply) => {
        if (epoch.current !== seen || current.current !== itemId) return;
        if (reply.ok) {
          setItem(reply.data.item);
          setUsage(reply.data.usage);
          setError(undefined);
        } else {
          if (reply.error.code === "not_found") {
            setItem(undefined);
            setUsage(undefined);
          }
          setError(reply.error);
        }
      });
  }, [bridge, itemId]);

  useEffect(() => {
    epoch.current++;
    setItem(undefined);
    setUsage(undefined);
    setError(undefined);
    // Subscribe first, then query, so a change in between is not lost.
    const stopEvents = bridge.onEvent(({ event }) => {
      if (event.type !== "item_updated" || event.item.id !== itemId) return;
      epoch.current++;
      setItem(event.item);
      setError(undefined);
      // An event carries no usage: an item that has ended has its last calls, so ask for it again.
      if (hasEnded(event.item)) refresh();
    });
    const stopConnection = bridge.onConnection((state) => {
      if (state.status === "connected") refresh();
    });
    refresh();
    return () => {
      epoch.current++;
      stopEvents();
      stopConnection();
    };
  }, [bridge, itemId, refresh]);

  return { item, usage, error, refresh };
}
