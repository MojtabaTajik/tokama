// The live activity of one item, for the drawer's activity line: the `activity` query when the
// item starts to run and on every return to "connected" (events are not replayed, and a long
// command sends none), then `item_activity` events for that item. An event that arrives while a
// query is in flight is newer than its answer, so the answer is dropped.
import type { ItemActivity } from "@tokama/core";
import { useEffect, useRef, useState } from "react";
import type { TokamaBridge } from "../../shared/bridge.js";

export function useActivity(bridge: TokamaBridge, itemId: string, running: boolean): ItemActivity | null {
  const [activity, setActivity] = useState<ItemActivity | null>(null);
  const epoch = useRef(0);

  useEffect(() => {
    epoch.current++;
    setActivity(null);
    if (!running) return;
    const ask = () => {
      const seen = epoch.current;
      void bridge
        .query({ type: "activity", itemId })
        .catch(() => undefined)
        .then((reply) => {
          if (reply?.ok === true && epoch.current === seen) setActivity(reply.data.activity);
        });
    };
    const stopEvents = bridge.onEvent(({ event }) => {
      if (event.type !== "item_activity" || event.activity.itemId !== itemId) return;
      epoch.current++;
      setActivity(event.activity);
    });
    const stopConnection = bridge.onConnection((state) => {
      if (state.status === "connected") ask();
    });
    ask();
    return () => {
      epoch.current++;
      stopEvents();
      stopConnection();
    };
  }, [bridge, itemId, running]);

  return activity;
}
