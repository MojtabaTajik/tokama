import { useEffect, useState } from "react";
import type { ConnectionState, TokamaBridge } from "../shared/bridge.js";
import { brand } from "./brand/index.js";

// UI text of this screen, in one place (architecture.md, section 11).
const TEXT = {
  starting: "Starting the engine",
  connected: "Connected to the engine",
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

export function App({ bridge }: { readonly bridge: TokamaBridge }) {
  const [state, setState] = useState<ConnectionState>({ status: "starting" });

  useEffect(() => {
    let live = true;
    // Subscribe first, then read the current state, so a change in between is not lost.
    const stop = bridge.onConnection((next) => {
      if (live) setState(next);
    });
    void bridge.getConnection().then((current) => {
      if (live) setState(current);
    });
    return () => {
      live = false;
      stop();
    };
  }, [bridge]);

  return (
    <div className="shell">
      <header className="brand">
        <img src={brand.markUrl} alt="" width={24} height={24} />
        <img src={brand.wordmarkUrl} alt={brand.name} height={20} />
      </header>
      <main className="connection" aria-live="polite">
        <p className="status" data-status={state.status}>
          <span className="symbol" aria-hidden="true">
            {SYMBOL[state.status]}
          </span>
          {TEXT[state.status]}
        </p>
        <Details state={state} />
      </main>
    </div>
  );
}

function Details({ state }: { readonly state: ConnectionState }) {
  if (state.status === "connected") {
    return (
      <p className="detail">
        <span className="label">{TEXT.engineId} </span>
        <span className="mono">{state.engineId}</span>
      </p>
    );
  }
  if (state.status !== "failed") return null;
  return (
    <>
      <p className="detail">{state.reason}</p>
      <p className="detail">
        <span className="label">{TEXT.log} </span>
        <span className="mono">{state.logPath}</span>
      </p>
      {state.logTail.length > 0 && <pre className="log mono">{state.logTail.join("\n")}</pre>}
    </>
  );
}
