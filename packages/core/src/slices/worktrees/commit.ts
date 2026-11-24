// The item's commit on its branch, in two parts around the checks:
// - `stageItem` before the checks: stages every change and fixes the tree (`write-tree`);
// - `commitItem` after they pass: commits exactly that tree on the base commit (`commit-tree`)
//   and moves the branch only if it still points at the base commit.
// Files a check writes after the tree was fixed never reach the commit. Every call goes through
// the hardened git wrapper (no hooks, no signing). Message: `tokama: <title>` plus a
// `Tokama-Item: <id>` trailer.
import type { Git } from "../../kernel/git/index.js";
import { err, ok, type Result } from "../../kernel/result/index.js";
import type { ItemId } from "../../kernel/schemas/index.js";
import type { ItemWorktree } from "./worktree.js";

export type CommitErrorReason = "nothing-to-commit" | "git";

export interface CommitError {
  readonly reason: CommitErrorReason;
  readonly message: string;
}

const SUBJECT_MAX = 100;

/**
 * The commit message. The title is the engineer's or an agent's text: it is folded onto one line
 * (no line breaks or control characters), so it cannot add paragraphs or forge a trailer.
 */
export function commitMessage(itemId: ItemId, title: string): string {
  const oneLine = title.replace(/[\s\p{Cc}]+/gu, " ").trim();
  const subject = oneLine.length > SUBJECT_MAX ? `${oneLine.slice(0, SUBJECT_MAX - 1)}…` : oneLine;
  return `tokama: ${subject === "" ? itemId : subject}\n\nTokama-Item: ${itemId}\n`;
}

const gitFailure = (error: { readonly message: string }): Result<never, CommitError> => err({ reason: "git", message: error.message });

/** Stages every change in the worktree; returns the tree id to commit once the checks pass. */
export async function stageItem(git: Git, worktreePath: string): Promise<Result<string, CommitError>> {
  const added = await git.addAll(worktreePath);
  if (!added.ok) return gitFailure(added.error);
  const tree = await git.writeTree(worktreePath);
  return tree.ok ? ok(tree.value) : gitFailure(tree.error);
}

/** Commits `tree` (from `stageItem`) on the item branch, parent the base commit; returns the commit id. */
export async function commitItem(
  git: Git,
  worktreePath: string,
  worktree: Pick<ItemWorktree, "branch" | "baseCommit">,
  item: { readonly id: ItemId; readonly title: string; readonly tree: string },
): Promise<Result<string, CommitError>> {
  const baseTree = await git.revParse(worktreePath, `${worktree.baseCommit}^{tree}`);
  if (!baseTree.ok) return gitFailure(baseTree.error);
  if (baseTree.value === item.tree) return err({ reason: "nothing-to-commit", message: "the staged tree has no changes" });
  const commit = await git.commitTree(worktreePath, item.tree, worktree.baseCommit, commitMessage(item.id, item.title));
  if (!commit.ok) return gitFailure(commit.error);
  // Refused if anything moved the branch since the item started.
  const moved = await git.updateRef(worktreePath, `refs/heads/${worktree.branch}`, commit.value, worktree.baseCommit);
  return moved.ok ? ok(commit.value) : gitFailure(moved.error);
}
