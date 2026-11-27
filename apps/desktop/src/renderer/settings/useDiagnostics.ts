// The waiting diagnostics entries and the collect switch, loaded when the page opens and again on
// a diagnostics_changed or setup_changed event. Also whether a crash entry waits, for the rail's mark.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectionState, DiagnosticsItem, TokamaBridge } from "../../shared/bridge.js";

export type DiagnosticsState =
  | { readonly status: "loading" }
  | { readonly status: "failed" }
  | { readonly status: "loaded"; readonly items: readonly DiagnosticsItem[]; readonly collect: boolean | undefined };

/** `reload` resolves once the list it asked for is shown (or failed). */
export function useDiagnostics(bridge: TokamaBridge, connection: ConnectionState): { readonly state: DiagnosticsState; readonly reload: () => Promise<void> } {
  const [state, setState] = useState<DiagnosticsState>({ status: "loading" });
  // Loads can overlap; only the one started last is shown.
  const latest = useRef(0);
  const connected = connection.status === "connected";
  const reload = useCallback(async () => {
    const load = ++latest.current;
    const next: DiagnosticsState = await Promise.all([bridge.loadDiagnostics(), bridge.query({ type: "diagnostics_settings" })])
      .then(([loaded, settings]): DiagnosticsState => (loaded.ok ? { status: "loaded", items: loaded.items, collect: settings.ok ? settings.data.collect : undefined } : { status: "failed" }))
      .catch((): DiagnosticsState => ({ status: "failed" }));
    if (load === latest.current) setState(next);
  }, [bridge]);
  useEffect(() => bridge.onEvent(({ event }) => (event.type === "diagnostics_changed" || event.type === "setup_changed") && connected && void reload()), [bridge, connected, reload]);
  useEffect(() => {
    if (connected) void reload();
    // Unmounting or losing the engine drops a load still on its way.
    return () => {
      latest.current++;
    };
  }, [connected, reload]);
  return { state, reload };
}

/** Whether a crash entry waits to be sent or deleted, for the rail's mark on Settings; false without an engine. */
export function useDiagnosticsWaiting(bridge: TokamaBridge, connection: ConnectionState): boolean {
  const [waiting, setWaiting] = useState(false);
  const [reloads, setReloads] = useState(0);
  const connected = connection.status === "connected";
  useEffect(() => bridge.onEvent(({ event }) => event.type === "diagnostics_changed" && setReloads((n) => n + 1)), [bridge]);
  useEffect(() => {
    if (!connected) return setWaiting(false);
    let current = true;
    bridge
      .query({ type: "diagnostics_list", types: ["crash"], limit: 1 })
      .then((reply) => current && setWaiting(reply.ok && reply.data.entries.length > 0))
      .catch(() => current && setWaiting(false));
    return () => {
      current = false;
    };
  }, [bridge, connected, reloads]);
  return waiting;
}
