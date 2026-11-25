// Public surface of the worktrees slice.
export { commitItem, commitMessage, stageItem, type CommitError, type CommitErrorReason } from "./commit.js";
export { buildDiff, gitQuoted, treeDiff, type DiffError, type TreeDiff } from "./diff.js";
export { worktreeSnapshot, type FileSnapshot, type FileState } from "./snapshot.js";
export {
  createWorktree,
  discardWorktree,
  findItemWorktree,
  itemBranch,
  removeWorktree,
  shortItemId,
  worktreePath,
  type ItemWorktree,
  type WorktreeError,
  type WorktreeErrorReason,
  type WorktreeRepo,
} from "./worktree.js";
