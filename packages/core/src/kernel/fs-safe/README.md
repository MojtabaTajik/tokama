# fs-safe

Reads untrusted files: `readTextFile(path, { maxBytes, maxLines? })`, `readTextHead(path, { maxBytes, replaceInvalid? })` (the first `maxBytes` and `truncated`, never a split character), `readTextTail(path, { maxBytes, maxLines, countLinesUpTo })` (the last whole lines, with the file's size and line count; invalid UTF-8 reads as U+FFFD), `readJsonFile(path, options)`, `isInside(root, path)`.
`readTextFileInside(root, path, options)` and `listFiles(root, rel, { max })` check `isInside` before they open anything.
Regular files only, no symlink at the last path component, non-blocking open (a FIFO cannot hang the engine), size and line caps, strict UTF-8.
Failures are `Result` values with a `reason`; nothing throws.
`appendTextSync(path, text, mode?)` appends with one open and `replaceTextSync(path, text, mode?)` writes a temp file, fsyncs it and renames it over the path. Both are synchronous (they also work while the process dies), create files 0600, never write through a symlink at the last path component and never block on a FIFO.
Symlinked parent directories are followed by the open: call `isInside` first when a read must stay inside a worktree or run folder.
`isInside` and the open stop symlinks, not hard links: a hard link inside the root to a file outside it is a regular file inside it.
`listFolders(root, rel, { max })` lists real folders only: a link to a folder is left out, so a walk never leaves the tree or reads a folder twice.
`readLinesFrom(path, { maxFileBytes, maxLineBytes, resume? }, onLine)` reads a growing log line by line from where the last read ended (same file and no shorter, else from the start), skips a line over the cap without keeping it, and leaves a line still being written for the next read.
