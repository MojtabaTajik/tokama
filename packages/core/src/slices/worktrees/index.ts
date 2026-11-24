// Public surface of the worktrees slice.
export { commitItem, commitMessage, type CommitError, type CommitErrorReason } from "./commit.js";
export { worktreeSnapshot, type FileSnapshot, type FileState } from "./snapshot.js";
export {
  createWorktree,
  discardWorktree,
  itemBranch,
  removeWorktree,
  shortItemId,
  worktreePath,
  type ItemWorktree,
  type WorktreeError,
  type WorktreeErrorReason,
  type WorktreeRepo,
} from "./worktree.js";
