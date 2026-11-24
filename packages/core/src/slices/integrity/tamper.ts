// Tamper checks: hash the protected files before a step and again after it; any difference is a
// tamper event that names the files. Protected:
// - git: the shared git dir's config, config.worktree, hooks/ and info/ attributes and exclude,
//   the worktree's config.worktree, and the worktree's `.git` file. These steer Tokama's own git
//   calls and what gets committed.
// - tokama: `.tokama/` in the worktree and in the main repo (minus the worktree folder).
// - in the worktree, see protected.ts: base-commit tests and snapshots, test config, CI files,
//   lockfiles.
// Symlinks are hashed by their target string and never followed. Records hold no absolute paths:
// each file is an area plus a path relative to it.
import { createHash } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import type { Git } from "../../kernel/git/index.js";
import { err, ok, type Result } from "../../kernel/result/index.js";
import { baseCategory, CI_DIRS, patternCategory, type ProtectedCategory, TOKAMA_DIR } from "./protected.js";

export type ProtectedArea =
  /** Relative to the shared (common) git dir. */
  | "git"
  /** Relative to the main repo folder. */
  | "repo"
  /** Relative to the item's worktree. */
  | "worktree";

export interface ProtectedFile {
  readonly area: ProtectedArea;
  /** Relative to the area, "/" separators. */
  readonly path: string;
  readonly category: ProtectedCategory;
}

export interface TamperChange extends ProtectedFile {
  readonly change: "added" | "removed" | "modified";
}

/** Protected files and their hashes, keyed by `<area>:<path>`. */
export type ProtectedHashes = ReadonlyMap<string, ProtectedFile & { readonly hash: string }>;

export interface ProtectedSetInput {
  readonly repoPath: string;
  readonly worktreePath: string;
  /** The repo's worktree folder, relative to the repo; skipped in the repo's `.tokama/`. */
  readonly worktreeFolder: string;
  /** The commit the item branch started from: its test files and snapshots are protected. */
  readonly baseCommit: string;
}

export interface ProtectedSet {
  /** Hashes every protected file as it is now. */
  hash(): Promise<ProtectedHashes>;
}

export interface IntegrityError {
  readonly message: string;
}

const SHARED_GIT_FILES = ["config", "config.worktree", "info/attributes", "info/exclude"];
const SHARED_GIT_DIRS = ["hooks"];

const toPosix = (path: string) => path.split(sep).join("/");

/** A stable hash of one path; undefined when nothing is there. Never follows a symlink. */
async function hashPath(path: string): Promise<string | undefined> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return `link:${await readlink(path)}`;
    if (stat.isDirectory()) return "type:directory";
    if (!stat.isFile()) return "type:special";
    // No symlink swapped in since the lstat; non-blocking, so a FIFO cannot hang the read.
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      return `sha256:${createHash("sha256").update(await handle.readFile()).digest("hex")}`;
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    return `error:${code ?? "unknown"}`;
  }
}

/** Every non-directory under `dir`, as paths relative to `root`; symlinked folders are not entered. */
async function walk(root: string, dir: string, skip: string | undefined): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(join(root, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (path === skip) continue;
    if (entry.isDirectory()) files.push(...(await walk(root, path, skip)));
    else files.push(path);
  }
  return files;
}

/**
 * Resolves what to protect for one item's worktree: its git dirs (once, before an agent can
 * redirect the `.git` file) and the base commit's test files.
 */
export async function protectedSet(git: Git, input: ProtectedSetInput): Promise<Result<ProtectedSet, IntegrityError>> {
  const dirs = await git.gitDirs(input.worktreePath);
  if (!dirs.ok) return err({ message: `cannot find the worktree's git dirs: ${dirs.error.message}` });
  const listed = await git.lsTree(input.worktreePath, input.baseCommit);
  if (!listed.ok) return err({ message: `cannot list the base commit's files: ${listed.error.message}` });
  const { commonDir, gitDir } = dirs.value;
  const worktreeGitDir = toPosix(relative(commonDir, gitDir));
  const baseTree = listed.value;
  const baseFiles = baseTree.flatMap((path) => {
    const category = baseCategory(path);
    return category === undefined ? [] : [{ path, category }];
  });
  const worktreeFolder = posix.normalize(input.worktreeFolder.replaceAll("\\", "/")).replace(/^\.\/|\/+$/g, "");

  async function hash(): Promise<ProtectedHashes> {
    // A broken `.git` file makes status fail; the files below are still hashed, so it shows.
    const status = await git.status(input.worktreePath);
    const changed = status.ok ? status.value.map((entry) => entry.path) : [];

    const files = new Map<string, ProtectedFile>();
    const add = (area: ProtectedArea, path: string, category: ProtectedCategory) => files.set(`${area}:${path}`, { area, path, category });

    for (const path of SHARED_GIT_FILES) add("git", path, "git");
    for (const dir of SHARED_GIT_DIRS) for (const path of await walk(commonDir, dir, undefined)) add("git", path, "git");
    if (worktreeGitDir !== "") add("git", `${worktreeGitDir}/config.worktree`, "git");
    add("worktree", ".git", "git");

    for (const path of await walk(input.repoPath, TOKAMA_DIR, worktreeFolder)) add("repo", path, "tokama");

    for (const { path, category } of baseFiles) add("worktree", path, category);
    // Pattern files wherever they are now: tracked in the base commit, changed or untracked (git
    // status), or at the root and in the CI and `.tokama` folders (read directly, so a file
    // hidden by an ignore rule is still seen there).
    const candidates = [...baseTree, ...changed];
    candidates.push(...(await readdir(input.worktreePath).catch(() => [] as string[])));
    for (const dir of [...CI_DIRS, TOKAMA_DIR]) candidates.push(...(await walk(input.worktreePath, dir, undefined)));
    for (const path of candidates) {
      const category = patternCategory(path);
      if (category !== undefined) add("worktree", path, category);
    }

    const roots: Record<ProtectedArea, string> = { git: commonDir, repo: input.repoPath, worktree: input.worktreePath };
    const hashes = new Map<string, ProtectedFile & { hash: string }>();
    for (const [key, file] of files) {
      const hashed = await hashPath(join(roots[file.area], ...file.path.split("/")));
      if (hashed !== undefined) hashes.set(key, { ...file, hash: hashed });
    }
    return hashes;
  }

  return ok({ hash });
}

/** What changed in the protected set between two hashings, sorted; empty when nothing did. */
export function tamperChanges(before: ProtectedHashes, after: ProtectedHashes): TamperChange[] {
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  return keys.flatMap((key): TamperChange[] => {
    const was = before.get(key);
    const now = after.get(key);
    if (was !== undefined && now !== undefined) {
      return was.hash === now.hash ? [] : [{ area: now.area, path: now.path, category: now.category, change: "modified" }];
    }
    const file = (now ?? was)!;
    return [{ area: file.area, path: file.path, category: file.category, change: now === undefined ? "removed" : "added" }];
  });
}
