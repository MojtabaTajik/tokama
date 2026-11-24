// The engine connection: a small status line in the main header, and the failure details
// (reason, log path, log tail) when the engine is not available. All of it is React text.
import type { ConnectionState } from "../../shared/bridge.js";

const TEXT = {
  starting: "Starting the engine",
  connected: "Engine connected",
  reconnecting: "Reconnecting to the engine",
  failed: "The engine is not available",
  engineId: "Engine",
  log: "Log",
} as const;

// A symbol with every status, so colour is never the only signal.
const SYMBOL: Record<ConnectionState["status"], string> = {
  starting: "◌",
  connected: "●",
  reconnecting: "◐",
  failed: "✕",
};

export function ConnectionStatus({ state }: { readonly state: ConnectionState }) {
  const title = state.status === "connected" ? `${TEXT.engineId} ${state.engineId}` : undefined;
  return (
    <p className="status" data-status={state.status} title={title} aria-live="polite">
      <span className="symbol" aria-hidden="true">
        {SYMBOL[state.status]}
      </span>
      {TEXT[state.status]}
    </p>
  );
}

export function ConnectionFailure({ state }: { readonly state: Extract<ConnectionState, { status: "failed" }> }) {
  return (
    <section className="failure" aria-label={TEXT.failed}>
      <p className="detail">{state.reason}</p>
      <p className="detail">
        <span className="label">{TEXT.log} </span>
        <span className="mono">{state.logPath}</span>
      </p>
      {state.logTail.length > 0 && <pre className="log mono">{state.logTail.join("\n")}</pre>}
    </section>
  );
}
