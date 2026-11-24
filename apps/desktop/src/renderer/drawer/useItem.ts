// One item, kept current for the drawer: the `item` query when the drawer opens, on every return
// to "connected" and on refresh(); `item_updated` events for that item in between. An event that
// arrives while a query is in flight is newer than the query's answer, so the answer is dropped.
import type { ItemRecord } from "@tokama/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TokamaBridge } from "../../shared/bridge.js";

export interface ItemView {
  /** Undefined until the first answer, and after the engine said the item does not exist. */
  readonly item: ItemRecord | undefined;
  /** Why the last query failed, as the engine or the bridge said it. */
  readonly error: { readonly code: string; readonly message: string } | undefined;
  /** Queries the item again. */
  readonly refresh: () => void;
}

export function useItem(bridge: TokamaBridge, itemId: string): ItemView {
  const [item, setItem] = useState<ItemRecord | undefined>(undefined);
  const [error, setError] = useState<ItemView["error"]>(undefined);
  // Moves on with every event for this item, every item change and unmount: a query answer that
  // finds it moved is out of date and is dropped.
  const epoch = useRef(0);

  const refresh = useCallback(() => {
    const seen = epoch.current;
    void bridge
      .query({ type: "item", itemId })
      .catch((cause: unknown) => ({ ok: false as const, error: { code: "bridge_error", message: String(cause) } }))
      .then((reply) => {
        if (epoch.current !== seen) return;
        if (reply.ok) {
          setItem(reply.data.item);
          setError(undefined);
        } else {
          if (reply.error.code === "not_found") setItem(undefined);
          setError(reply.error);
        }
      });
  }, [bridge, itemId]);

  useEffect(() => {
    epoch.current++;
    setItem(undefined);
    setError(undefined);
    // Subscribe first, then query, so a change in between is not lost.
    const stopEvents = bridge.onEvent(({ event }) => {
      if (event.type !== "item_updated" || event.item.id !== itemId) return;
      epoch.current++;
      setItem(event.item);
      setError(undefined);
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

  return { item, error, refresh };
}
