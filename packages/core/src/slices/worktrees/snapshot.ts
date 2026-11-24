// The loop guards' `snapshot()`: the worktree's changed and untracked files (from `git status`,
// so ignored files such as node_modules are left out) with their mtime and size.
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { Git } from "../../kernel/git/index.js";

export interface FileState {
  /** Modification time, milliseconds since the Unix epoch. */
  readonly mtimeMs: number;
  readonly size: number;
}

/** Path relative to the worktree → its state, or `null` when it is listed but gone (deleted). */
export type FileSnapshot = ReadonlyMap<string, FileState | null>;

/** The worktree's changed files now; `undefined` when git fails. */
export async function worktreeSnapshot(git: Git, worktreePath: string): Promise<FileSnapshot | undefined> {
  const status = await git.status(worktreePath);
  if (!status.ok) return undefined;
  const snapshot = new Map<string, FileState | null>();
  for (const { path } of status.value) {
    try {
      const stat = await lstat(join(worktreePath, ...path.split("/")));
      snapshot.set(path, { mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      snapshot.set(path, null);
    }
  }
  return snapshot;
}
