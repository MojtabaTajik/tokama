# worktrees

One worktree and branch per item and repo: `tokama/<short id>` from the base branch, in `<repo>/<worktree folder>/<short id>`, with the folder in the repo's git exclude.
Removes a finished item's worktree after its commit; `discardWorktree` removes a kept one with its branch. `stageItem` fixes the tree before the checks; `commitItem` commits exactly that tree as `tokama: <title>` with a `Tokama-Item: <id>` trailer.
`worktreeSnapshot` is the loop guards' `snapshot()`. Records hold no absolute paths: a worktree's folder is relative to its repo.
Every git call goes through the kernel's hardened wrapper. Must not run the setup command or checks (verification does), push, or open pull requests.
