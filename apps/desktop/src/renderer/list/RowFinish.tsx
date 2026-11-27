// The finish button on a Done row: the shared split button, for an item that offers Merge. Discard…
// opens the item with its question; nothing is thrown away from the list.
import type { FinishAction, ItemRecord, Setup } from "@tokama/core";
import { baseBranchOf, finishActions, prPushNote, prUnavailable } from "../drawer/finish-view.js";
import { FinishSplit } from "../ui/FinishSplit.js";

const TEXT = { more: (title: string) => `More ways to finish ${title}` } as const;

export interface RowFinishProps {
  readonly item: ItemRecord;
  readonly setup: Setup | undefined;
  readonly onFinish: (itemId: string, action: FinishAction) => void | Promise<void>;
  /** Opens the item with its Discard question. */
  readonly onDiscard: (itemId: string) => void;
  /** `outlined` for a place that is not a hovered row and has a primary button of its own. */
  readonly variant?: "row" | "outlined";
}

export function RowFinish({ item, setup, onFinish, onDiscard, variant = "row" }: RowFinishProps) {
  if (!finishActions(item).includes("merge")) return null;
  return (
    <FinishSplit
      variant={variant}
      base={baseBranchOf(item, setup)}
      prOff={prUnavailable(item, setup)}
      prNote={prPushNote(item)}
      moreLabel={TEXT.more(item.title)}
      // The split goes once the action starts: focus stays on the row.
      onPicked={(from) => from?.closest<HTMLElement>(".pl-row-wrap")?.querySelector<HTMLElement>(".pl-row")?.focus()}
      onPick={(pick) => (pick === "discard" ? onDiscard(item.id) : pick === "accept_git_changes" ? undefined : onFinish(item.id, pick))}
    />
  );
}
