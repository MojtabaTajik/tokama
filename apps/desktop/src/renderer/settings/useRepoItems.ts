// The board for the Repos page's badges and items line: its open items and the counts of the
// finished ones. Loaded when the page opens and after a setup change, and loaded again shortly
// after any item update, not only a finish (the board is small, so a burst of events loads it
// once). A failed load leaves the last board (empty at first): the badges are extra, the list does
// not depend on them.
import type { BoardResult, Setup } from "@tokama/core";
import { useEffect, useState } from "react";
import type { ConnectionState, TokamaBridge } from "../../shared/bridge.js";

/** Wait after an item event before the board loads again. */
export const REPO_ITEMS_DELAY_MS = 150;

const EMPTY: BoardResult = { items: [], counts: [] };

/** `setup` is only a signal: a new one means repos changed, so the board is read again. */
export function useRepoItems(bridge: TokamaBridge, connection: ConnectionState, setup: Setup | undefined): BoardResult {
  const [board, setBoard] = useState<BoardResult>(EMPTY);
  const connected = connection.status === "connected";
  useEffect(() => {
    if (!connected) return;
    let live = true;
    // Only the latest load counts: one sent before a newer one may answer after it.
    let sent = 0;
    const load = () => {
      const token = ++sent;
      bridge
        .query({ type: "board" })
        .then((reply) => {
          if (live && token === sent && reply.ok) setBoard(reply.data);
        })
        .catch(() => undefined);
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = bridge.onEvent(({ event }) => {
      if (!live || event.type !== "item_updated" || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        load();
      }, REPO_ITEMS_DELAY_MS);
    });
    load();
    return () => {
      live = false;
      clearTimeout(timer);
      stop();
    };
  }, [bridge, connected, setup]);
  return board;
}
