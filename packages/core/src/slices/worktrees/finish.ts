// Finish actions on a done item's commit, each a change outside the worktree:
// - `mergeItem` merges the commit into the base branch of the engineer's own checkout: only on
//   that branch, only with no uncommitted changes, and only a fast-forward or a merge without
//   conflicts. The merge is made in the object store (`merge-tree`, `commit-tree`) and the
//   checkout only moves forward to it, so a refusal leaves the checkout as it was. Nothing is
//   stashed or switched. Then the worktree and branch are removed.
// - `pushItem` pushes the commit to the item branch on origin, only while origin points where it
//   did when the worktree was made.
// Each can run again after a crash: a commit already in the base branch is merged, a branch
// already pushed pushes again as a no-op. Messages are plain words without absolute paths.
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { Git } from "../../kernel/git/index.js";
import { err, ok, type Result } from "../../kernel/result/index.js";
import type { ItemId } from "../../kernel/schemas/index.js";
import { overSsh, recordableRemote } from "./remote.js";
import { removeWorktree, type ItemWorktree, type WorktreeRepo } from "./worktree.js";

export interface MergeResult {
  /** The base branch's commit after the merge. */
  readonly commit: string;
  readonly worktreeRemoved: boolean;
  /** Why the worktree or branch was kept. */
  readonly detail?: string;
}

const SUBJECT_MAX = 100;
const LISTED = 5;

const short = (id: string) => id.slice(0, 7);
const list = (paths: readonly string[]) => `${paths.slice(0, LISTED).join(", ")}${paths.length > LISTED ? ` and ${paths.length - LISTED} more` : ""}`;
const shortRef = (ref: string) => ref.replace(/^refs\/heads\//, "");

/** The merge commit's message: `Merge tokama/<id>: <title>` plus the `Tokama-Item` trailer. */
export function mergeMessage(itemId: ItemId, branch: string, title: string): string {
  const oneLine = title.replace(/[\s\p{Cc}]+/gu, " ").trim();
  const subject = oneLine.length > SUBJECT_MAX ? `${oneLine.slice(0, SUBJECT_MAX - 1)}…` : oneLine;
  return `Merge ${branch}${subject === "" ? "" : `: ${subject}`}\n\nTokama-Item: ${itemId}\n`;
}

/** Merges the item's commit into the base branch of the checkout at `repo.path`. */
export async function mergeItem(
  git: Git,
  repo: WorktreeRepo,
  worktree: ItemWorktree,
  item: { readonly id: ItemId; readonly title: string; readonly commit: string },
): Promise<Result<MergeResult, string>> {
  const base = repo.baseBranch;
  const baseRef = `refs/heads/${base}`;
  const baseTip = await git.revParse(repo.path, `${baseRef}^{commit}`);
  if (!baseTip.ok) return err(`The base branch ${base} is not in the repo: ${baseTip.error.message}`);
  const merged = await git.isAncestor(repo.path, item.commit, baseTip.value);
  if (!merged.ok) return err(`Cannot read the item's commit ${short(item.commit)}: ${merged.error.message}`);
  if (merged.value) return cleanUp(git, repo, worktree, item.commit, baseTip.value);

  const tip = await git.revParse(repo.path, `refs/heads/${worktree.branch}`);
  if (!tip.ok) return err(`The branch ${worktree.branch} is gone and its commit is not in ${base}.`);
  if (tip.value !== item.commit) {
    return err(`The branch ${worktree.branch} moved since Tokama committed (it is at ${short(tip.value)}, not ${short(item.commit)}). Merge it yourself, or discard it.`);
  }
  const head = await git.currentRef(repo.path);
  if (!head.ok) return err(`Cannot read which branch your checkout is on: ${head.error.message}`);
  if (head.value !== baseRef) {
    const on = head.value === undefined ? "a detached HEAD" : shortRef(head.value);
    return err(`Your checkout is on ${on}, not ${base}. Switch it to ${base}, then merge again. Tokama does not switch branches for you.`);
  }
  const status = await git.status(repo.path);
  if (!status.ok) return err(`Cannot read your checkout's changes: ${status.error.message}`);
  const changed = status.value.filter((entry) => entry.index !== "?" && entry.index !== "!").map((entry) => entry.path);
  if (changed.length > 0) {
    return err(`Your checkout has uncommitted changes (${list(changed)}). Commit them or set them aside yourself, then merge again. Tokama never stashes or overwrites them.`);
  }

  const fastForward = await git.isAncestor(repo.path, baseTip.value, item.commit);
  if (!fastForward.ok) return err(`Cannot compare ${base} with the item's commit: ${fastForward.error.message}`);
  let target = item.commit;
  if (!fastForward.value) {
    const tree = await git.mergeTree(repo.path, baseTip.value, item.commit);
    if (!tree.ok) return err(`Cannot merge in the object store: ${tree.error.message}`);
    if (!tree.value.clean) {
      return err(`The branch conflicts with ${base} in ${list(tree.value.conflicts)}. Tokama merges only without conflicts: merge it yourself, or open a pull request.`);
    }
    const commit = await git.commitTree(repo.path, tree.value.tree, [baseTip.value, item.commit], mergeMessage(item.id, worktree.branch, item.title));
    if (!commit.ok) return err(`Cannot make the merge commit: ${commit.error.message}`);
    target = commit.value;
  }
  // git's fast-forward replaces ignored files without a word (a local `.env`): refuse when any
  // path the merge writes is there already and the base commit does not track it.
  const untracked = await untrackedInTheWay(git, repo.path, baseTip.value, target);
  if (!untracked.ok) return untracked;
  if (untracked.value.length > 0) {
    return err(`Your checkout has untracked or ignored files where the merge writes (${list(untracked.value)}). Move them away, then merge again; Tokama never overwrites them.`);
  }
  // The checkout may have switched branch while the merge was made: read it again right before.
  const still = await git.currentRef(repo.path);
  if (!still.ok || still.value !== baseRef) return err(`Your checkout left ${base} while Tokama prepared the merge. Nothing was merged; try again.`);
  // git moves the checkout only forward and refuses, without a change, when a local file would be
  // overwritten; a base branch that moved since it was read makes the fast-forward fail too.
  const moved = await git.mergeFastForward(repo.path, target);
  if (!moved.ok) {
    const overwritten = /would be overwritten/.test(moved.error.message);
    return err(
      overwritten
        ? `Your checkout has files the merge would overwrite: ${moved.error.message}. Move them away, then merge again.`
        : `git did not move ${base} forward; your checkout is unchanged: ${moved.error.message}`,
    );
  }
  const after = await git.revParse(repo.path, `${baseRef}^{commit}`);
  if (!after.ok || after.value !== target) {
    return err(`git moved your checkout, but ${base} is not at the merge (${short(target)}): the checkout changed branch meanwhile. Check your branches; Tokama recorded no merge.`);
  }
  return cleanUp(git, repo, worktree, item.commit, target);
}

/**
 * The paths a move from `from` to `to` writes that exist in the checkout although `from` does not
 * track them: the path itself, or a file where the path needs a folder.
 */
async function untrackedInTheWay(git: Git, repoPath: string, from: string, to: string): Promise<Result<string[], string>> {
  const [names, tracked] = await Promise.all([git.diffNames(repoPath, from, to), git.lsTree(repoPath, from)]);
  if (!names.ok) return err(`Cannot list what the merge changes: ${names.error.message}`);
  if (!tracked.ok) return err(`Cannot list the files of the base branch: ${tracked.error.message}`);
  const known = new Set(tracked.value);
  const found = new Set<string>();
  for (const path of names.value) {
    const parts = path.split("/");
    for (let depth = 1; depth <= parts.length; depth++) {
      const prefix = parts.slice(0, depth).join("/");
      const stat = await lstat(join(repoPath, ...parts.slice(0, depth))).catch(() => undefined);
      if (stat === undefined) break;
      const last = depth === parts.length;
      if ((last || !stat.isDirectory()) && !known.has(prefix)) {
        found.add(prefix);
        break;
      }
    }
  }
  return ok([...found].sort());
}

/**
 * Removes the worktree, then the branch while it is still at the merged commit. `worktreeRemoved`
 * is true only when both are gone, so Discard stays on offer for whatever is left.
 */
async function cleanUp(git: Git, repo: WorktreeRepo, worktree: ItemWorktree, commit: string, merged: string): Promise<Result<MergeResult, string>> {
  const removed = await removeWorktree(git, repo.path, worktree);
  if (!removed.ok) {
    return ok({ commit: merged, worktreeRemoved: false, detail: "The worktree was kept: it has files that are not in the commit. Discard it once you no longer need them." });
  }
  const tip = await git.revParse(repo.path, `refs/heads/${worktree.branch}`);
  if (tip.ok && tip.value !== commit) {
    return ok({ commit: merged, worktreeRemoved: false, detail: `The branch ${worktree.branch} was kept: it has commits that were not merged. Discard it once you no longer need them.` });
  }
  if (tip.ok) {
    const deleted = await git.branchDelete(repo.path, worktree.branch);
    if (!deleted.ok) return ok({ commit: merged, worktreeRemoved: false, detail: `The branch ${worktree.branch} could not be deleted: ${deleted.error.message}` });
  }
  return ok({ commit: merged, worktreeRemoved: true });
}

/**
 * origin's push URL as it is recorded; undefined unless origin pushes to exactly one network URL
 * (a push to several would reach places the pin does not name).
 */
export async function originPushUrl(git: Git, repoPath: string): Promise<Result<string | undefined, string>> {
  const urls = await git.remotePushUrls(repoPath, "origin");
  if (!urls.ok) return err(`Cannot read the origin remote: ${urls.error.message}`);
  return ok(urls.value.length === 1 ? recordableRemote(urls.value[0]!) : undefined);
}

/**
 * Pushes the item's commit to its branch on origin, refused unless origin pushes to exactly one
 * URL and that is the pinned one (git pushes to every pushurl). The push names the remote, not
 * the URL: git reads `remote.<url>.*` for a push to a URL, so a section named by the pinned URL
 * could redirect it, and the URL as written keeps its own credentials. The SSH agent socket goes
 * along only when git really pushes over SSH, after its URL rewrites.
 */
export async function pushItem(
  git: Git,
  repoPath: string,
  input: { readonly commit: string; readonly branch: string; readonly pushUrl: string; readonly sshAuthSock?: string },
): Promise<Result<void, string>> {
  const urls = await git.remotePushUrls(repoPath, "origin");
  if (!urls.ok) return err(`Cannot read the origin remote: ${urls.error.message}`);
  const now = urls.value.map((url) => recordableRemote(url) ?? url);
  if (now.length !== 1 || now[0] !== input.pushUrl) {
    const where = now.length === 0 ? "nowhere" : now.join(" and ");
    return err(`origin now pushes to ${where}, not only to ${input.pushUrl} as when the item started. Tokama pushes only where the item started.`);
  }
  // With exactly one push URL, origin's resolved URL is the pinned one after git's rewrites.
  const resolved = await git.remoteResolvedPushUrl(repoPath, "origin");
  if (!resolved.ok) return err(`Cannot read where origin pushes: ${resolved.error.message}`);
  const ssh = input.sshAuthSock !== undefined && overSsh(resolved.value);
  const pushed = await git.push(repoPath, "origin", input.commit, input.branch, ssh ? { sshAuthSock: input.sshAuthSock! } : {});
  return pushed.ok ? ok(undefined) : err(`git could not push ${input.branch}: ${pushed.error.message}`);
}
