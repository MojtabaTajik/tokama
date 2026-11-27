// The machine report for the Machine tab. The engine reads the machine only while somebody keeps
// asking, so this asks again after each answer, `everyMs` later, for as long as it is mounted, the
// engine is connected and the window is visible. A hidden window asks nothing (the engine then stops
// reading, and the chart shows the time as hatched); it asks at once when it shows again. A load
// keeps the last report on screen.
import type { MachineReport } from "@tokama/core";
import { useEffect, useState } from "react";
import type { ConnectionState, TokamaBridge } from "../../shared/bridge.js";

export interface MachineView {
  /** Undefined until the first answer, and after the connection failed. */
  readonly report: MachineReport | undefined;
  /** Why the last ask failed. */
  readonly error: string | undefined;
}

const isVisible = () => document.visibilityState !== "hidden";

/** Whether the window is on screen: not minimised, and not on another desktop or tab. */
function useVisible(): boolean {
  const [visible, setVisible] = useState(isVisible);
  useEffect(() => {
    const update = () => setVisible(isVisible());
    document.addEventListener("visibilitychange", update);
    update();
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

export function useMachine(bridge: TokamaBridge, connection: ConnectionState): MachineView {
  const [report, setReport] = useState<MachineReport | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const connected = connection.status === "connected";
  const visible = useVisible();

  useEffect(() => {
    // After a restart the old readings are not this engine's: show nothing until it answers.
    if (!connected) {
      setReport(undefined);
      setError(undefined);
    }
  }, [bridge, connected]);

  useEffect(() => {
    if (!connected || !visible) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () => {
      void bridge
        .query({ type: "machine" })
        .then((reply) => {
          if (stopped) return;
          if (reply.ok) {
            setReport(reply.data);
            setError(undefined);
          } else setError(reply.error.message);
          // A failed ask is tried again at the usual pace.
          timer = setTimeout(ask, reply.ok ? reply.data.everyMs : FALLBACK_MS);
        })
        .catch((failure: unknown) => {
          if (stopped) return;
          setError(String(failure));
          timer = setTimeout(ask, FALLBACK_MS);
        });
    };
    ask();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [bridge, connected, visible]);

  return connection.status === "failed" ? { report: undefined, error: undefined } : { report, error };
}

const FALLBACK_MS = 5_000;
