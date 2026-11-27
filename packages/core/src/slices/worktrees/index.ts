// Public surface of the worktrees slice.
export { commitItem, commitMessage, stageItem, type CommitError, type CommitErrorReason } from "./commit.js";
export { buildDiff, gitQuoted, treeDiff, type DiffError, type TreeDiff } from "./diff.js";
export { createTrialWorktree, removeTrialWorktree, trialFolderName, trialWorktreePath } from "./trial.js";
export { worktreeSnapshot, type FileSnapshot, type FileState } from "./snapshot.js";
export {
  checkWorktreeFolder,
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
export { mergeItem, mergeMessage, originPushUrl, pushItem, type MergeError, type MergeResult } from "./finish.js";
export { ghStatus, openPullRequest, type GhOptions, type GhStatus, type PullRequestInput } from "./pull-request.js";
export { hostedRepo, overSsh, pushTarget, recordableRemote, withoutUserInfo, type HostedRepo } from "./remote.js";
