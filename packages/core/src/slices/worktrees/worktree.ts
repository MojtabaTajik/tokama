// One worktree and branch per item and repo: `tokama/<short id>` from the repo's base branch, in
// `<repo>/<worktree folder>/<short id>`, with the worktree folder in the repo's git exclude. A
// stopped or failed item keeps its worktree; `discardWorktree` removes it with its branch, and
// `removeWorktree` removes a finished item's worktree after its commit (the branch stays). Both
// can run again after a partial run: a missing entry is done, a missing folder is pruned.
import { constants } from "node:fs";
import { mkdir, open, readFile, realpath } from "node:fs/promises";
import { join, posix } from "node:path";
import type { Git, GitError, WorktreeEntry } from "../../kernel/git/index.js";
import { err, ok, type Result } from "../../kernel/result/index.js";
import type { ItemId } from "../../kernel/schemas/index.js";
import { hasCode } from "../../kernel/errno/index.js";

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

export type WorktreeErrorReason =
  | "base-branch"
  /** The item branch exists already; it is never deleted or reused. */
  | "exists"
  | "exclude"
  | "add"
  | "remove"
  | "branch-delete";

export interface WorktreeError {
  readonly reason: WorktreeErrorReason;
  readonly message: string;
}

const fail = (reason: WorktreeErrorReason, error: GitError | Error): Result<never, WorktreeError> => err({ reason, message: error.message });

/** The last 8 hex digits of the item's UUID (its random part; a UUIDv7 starts with a timestamp). */
export const shortItemId = (itemId: ItemId): string => itemId.slice(-8);

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
    const current = await readFile(file, "utf8").catch((error: unknown) => {
      if (hasCode(error, "ENOENT")) return "";
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

/** The real path, or the path itself when it does not exist. */
const real = (path: string) => realpath(path).catch(() => path);

/** The listed worktree entries at `path` or on `branch`. */
async function entriesFor(git: Git, repoPath: string, path: string, branch: string): Promise<Result<WorktreeEntry[], WorktreeError>> {
  const listed = await git.worktreeList(repoPath);
  if (!listed.ok) return fail("remove", listed.error);
  const target = await real(path);
  const found: WorktreeEntry[] = [];
  for (const entry of listed.value) {
    if (entry.branch === `refs/heads/${branch}` || (await real(entry.path)) === target) found.push(entry);
  }
  return ok(found);
}

/** Removes listed entries: pruned when the folder is gone, else removed (with `force`, changes too). */
async function removeEntries(git: Git, repoPath: string, entries: readonly WorktreeEntry[], force: boolean): Promise<Result<void, WorktreeError>> {
  for (const entry of entries) {
    const gone = await realpath(entry.path).then(
      () => false,
      () => true,
    );
    const removed = gone ? await git.worktreePrune(repoPath) : await git.worktreeRemove(repoPath, entry.path, { force });
    if (!removed.ok) return fail("remove", removed.error);
  }
  return ok(undefined);
}

/** Creates the item's branch from the base branch and checks it out in a new worktree. */
export async function createWorktree(git: Git, repo: WorktreeRepo, itemId: ItemId): Promise<Result<ItemWorktree, WorktreeError>> {
  const base = await git.revParse(repo.path, `${repo.baseBranch}^{commit}`);
  if (!base.ok) return fail("base-branch", base.error);
  const branch = itemBranch(itemId);
  if ((await git.revParse(repo.path, `refs/heads/${branch}`)).ok) {
    return err({ reason: "exists", message: `branch ${branch} exists already` });
  }
  const excluded = await excludeFolder(git, repo);
  if (!excluded.ok) return excluded;
  const worktree: ItemWorktree = {
    branch,
    folder: posix.join(normalizeFolder(repo.worktreeFolder), shortItemId(itemId)),
    baseCommit: base.value,
  };
  try {
    await mkdir(join(repo.path, ...normalizeFolder(repo.worktreeFolder).split("/")), { recursive: true });
  } catch (error) {
    return fail("add", error as Error);
  }
  const path = worktreePath(repo.path, worktree);
  const added = await git.worktreeAdd(repo.path, path, branch, worktree.baseCommit);
  if (!added.ok) {
    // Undo what this call made: the branch did not exist before it, so only a worktree on that
    // branch is ours. Another worktree registered at the path is left alone.
    const entries = await entriesFor(git, repo.path, path, branch);
    if (entries.ok) await removeEntries(git, repo.path, entries.value.filter((entry) => entry.branch === `refs/heads/${branch}`), true);
    if ((await git.revParse(repo.path, `refs/heads/${branch}`)).ok) await git.branchDelete(repo.path, branch);
    return fail("add", added.error);
  }
  return ok(worktree);
}

/**
 * The item's worktree when git has it registered at the item's folder on the item's branch, with
 * the branch's commit as its base: for a start that crashed after `createWorktree` and before the
 * worktree was recorded. Only for an item that has not started a step, so nothing ran in it.
 */
export async function findItemWorktree(git: Git, repo: WorktreeRepo, itemId: ItemId): Promise<Result<ItemWorktree | undefined, WorktreeError>> {
  const branch = itemBranch(itemId);
  const folder = posix.join(normalizeFolder(repo.worktreeFolder), shortItemId(itemId));
  const listed = await git.worktreeList(repo.path);
  if (!listed.ok) return fail("add", listed.error);
  const target = await real(worktreePath(repo.path, { folder }));
  for (const entry of listed.value) {
    if (entry.branch === `refs/heads/${branch}` && entry.head !== undefined && (await real(entry.path)) === target) {
      return ok({ branch, folder, baseCommit: entry.head });
    }
  }
  return ok(undefined);
}

/**
 * Removes a finished item's worktree; the branch stays. Without `force` it is refused while the
 * worktree has changes (after a commit, those are files the checks wrote).
 */
export async function removeWorktree(
  git: Git,
  repoPath: string,
  worktree: ItemWorktree,
  options: { readonly force?: boolean } = {},
): Promise<Result<void, WorktreeError>> {
  const path = await real(worktreePath(repoPath, worktree));
  const listed = await git.worktreeList(repoPath);
  if (!listed.ok) return fail("remove", listed.error);
  const entries: WorktreeEntry[] = [];
  for (const entry of listed.value) if ((await real(entry.path)) === path) entries.push(entry);
  return removeEntries(git, repoPath, entries, options.force === true);
}

/**
 * Throws away the item's work: removes its worktree, changes included, and deletes its branch.
 * The worktree is found by its folder or its branch, so one whose branch an agent switched is
 * removed too.
 */
export async function discardWorktree(git: Git, repoPath: string, worktree: ItemWorktree): Promise<Result<void, WorktreeError>> {
  const entries = await entriesFor(git, repoPath, worktreePath(repoPath, worktree), worktree.branch);
  if (!entries.ok) return entries;
  const removed = await removeEntries(git, repoPath, entries.value, true);
  if (!removed.ok) return removed;
  const exists = await git.revParse(repoPath, `refs/heads/${worktree.branch}`);
  if (!exists.ok) return ok(undefined);
  const deleted = await git.branchDelete(repoPath, worktree.branch);
  return deleted.ok ? ok(undefined) : fail("branch-delete", deleted.error);
}
