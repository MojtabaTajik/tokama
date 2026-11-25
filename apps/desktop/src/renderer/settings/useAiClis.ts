// The AI CLIs the engine lists, loaded when the page opens and again on "Check again" or a setup change.
import type { AiClisResult, Setup } from "@tokama/core";
import { useEffect, useState } from "react";
import type { ConnectionState, TokamaBridge } from "../../shared/bridge.js";

export type AiClisState =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  /** `checking`: a new read is running; the last answer stays on screen until it arrives. */
  | { readonly status: "loaded"; readonly data: AiClisResult; readonly checking: boolean };

/** `setup` is only a signal: a new one means something changed, so the list is read again. */
export function useAiClis(bridge: TokamaBridge, connection: ConnectionState, setup: Setup | undefined): { readonly state: AiClisState; readonly reload: () => void } {
  const [state, setState] = useState<AiClisState>({ status: "loading" });
  const [reloads, setReloads] = useState(0);
  const connected = connection.status === "connected";
  useEffect(() => {
    if (!connected) return;
    let current = true;
    bridge
      .query({ type: "ai_clis" })
      .then((reply) => current && setState(reply.ok ? { status: "loaded", data: reply.data, checking: false } : { status: "failed", message: reply.error.message }))
      .catch((error: unknown) => current && setState({ status: "failed", message: String(error) }));
    return () => {
      current = false;
    };
  }, [bridge, connected, setup, reloads]);
  return {
    state,
    reload: () => {
      setState((previous) => (previous.status === "loaded" ? { ...previous, checking: true } : { status: "loading" }));
      setReloads(reloads + 1);
    },
  };
}
