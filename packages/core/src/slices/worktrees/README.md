# worktrees

One worktree and branch per item and repo: `tokama/<short id>` from the base branch, in `<repo>/<worktree folder>/<short id>`, with the folder in the repo's git exclude.
Removes a finished item's worktree after its commit; `discardWorktree` removes a kept one with its branch. `stageItem` fixes the tree before the checks; `commitItem` commits exactly that tree as `tokama: <title>` with a `Tokama-Item: <id>` trailer.
`treeDiff` reads the change between two trees for the engineer to approve: files, line counts and hunks, cut to fit one API reply.
`worktreeSnapshot` is the loop guards' `snapshot()`. Records hold no absolute paths: a worktree's folder is relative to its repo.
Finish actions on a done item's commit: `mergeItem` (only into the base branch the engineer's checkout is on, only with no uncommitted changes, fast-forward or conflict-free, never a stash), `pushItem` (only while origin points where it did at Start, see `remote.ts`), `openPullRequest` and `ghStatus` through the engineer's `gh` CLI, run outside the repo.
Every git call goes through the kernel's hardened wrapper. Must not run the setup command or checks (verification does), or run any finish action without the engineer's command.
