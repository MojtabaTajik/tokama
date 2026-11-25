// What the Diff tab of an ended item says above its files: one line with a mark and the state
// (where the work is now), one line saying what the diff is compared with, and the side-by-side
// column heads. Pure functions, tested without React. Every line starts with a symbol and a word,
// so colour is never the only signal.
import type { ItemChange, ItemRecord } from "@tokama/core";
import { totals } from "../ui/DiffView.js";
import { type Mark, markOf } from "../ui/status.js";
import { prName, type Rich } from "./finish-view.js";

/** What an ended item's Diff tab shows: a discarded item's line, or the engine's `item_diff` reply. */
export type ItemDiffState =
  | { readonly kind: "discarded" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "loaded"; readonly change: ItemChange };

export interface DiffHeader {
  readonly mark: Mark;
  /** The state, in strong text. */
  readonly head: Rich;
  /** After the state, each after a " · ". */
  readonly details: readonly Rich[];
  /** What the diff is compared with. */
  readonly sub?: string;
  readonly columns?: { readonly before: string; readonly after: string };
}

const short = (commit: string) => commit.slice(0, 7);
const count = (value: number) => value.toLocaleString("en");

/** "5 files, +1,244 −316": every file that differs, and the lines of the listed ones. */
function counts(change: Extract<ItemChange, { kind: "worktree" | "merged" }>): string {
  const files = change.files.length + change.moreFiles;
  const sum = totals(change);
  return `${files} file${files === 1 ? "" : "s"}, +${count(sum.added)} −${count(sum.removed)}`;
}

/**
 * The Diff tab shows for an ended item once there is something to say: files, a merge, a gone
 * commit or a discard. A change that cannot be read shows only for an item known to have changed
 * something (a commit or a merge), so an item that changed nothing never gets a tab with an error.
 */
export function showsChange(item: Pick<ItemRecord, "outcome" | "finish">, state: ItemDiffState | undefined): boolean {
  if (state === undefined || state.kind === "loading") return false;
  if (state.kind === "discarded") return true;
  if (state.kind === "failed") return (item.outcome?.commits?.length ?? 0) > 0 || item.finish?.merged !== undefined;
  const { change } = state;
  if (change.kind === "none") return false;
  return change.kind !== "worktree" || change.files.length + change.moreFiles > 0;
}

/** The header lines of an ended item's Diff tab; `baseBranch` is the repo's, for a change not merged. */
export function diffHeader(item: Pick<ItemRecord, "state" | "finish">, state: Extract<ItemDiffState, { kind: "discarded" | "loaded" }>, baseBranch: string | undefined): DiffHeader | undefined {
  if (state.kind === "discarded") return { mark: markOf("discarded"), head: ["Discarded"], details: [["the branch and its changes were deleted"]] };
  const { change } = state;
  switch (change.kind) {
    case "none":
      return undefined;
    case "gone":
      return {
        mark: markOf("unknown", "gone"),
        head: ["Commit ", { code: short(change.commit) }, " is no longer in the repo"],
        details: [],
        sub: "History was rewritten after the merge, so there is nothing to compare.",
      };
    case "merged":
      return {
        mark: markOf("done", "merged"),
        head: ["Merged as ", { code: short(change.commit) }, ` into ${change.baseBranch}`],
        details: [[counts(change)]],
        sub: `The merged commit compared with ${change.baseBranch} before it.`,
        columns: { before: `Before · ${change.baseBranch} ${short(change.parent)}`, after: `After · ${short(change.commit)}` },
      };
    case "worktree": {
      const base = baseBranch ?? "the base branch";
      const { branch, baseCommit } = change.worktree;
      const pullRequest = item.finish?.pullRequest;
      const [mark, head, where]: [Mark, string, string] =
        item.state === "stopped"
          ? [markOf("stopped"), "Not merged · stopped", "worktree "]
          : item.state === "failed"
            ? [markOf("failed"), "Not merged · failed", "worktree "]
            : pullRequest !== undefined
              ? [markOf("pull_request"), `${prName(pullRequest.url)} open`, "branch "]
              : [markOf("pending", "not merged"), "Not merged yet", "branch "];
      return {
        mark,
        head: [head],
        details: [[where, { code: branch }], [counts(change)]],
        sub: `Compared with ${base} at ${short(baseCommit)}, where the item started.`,
        columns: { before: `Before · ${base} ${short(baseCommit)}`, after: `After · ${branch}` },
      };
    }
  }
}
