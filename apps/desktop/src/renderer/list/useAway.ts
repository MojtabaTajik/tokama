// The away state in the window: asks the main process once and follows what it pushes (the user
// came back after 15 minutes, or pressed Got it). An answer that fails leaves no strip.
import { useCallback, useEffect, useState } from "react";
import type { TokamaBridge } from "../../shared/bridge.js";
import type { AwayInfo } from "../../shared/desktop-state.js";

export interface AwayView {
  readonly info: AwayInfo | undefined;
  /** Got it: the main process sees everything up to now. The strip goes at once. */
  readonly close: () => void;
}

export function useAway(bridge: TokamaBridge): AwayView {
  const [info, setInfo] = useState<AwayInfo | undefined>(undefined);
  useEffect(() => {
    let live = true;
    // A push that comes before the first answer is the newer one.
    const stop = bridge.onAway((next) => live && setInfo(next));
    Promise.resolve()
      .then(() => bridge.getAway())
      .then((first) => live && setInfo((current) => current ?? first), () => undefined);
    return () => {
      live = false;
      stop();
    };
  }, [bridge]);
  const close = useCallback(() => {
    setInfo((current) => (current === undefined ? current : { seenUntil: current.seenUntil, due: false }));
    void bridge.closeAway().catch(() => undefined);
  }, [bridge]);
  return { info, close };
}
