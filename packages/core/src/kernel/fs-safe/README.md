# fs-safe

Reads untrusted files: `readTextFile(path, { maxBytes, maxLines? })`, `readJsonFile(path, options)`, `isInside(root, path)`.
`readTextFileInside(root, path, options)` and `listFiles(root, rel, { max })` check `isInside` before they open anything.
Regular files only, no symlink at the last path component, non-blocking open (a FIFO cannot hang the engine), size and line caps, strict UTF-8.
Failures are `Result` values with a `reason`; nothing throws. Owns reading only; it never writes.
Symlinked parent directories are followed by the open: call `isInside` first when a read must stay inside a worktree or run folder.
`isInside` and the open stop symlinks, not hard links: a hard link inside the root to a file outside it is a regular file inside it.
