// The board's items for the Repos page's badges and items line: loaded when the page opens and
// after a setup change, and kept current by item updates. A failed load leaves the last items
// (none at first): the badges are extra, the list does not depend on them.
import type { ItemRecord, Setup } from "@tokama/core";
import { useEffect, useState } from "react";
import type { ConnectionState, TokamaBridge } from "../../shared/bridge.js";

/** `setup` is only a signal: a new one means repos changed, so the board is read again. */
export function useRepoItems(bridge: TokamaBridge, connection: ConnectionState, setup: Setup | undefined): readonly ItemRecord[] {
  const [items, setItems] = useState<ReadonlyMap<string, ItemRecord>>(new Map());
  const connected = connection.status === "connected";
  useEffect(() => {
    if (!connected) return;
    let live = true;
    // Items updated while the board loads are newer than what it returns.
    const updated = new Map<string, ItemRecord>();
    let loading = true;
    const stop = bridge.onEvent(({ event }) => {
      if (!live || event.type !== "item_updated") return;
      if (loading) updated.set(event.item.id, event.item);
      setItems((current) => new Map(current).set(event.item.id, event.item));
    });
    bridge
      .query({ type: "board" })
      .then((reply) => {
        if (!live) return;
        loading = false;
        if (!reply.ok) return;
        const next = new Map<string, ItemRecord>(reply.data.items.map((item) => [item.id, item]));
        for (const [id, item] of updated) next.set(id, item);
        setItems(next);
      })
      .catch(() => {
        loading = false;
      });
    return () => {
      live = false;
      stop();
    };
  }, [bridge, connected, setup]);
  return [...items.values()];
}
