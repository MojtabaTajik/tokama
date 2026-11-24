// One worktree and branch per item and repo: `tokama/<short id>` from the repo's base branch, in
// `<repo>/<worktree folder>/<short id>`, with the worktree folder in the repo's git exclude. A
// stopped or failed item keeps its worktree; `discardWorktree` removes it with its branch, and
// `removeWorktree` removes a finished item's worktree after its commit (the branch stays).
import { constants } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { Git, GitError } from "../../kernel/git/index.js";
import { err, ok, type Result } from "../../kernel/result/index.js";
import type { ItemId } from "../../kernel/schemas/index.js";

/** The repo settings a worktree needs; the config slice's `Repo` fits. */
export interface WorktreeRepo {
  /** Absolute path of the repo on this machine. */
  readonly path: string;
  readonly baseBranch: string;
  /** Relative to the repo. */
  readonly worktreeFolder: string;
}

/** An item's worktree, as the item record keeps it. No absolute paths: `folder` is relative to the repo. */
export interface ItemWorktree {
  readonly branch: string;
  /** Relative to the repo, "/" separators. */
  readonly folder: string;
  /** The commit the branch started from. */
  readonly baseCommit: string;
}

export type WorktreeErrorReason = "base-branch" | "exclude" | "add" | "remove" | "branch-delete";

export interface WorktreeError {
  readonly reason: WorktreeErrorReason;
  readonly message: string;
}

const fail = (reason: WorktreeErrorReason, error: GitError | Error): Result<never, WorktreeError> => err({ reason, message: error.message });

/** The first 8 hex digits of the item's UUID: `item_0b9f12ab-...` gives `0b9f12ab`. */
export const shortItemId = (itemId: ItemId): string => itemId.slice("item_".length, "item_".length + 8);

export const itemBranch = (itemId: ItemId): string => `tokama/${shortItemId(itemId)}`;

const normalizeFolder = (folder: string) => posix.normalize(folder.replaceAll("\\", "/")).replace(/^\.\/|\/+$/g, "");

/** Absolute path of an item's worktree on this machine. */
export const worktreePath = (repoPath: string, worktree: Pick<ItemWorktree, "folder">): string => join(repoPath, ...worktree.folder.split("/"));

/** Adds `/<folder>/` to the repo's shared `info/exclude` unless that line is there already. */
async function excludeFolder(git: Git, repo: WorktreeRepo): Promise<Result<void, WorktreeError>> {
  const dirs = await git.gitDirs(repo.path);
  if (!dirs.ok) return fail("exclude", dirs.error);
  const line = `/${normalizeFolder(repo.worktreeFolder)}/`;
  const infoDir = join(dirs.value.commonDir, "info");
  const file = join(infoDir, "exclude");
  try {
    const current = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (current.split(/\r?\n/).some((existing) => existing.trim() === line)) return ok(undefined);
    await mkdir(infoDir, { recursive: true });
    const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o644);
    try {
      await handle.writeFile(`${current === "" || current.endsWith("\n") ? "" : "\n"}${line}\n`);
    } finally {
      await handle.close();
    }
    return ok(undefined);
  } catch (error) {
    return fail("exclude", error as Error);
  }
}

/** Creates the item's branch from the base branch and checks it out in a new worktree. */
export async function createWorktree(git: Git, repo: WorktreeRepo, itemId: ItemId): Promise<Result<ItemWorktree, WorktreeError>> {
  const base = await git.revParse(repo.path, `${repo.baseBranch}^{commit}`);
  if (!base.ok) return fail("base-branch", base.error);
  const excluded = await excludeFolder(git, repo);
  if (!excluded.ok) return excluded;
  const worktree: ItemWorktree = {
    branch: itemBranch(itemId),
    folder: posix.join(normalizeFolder(repo.worktreeFolder), shortItemId(itemId)),
    baseCommit: base.value,
  };
  try {
    await mkdir(join(repo.path, ...normalizeFolder(repo.worktreeFolder).split("/")), { recursive: true });
  } catch (error) {
    return fail("add", error as Error);
  }
  const added = await git.worktreeAdd(repo.path, worktreePath(repo.path, worktree), worktree.branch, worktree.baseCommit);
  if (!added.ok) return fail("add", added.error);
  return ok(worktree);
}

/** Removes a finished item's worktree. Refused while it has uncommitted changes; the branch stays. */
export async function removeWorktree(git: Git, repoPath: string, worktree: ItemWorktree): Promise<Result<void, WorktreeError>> {
  const removed = await git.worktreeRemove(repoPath, worktreePath(repoPath, worktree));
  return removed.ok ? ok(undefined) : fail("remove", removed.error);
}

/** Throws away the item's work: removes its worktree, changes included, and deletes its branch. */
export async function discardWorktree(git: Git, repoPath: string, worktree: ItemWorktree): Promise<Result<void, WorktreeError>> {
  const path = worktreePath(repoPath, worktree);
  const listed = await git.worktreeList(repoPath);
  if (!listed.ok) return fail("remove", listed.error);
  const branchRef = `refs/heads/${worktree.branch}`;
  if (listed.value.some((entry) => entry.branch === branchRef)) {
    const removed = await git.worktreeRemove(repoPath, path, { force: true });
    if (!removed.ok) return fail("remove", removed.error);
  }
  const exists = await git.revParse(repoPath, branchRef);
  if (!exists.ok) return ok(undefined);
  const deleted = await git.branchDelete(repoPath, worktree.branch);
  return deleted.ok ? ok(undefined) : fail("branch-delete", deleted.error);
}
