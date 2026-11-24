# integrity

Tamper checks: `protectedSet(git, input).hash()` before a step and after it; `tamperChanges(before, after)` lists every protected file that changed. A `hash()` error means the set could not be read whole: never compare it.
Protected: shared git config, hooks, info/attributes and info/exclude, the worktree's git config and HEAD, the item branch's commit, `.gitattributes`, `.tokama/`, the base commit's test files and snapshots, test config, package config, CI files and lockfiles (`protected.ts`). Git config files count by the entries git reads from them, without the remote and tracking keys a `git push -u` or `git remote set-url` writes (`IGNORED_KEYS` in `tamper.ts`; a remote url or pushurl only when it names a network host, never a local path or a transport helper), plus the content of the files they include (`include.path`, `includeIf.*.path`); an include that cannot be read makes `hash()` an error.
Symlinks are hashed by target and never followed. Records name files by area and relative path, never absolute paths.
Must not restore files or stop an item: the caller decides what a tamper event does.
