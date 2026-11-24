// The item's commit on its branch, made after its checks pass: every change in the worktree,
// through the hardened git wrapper (no hooks, no signing), with the message
// `tokama: <title>` and a `Tokama-Item: <id>` trailer.
import type { Git } from "../../kernel/git/index.js";
import { err, ok, type Result } from "../../kernel/result/index.js";
import type { ItemId } from "../../kernel/schemas/index.js";

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

/** Stages every change in the worktree and commits it on the item branch; returns the commit id. */
export async function commitItem(git: Git, worktreePath: string, item: { readonly id: ItemId; readonly title: string }): Promise<Result<string, CommitError>> {
  const added = await git.addAll(worktreePath);
  if (!added.ok) return err({ reason: "git", message: added.error.message });
  const staged = await git.diffCachedNumstat(worktreePath);
  if (!staged.ok) return err({ reason: "git", message: staged.error.message });
  if (staged.value.length === 0) return err({ reason: "nothing-to-commit", message: "the worktree has no changes" });
  const committed = await git.commit(worktreePath, commitMessage(item.id, item.title));
  return committed.ok ? ok(committed.value) : err({ reason: "git", message: committed.error.message });
}
