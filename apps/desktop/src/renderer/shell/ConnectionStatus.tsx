// The local engine connection: its health under "+ New work" in the sidebar, and the
// failure details (reason, log path, log tail) in the board area when the engine is not
// available. All of it is React text.
import type { ConnectionState } from "../../shared/bridge.js";

const TEXT = {
  health: {
    starting: "starting",
    connected: "engine connected",
    reconnecting: "reconnecting",
    failed: "not available",
  },
  failed: "The engine is not available",
  engineId: "Engine",
  log: "Log",
  retry: "Retry",
  hint: "Tokama does not stop other engine processes from here. Fix the cause above, then retry.",
} as const;

// A symbol with every status, so colour is never the only signal.
const SYMBOL: Record<ConnectionState["status"], string> = {
  starting: "◌",
  connected: "●",
  reconnecting: "◐",
  failed: "✕",
};

/** Symbol and word; healthy is a quiet dot whose word only screen readers get. */
export function EngineHealth({ state }: { readonly state: ConnectionState }) {
  const title = state.status === "connected" ? `${TEXT.engineId} ${state.engineId}` : undefined;
  return (
    <span className="health" data-status={state.status} title={title} role="status">
      <span className="symbol" aria-hidden="true">
        {SYMBOL[state.status]}
      </span>
      <span className={state.status === "connected" ? "visually-hidden" : "health-word"}>{TEXT.health[state.status]}</span>
    </span>
  );
}

export function ConnectionFailure({ state, onRetry }: { readonly state: Extract<ConnectionState, { status: "failed" }>; readonly onRetry: () => void }) {
  return (
    <section className="failure" aria-label={TEXT.failed}>
      <p className="failure-title">
        <span className="symbol" aria-hidden="true">
          {SYMBOL.failed}
        </span>
        {TEXT.failed}
      </p>
      <p className="detail">{state.reason}</p>
      <p className="detail">
        <span className="label">{TEXT.log} </span>
        <span className="mono">{state.logPath}</span>
      </p>
      {state.logTail.length > 0 && <pre className="log mono">{state.logTail.join("\n")}</pre>}
      <p className="detail hint">{TEXT.hint}</p>
      <button type="button" className="retry" onClick={onRetry}>
        {TEXT.retry}
      </button>
    </section>
  );
}
