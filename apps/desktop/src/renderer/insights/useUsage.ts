// The usage report for the rail tooltip, the Insights page and the agents' model records. Loaded on
// every return to "connected", on a `usage_changed` event, when the week changes, and on `refresh()`
// (the tooltip calls it when it opens). While `live` (the page is open or the tooltip shows) it also
// loads every minute, so data ages and the engine can read plan windows again; otherwise it waits
// for events, so the engine rarely starts a CLI for it. A load keeps the last report on screen: a
// refetch never blanks the page.
import type { UsageReport, UsageWindow } from "@tokama/core";
import { useCallback, useEffect, useState } from "react";
import type { ConnectionState, TokamaBridge } from "../../shared/bridge.js";

export const USAGE_REFRESH_MS = 60_000;

export interface UsageView {
  /** Undefined until the first load, and after the connection failed. */
  readonly report: UsageReport | undefined;
  /** Why the last load failed. */
  readonly error: string | undefined;
  /** Loads again now. */
  readonly refresh: () => void;
}

export function useUsage(bridge: TokamaBridge, connection: ConnectionState, window: UsageWindow, live: boolean, refreshMs = USAGE_REFRESH_MS): UsageView {
  const [report, setReport] = useState<UsageReport | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [reloads, setReloads] = useState(0);
  const refresh = useCallback(() => setReloads((count) => count + 1), []);

  useEffect(
    () =>
      bridge.onEvent(({ event }) => {
        if (event.type === "usage_changed") refresh();
      }),
    [bridge, refresh],
  );

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(refresh, refreshMs);
    return () => clearInterval(timer);
  }, [live, refresh, refreshMs]);

  useEffect(() => {
    if (connection.status !== "connected") return;
    let isCurrent = true;
    void bridge
      .query({ type: "usage", window })
      .then((reply) => {
        if (!isCurrent) return;
        if (reply.ok) {
          setReport(reply.data);
          setError(undefined);
        } else setError(reply.error.message);
      })
      .catch((failure: unknown) => isCurrent && setError(String(failure)));
    return () => {
      isCurrent = false;
    };
  }, [bridge, connection, window, reloads]);

  const failed = connection.status === "failed";
  return { report: failed ? undefined : report, error: failed ? undefined : error, refresh };
}
