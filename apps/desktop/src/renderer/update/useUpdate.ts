// The update state of the main process: read once, then followed. Undefined until the first answer.
import { useEffect, useState } from "react";
import type { TokamaBridge } from "../../shared/bridge.js";
import type { UpdateState } from "../../shared/update.js";

export function useUpdate(bridge: TokamaBridge): UpdateState | undefined {
  const [state, setState] = useState<UpdateState | undefined>(undefined);
  useEffect(() => {
    let live = true;
    // A push that comes before the first answer is newer than that answer.
    let pushed = false;
    const stop = bridge.onUpdate((next) => {
      pushed = true;
      if (live) setState(next);
    });
    bridge.getUpdate().then(
      (first) => {
        if (live && !pushed) setState(first);
      },
      () => undefined,
    );
    return () => {
      live = false;
      stop();
    };
  }, [bridge]);
  return state;
}
