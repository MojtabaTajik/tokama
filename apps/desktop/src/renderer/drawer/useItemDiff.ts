// What an ended item changed, as its Diff tab shows it.
import type { ItemRecord } from "@tokama/core";
import { useEffect, useState } from "react";
import type { TokamaBridge } from "../../shared/bridge.js";
import { changesRepo } from "./attempt-view.js";
import { hasEnded } from "./describe.js";
import { isDiscarded } from "./finish-view.js";
import type { ItemDiffState } from "./item-diff-view.js";

const LOADING: ItemDiffState = { kind: "loading" };

/**
 * The change of an ended item that changes a repo, asked for again when a finish action changes
 * where the work is. A discarded item is not asked about: its line says so when it had a commit.
 * An answer is kept with what it is for, so a merged item never shows the diff from before the merge.
 */
export function useItemDiff(bridge: TokamaBridge, item: ItemRecord | undefined): ItemDiffState | undefined {
  const [answer, setAnswer] = useState<{ readonly for: string; readonly state: ItemDiffState } | undefined>(undefined);
  const ended = item !== undefined && changesRepo(item) && hasEnded(item);
  const discarded = ended && isDiscarded(item);
  const itemId = item?.id;
  const key = ended && !discarded ? [item.id, item.state, item.finish?.merged?.commit, item.finish?.pullRequest?.url, item.finish?.worktreeRemoved].join("\n") : undefined;
  useEffect(() => {
    if (key === undefined || itemId === undefined) return;
    let current = true;
    void bridge
      .query({ type: "item_diff", itemId })
      .then((reply) => {
        if (current) setAnswer({ for: key, state: reply.ok ? { kind: "loaded", change: reply.data } : { kind: "failed", message: reply.error.message } });
      })
      .catch((cause: unknown) => {
        if (current) setAnswer({ for: key, state: { kind: "failed", message: String(cause) } });
      });
    return () => {
      current = false;
    };
  }, [bridge, itemId, key]);
  if (discarded) return (item.outcome?.commits?.length ?? 0) > 0 ? { kind: "discarded" } : undefined;
  if (key === undefined) return undefined;
  return answer?.for === key ? answer.state : LOADING;
}
