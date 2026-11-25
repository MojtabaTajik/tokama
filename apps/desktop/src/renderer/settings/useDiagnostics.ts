// The waiting diagnostics entries and the collect switch, loaded when the page opens and again on
// a diagnostics_changed or setup_changed event. Also the waiting count for the rail badge.
import { useCallback, useEffect, useState } from "react";
import type { ConnectionState, DiagnosticsItem, TokamaBridge } from "../../shared/bridge.js";

export type DiagnosticsState =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | { readonly status: "loaded"; readonly items: readonly DiagnosticsItem[]; readonly collect: boolean | undefined };

export function useDiagnostics(bridge: TokamaBridge, connection: ConnectionState): { readonly state: DiagnosticsState; readonly reload: () => void } {
  const [state, setState] = useState<DiagnosticsState>({ status: "loading" });
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((count) => count + 1), []);
  const connected = connection.status === "connected";
  useEffect(() => bridge.onEvent(({ event }) => (event.type === "diagnostics_changed" || event.type === "setup_changed") && reload()), [bridge, reload]);
  useEffect(() => {
    if (!connected) return;
    let current = true;
    void Promise.all([bridge.loadDiagnostics(), bridge.query({ type: "diagnostics_settings" })])
      .then(([loaded, settings]) => {
        if (!current) return;
        setState(loaded.ok ? { status: "loaded", items: loaded.items, collect: settings.ok ? settings.data.collect : undefined } : { status: "failed" });
      })
      .catch(() => current && setState({ status: "failed" }));
    return () => {
      current = false;
    };
  }, [bridge, connected, reloads]);
  return { state, reload };
}

/** The most entries the badge counts; more show as "99+". */
const BADGE_LIMIT = 100;

/** How many diagnostics entries wait, for the rail badge; 0 without an engine. */
export function useDiagnosticsWaiting(bridge: TokamaBridge, connection: ConnectionState): number {
  const [count, setCount] = useState(0);
  const [reloads, setReloads] = useState(0);
  const connected = connection.status === "connected";
  useEffect(() => bridge.onEvent(({ event }) => event.type === "diagnostics_changed" && setReloads((n) => n + 1)), [bridge]);
  useEffect(() => {
    if (!connected) return setCount(0);
    let current = true;
    bridge
      .query({ type: "diagnostics_list", limit: BADGE_LIMIT })
      .then((reply) => current && setCount(reply.ok ? reply.data.entries.length : 0))
      .catch(() => current && setCount(0));
    return () => {
      current = false;
    };
  }, [bridge, connected, reloads]);
  return count;
}
