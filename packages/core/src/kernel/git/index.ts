// kernel/git: every git call Tokama makes, hardened so that a repo's config, hooks and attributes
// (written by an agent or shipped in a cloned repo) never make it run code. Not a sandbox.
export {
  DIFF_SAFE,
  GIT_ENV,
  GIT_SAFE_CONFIG,
  MIN_GIT_VERSION,
  createGit,
  parseGitVersion,
  parseNumstat,
  parseStatus,
  parseWorktreeList,
  type Git,
  type GitError,
  type GitErrorReason,
  type GitOptions,
  type GitResult,
  type NumstatEntry,
  type StatusEntry,
  type WorktreeEntry,
} from "./git.js";
