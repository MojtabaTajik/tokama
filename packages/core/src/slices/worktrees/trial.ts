// Throwaway worktrees for Try checks: detached at a commit, no branch, in
// `<repo>/<worktree folder>/try-<8 hex>` next to the item worktrees. A trial worktree is only ever
// removed by its exact folder name and only while git lists it as detached, so an item's
// `tokama/*` worktree is never touched.
import { lstat, mkdir, realpath, rmdir } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import type { Git } from "../../kernel/git/index.js";
import { hasCode } from "../../kernel/errno/index.js";
import { err, ok, type Result } from "../../kernel/result/index.js";
import { excludeFolder, normalizeFolder, real, removeEntries, type WorktreeError, type WorktreeRepo } from "./worktree.js";

const TRIAL_NAME = /^try-[0-9a-f]{8}$/;

/** `try-` and the last 8 hex digits of the trial's id (its random part). */
export const trialFolderName = (trialId: string): string => `try-${trialId.slice(-8)}`;

/** Absolute path of a trial's worktree: no file system access. */
export const trialWorktreePath = (repo: WorktreeRepo, trialId: string): string => join(repo.path, ...normalizeFolder(repo.worktreeFolder).split("/"), trialFolderName(trialId));

const refuse = (reason: WorktreeError["reason"], message: string): Result<never, WorktreeError> => err({ reason, message });

/**
 * Walks the worktree folder from the repo's real path, one part at a time. A part that is a link
 * or not a folder is refused (a cloned repo can carry a tracked link that points anywhere). With
 * `create`, missing parts are made one by one, never with a recursive mkdir that would follow a
 * link. Returns the folder's real path.
 */
export async function checkTrialFolder(repo: WorktreeRepo, options: { readonly create: boolean }): Promise<Result<string, WorktreeError>> {
  let current: string;
  try {
    current = await realpath(repo.path);
  } catch (error) {
    return refuse("folder", `the repo folder cannot be read: ${(error as Error).message}`);
  }
  const root = current;
  for (const part of normalizeFolder(repo.worktreeFolder).split("/")) {
    current = join(current, part);
    try {
      let info = await lstat(current).catch((error: unknown) => {
        if (hasCode(error, "ENOENT")) return undefined;
        throw error;
      });
      if (info === undefined) {
        if (!options.create) return ok(current);
        await mkdir(current).catch((error: unknown) => {
          if (!hasCode(error, "EEXIST")) throw error;
        });
        info = await lstat(current);
      }
      if (info.isSymbolicLink()) return refuse("folder", `the worktree folder passes through a link: ${part}`);
      if (!info.isDirectory()) return refuse("folder", `the worktree folder passes through something that is not a folder: ${part}`);
    } catch (error) {
      return refuse("folder", (error as Error).message);
    }
  }
  const inside = (await real(current)).startsWith(`${root}${sep}`);
  return inside ? ok(current) : refuse("folder", "the worktree folder is outside the repo");
}

/** Makes the trial's detached worktree at `commit` (a full object id). The folder is checked first and added to the repo's git exclude. */
export async function createTrialWorktree(git: Git, repo: WorktreeRepo, trialId: string, commit: string): Promise<Result<string, WorktreeError>> {
  const folder = await checkTrialFolder(repo, { create: true });
  if (!folder.ok) return folder;
  const excluded = await excludeFolder(git, repo);
  if (!excluded.ok) return excluded;
  const path = join(folder.value, trialFolderName(trialId));
  const added = await git.worktreeAddDetached(repo.path, path, commit);
  if (!added.ok) {
    await removeTrialWorktree(git, repo.path, path);
    return refuse("add", added.error.message);
  }
  return ok(path);
}

/**
 * Removes a trial worktree, changes included. Refuses any path whose name is not
 * `try-<8 hex>` or whose parent folder is not inside the repo (any depth: the worktree folder may
 * be nested); removes only the entry git lists as detached at that path. A folder git no longer knows is removed when it is empty.
 */
export async function removeTrialWorktree(git: Git, repoPath: string, path: string): Promise<Result<void, WorktreeError>> {
  if (!TRIAL_NAME.test(basename(path))) return refuse("remove", `not a trial worktree: ${basename(path)}`);
  const repoReal = await real(repoPath);
  const parent = await real(dirname(path));
  if (!parent.startsWith(`${repoReal}${sep}`)) return refuse("remove", "the trial worktree is outside the repo");
  const target = join(parent, basename(path));
  const listed = await git.worktreeList(repoPath);
  if (!listed.ok) return refuse("remove", listed.error.message);
  const entries = [];
  for (const entry of listed.value) if (entry.branch === undefined && (await real(entry.path)) === target) entries.push(entry);
  const removed = await removeEntries(git, repoPath, entries, true);
  if (!removed.ok) return removed;
  // Only an empty folder goes: git's own removal handles the rest, and a folder git does not list is not ours to delete with content.
  await rmdir(target).catch(() => undefined);
  return ok(undefined);
}
