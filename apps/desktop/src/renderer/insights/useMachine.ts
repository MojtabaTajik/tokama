// The machine report for the Machine tab. The engine reads the machine only while somebody keeps
// asking, so this asks again after each answer, `everyMs` later, for as long as it is mounted and
// the engine is connected. A load keeps the last report on screen.
import type { MachineReport } from "@tokama/core";
import { useEffect, useState } from "react";
import type { ConnectionState, TokamaBridge } from "../../shared/bridge.js";

export interface MachineView {
  /** Undefined until the first answer, and after the connection failed. */
  readonly report: MachineReport | undefined;
  /** Why the last ask failed. */
  readonly error: string | undefined;
}

export function useMachine(bridge: TokamaBridge, connection: ConnectionState): MachineView {
  const [report, setReport] = useState<MachineReport | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const connected = connection.status === "connected";

  useEffect(() => {
    if (!connected) {
      // After a restart the old readings are not this engine's: show nothing until it answers.
      setReport(undefined);
      setError(undefined);
      return;
    }
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
  }, [bridge, connected]);

  return connection.status === "failed" ? { report: undefined, error: undefined } : { report, error };
}

const FALLBACK_MS = 5_000;
