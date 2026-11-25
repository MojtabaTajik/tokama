// The agents the engine lists, loaded when the page opens and again after a setup change or a retry.
import type { AgentsListResult, Setup } from "@tokama/core";
import { useEffect, useState } from "react";
import type { ConnectionState, TokamaBridge } from "../../shared/bridge.js";

export type AgentsState =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "loaded"; readonly data: AgentsListResult };

/** `setup` is only a signal: a new one means repos or files changed, so the list is read again. */
export function useAgents(bridge: TokamaBridge, connection: ConnectionState, setup: Setup | undefined): { readonly state: AgentsState; readonly reload: () => void } {
  const [state, setState] = useState<AgentsState>({ status: "loading" });
  const [reloads, setReloads] = useState(0);
  const connected = connection.status === "connected";
  useEffect(() => {
    if (!connected) return;
    let current = true;
    bridge
      .query({ type: "agents_list" })
      .then((reply) => current && setState(reply.ok ? { status: "loaded", data: reply.data } : { status: "failed", message: reply.error.message }))
      .catch((error: unknown) => current && setState({ status: "failed", message: String(error) }));
    return () => {
      current = false;
    };
  }, [bridge, connected, setup, reloads]);
  return {
    state,
    reload: () => {
      setState({ status: "loading" });
      setReloads(reloads + 1);
    },
  };
}
