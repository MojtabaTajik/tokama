# integrity

Tamper checks: `protectedSet(git, input).hash()` before a step and after it; `tamperChanges(before, after)` lists every protected file that changed.
Protected: shared git config, hooks, info/attributes and info/exclude, the worktree's git config, `.tokama/`, the base commit's test files and snapshots, test config, CI files and lockfiles (`protected.ts`).
Symlinks are hashed by target and never followed. Records name files by area and relative path, never absolute paths.
Must not restore files or stop an item: the caller decides what a tamper event does.
