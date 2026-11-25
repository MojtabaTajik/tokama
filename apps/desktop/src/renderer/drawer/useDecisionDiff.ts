// The change an open decision asks you to approve, as the Diff tab and the Needs you row show it.
import type { Decision } from "@tokama/core";
import { useEffect, useState } from "react";
import type { TokamaBridge } from "../../shared/bridge.js";
import type { DiffState } from "../ui/DiffView.js";

const LOADING: DiffState = { kind: "loading" };

/**
 * The change of an open decision, asked for again when the decision changes. An answer is kept
 * with the decision it is for, so a newer question never shows an older change, not even for one frame.
 */
export function useDecisionDiff(bridge: TokamaBridge, itemId: string, decision: Decision | undefined): DiffState | undefined {
  const [answer, setAnswer] = useState<{ readonly for: string; readonly state: DiffState } | undefined>(undefined);
  const decisionId = decision?.hasDiff === true ? decision.id : undefined;
  useEffect(() => {
    if (decisionId === undefined) return;
    let current = true;
    void bridge
      .query({ type: "decision_diff", itemId, decisionId })
      .then((reply) => {
        if (current) setAnswer({ for: decisionId, state: reply.ok ? { kind: "loaded", diff: reply.data } : { kind: "failed", message: reply.error.message } });
      })
      .catch((cause: unknown) => {
        if (current) setAnswer({ for: decisionId, state: { kind: "failed", message: String(cause) } });
      });
    return () => {
      current = false;
    };
  }, [bridge, itemId, decisionId]);
  if (decisionId === undefined) return undefined;
  return answer?.for === decisionId ? answer.state : LOADING;
}
