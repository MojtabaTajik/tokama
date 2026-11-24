// Tamper checks: hash the protected files before a step and again after it; any difference is a
// tamper event that names the files. Protected:
// - git: the shared git dir's config, config.worktree, hooks/ and info/ attributes and exclude,
//   the worktree's config.worktree and HEAD, the item branch's commit, and the worktree's `.git`
//   file. These steer Tokama's own git calls and what gets committed; a commit or checkout made
//   by an agent or a check moves HEAD or the branch. The config files count by the entries git
//   reads from them, in file order, without the remote and tracking keys a `git push -u` or
//   `git remote set-url` writes (IGNORED_KEYS); every other key counts. Files they include count
//   by content. The rest by content.
// - tokama: `.tokama/` in the worktree and in the main repo (minus the worktree folder).
// - in the worktree, see protected.ts: base-commit tests and snapshots, test config, package
//   config, CI files, lockfiles, .gitattributes. Pattern files are found in the base commit, in
//   `git status`, and by a bounded walk of the folder (skipping .git and node_modules), so an
//   ignore rule cannot hide one.
// Symlinks are hashed by their target string and never followed. Records hold no absolute paths:
// each file is an area plus a path relative to it.
import { createHash } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { readTextFile } from "../../kernel/fs-safe/index.js";
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
  /** The item branch, e.g. `tokama/0b9f12ab`. */
  readonly branch: string;
  /** Limits of the worktree walk. Default: 8 folders deep, 50 000 entries. */
  readonly walkLimits?: WalkLimits;
}

export interface WalkLimits {
  readonly maxDepth: number;
  readonly maxEntries: number;
}

export interface ProtectedSet {
  /**
   * Hashes every protected file as it is now. An error when the set cannot be read whole (git
   * status fails, e.g. after the `.git` file changed): never compare it; retry or treat it as tamper.
   */
  hash(): Promise<Result<ProtectedHashes, IntegrityError>>;
}

export interface IntegrityError {
  readonly message: string;
}

const SHARED_GIT_FILES = ["config", "config.worktree", "info/attributes", "info/exclude"];
/**
 * The only config keys that do not count, by section and variable name (lowercase, as git lists
 * them): where to fetch and push and what a branch tracks. Every other `remote.<name>.*` and
 * `branch.<name>.*` key counts; `uploadpack`, `receivepack` and `vcs` name commands git runs.
 */
const IGNORED_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  remote: new Set(["url", "pushurl", "fetch", "push", "tagopt", "prune"]),
  branch: new Set(["remote", "merge", "pushremote", "rebase"]),
};
/** Bounds on included config files: nesting depth, files in all, bytes each. */
const MAX_INCLUDE_DEPTH = 5;
const MAX_INCLUDED_FILES = 50;
const MAX_INCLUDE_BYTES = 1024 * 1024;
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

/** A `config --list` record split at its first line break: the key, and the value unless the key stands alone. */
function splitRecord(record: string): { key: string; value: string | undefined } {
  const newline = record.indexOf("\n");
  return newline === -1 ? { key: record, value: undefined } : { key: record.slice(0, newline), value: record.slice(newline + 1) };
}

/** By section and variable name: a subsection may hold dots, so they are the first and last parts. */
function ignoredKey(key: string): boolean {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  // No subsection (e.g. remote.pushdefault): counts.
  if (first === -1 || first === last) return false;
  return IGNORED_KEYS[key.slice(0, first)]?.has(key.slice(last + 1)) === true;
}

/** Whether git reads another config file from this key: `include.path` or `includeIf.<condition>.path`. */
const includeKey = (key: string): boolean =>
  key === "include.path" || (key.startsWith("includeif.") && key.endsWith(".path") && key.length > "includeif..path".length);

/**
 * An include path as git resolves it: absolute, or relative to the including file's folder.
 * Undefined for a form this check does not resolve (`~/`, whose home is git's, `~user/`,
 * `%(prefix)/`, no value or an empty one): the check then fails closed.
 */
function resolveInclude(value: string | undefined, including: string): string | undefined {
  if (value === undefined || value === "" || value.startsWith("~") || value.startsWith("%(")) return undefined;
  return resolve(dirname(including), value);
}

/**
 * Content hashes of the files `records` (read from `including`) include, depth first in file
 * order, each followed by the files it includes. Every include condition counts, matched or not.
 * An error when an included file cannot be read whole or a bound is passed: the check fails closed.
 */
async function includedHashes(git: Git, records: readonly string[], including: string, depth: number, count: { files: number }): Promise<Result<string[], string>> {
  const hashes: string[] = [];
  for (const record of records) {
    const { key, value } = splitRecord(record);
    if (!includeKey(key)) continue;
    if (depth >= MAX_INCLUDE_DEPTH) return err(`includes nested more than ${MAX_INCLUDE_DEPTH} deep`);
    if (++count.files > MAX_INCLUDED_FILES) return err(`more than ${MAX_INCLUDED_FILES} included files`);
    const path = resolveInclude(value, including);
    if (path === undefined) return err(`cannot resolve the path of ${key}`);
    // Never follows a symlink; a file git would skip (missing) fails the check too.
    const text = await readTextFile(path, { maxBytes: MAX_INCLUDE_BYTES });
    if (!text.ok) return err(`cannot read the file ${key} names (${text.error.reason})`);
    const listed = await git.configList(path);
    if (!listed.ok) return err(`the file ${key} names is not valid git config`);
    hashes.push(createHash("sha256").update(text.value).digest("hex"));
    const nested = await includedHashes(git, listed.value, path, depth + 1, count);
    if (!nested.ok) return nested;
    hashes.push(...nested.value);
  }
  return ok(hashes);
}

/**
 * A stable hash of a git config file's entries and of the content of the files it includes, or
 * of the path as hashPath gives it when it is not a regular file. An error when git cannot read
 * the file or a file it includes: never "absent". `name` names the file in errors (no absolute path).
 */
async function hashConfig(git: Git, path: string, name: string): Promise<Result<string | undefined, IntegrityError>> {
  const plain = await hashPath(path);
  if (plain === undefined || !plain.startsWith("sha256:")) return ok(plain);
  const listed = await git.configList(path);
  if (!listed.ok) return err({ message: `cannot read git config: ${listed.error.message}` });
  const counted = listed.value.filter((record) => !ignoredKey(splitRecord(record).key));
  const included = await includedHashes(git, listed.value, path, 0, { files: 0 });
  if (!included.ok) return err({ message: `cannot read git config ${name}: ${included.error}` });
  return ok(`config:${createHash("sha256").update(JSON.stringify([counted, included.value])).digest("hex")}`);
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

const WALK_SKIP = new Set([".git", "node_modules"]);
const DEFAULT_WALK_LIMITS: WalkLimits = { maxDepth: 8, maxEntries: 50_000 };

/**
 * Files under `root`, breadth first; skips .git and node_modules and never enters a symlinked
 * folder. Undefined when a limit stopped the walk before it saw everything (fails closed).
 */
async function boundedWalk(root: string, limits: WalkLimits): Promise<string[] | undefined> {
  const files: string[] = [];
  let level = [""];
  let read = 0;
  for (let depth = 0; level.length > 0; depth++) {
    if (depth > limits.maxDepth) return undefined;
    const next: string[] = [];
    for (const dir of level) {
      const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => [] as Dirent[]);
      read += entries.length;
      if (read > limits.maxEntries) return undefined;
      for (const entry of entries) {
        const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (!WALK_SKIP.has(entry.name)) next.push(path);
        } else files.push(path);
      }
    }
    level = next;
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

  const worktreeGitPrefix = worktreeGitDir === "" ? "" : `${worktreeGitDir}/`;
  const branchRef = `refs/heads/${input.branch}`;
  // Hashed by the entries git reads from them, not their bytes.
  const configs = new Set(["config", "config.worktree", ...(worktreeGitDir === "" ? [] : [`${worktreeGitPrefix}config.worktree`])]);

  async function hash(): Promise<Result<ProtectedHashes, IntegrityError>> {
    const status = await git.status(input.worktreePath);
    if (!status.ok) return err({ message: `cannot read the worktree's status: ${status.error.message}` });
    const changed = status.value.map((entry) => entry.path);

    const files = new Map<string, ProtectedFile>();
    const add = (area: ProtectedArea, path: string, category: ProtectedCategory) => files.set(`${area}:${path}`, { area, path, category });

    for (const path of SHARED_GIT_FILES) add("git", path, "git");
    for (const dir of SHARED_GIT_DIRS) for (const path of await walk(commonDir, dir, undefined)) add("git", path, "git");
    if (worktreeGitDir !== "") add("git", `${worktreeGitPrefix}config.worktree`, "git");
    add("git", `${worktreeGitPrefix}HEAD`, "git");
    add("worktree", ".git", "git");

    for (const path of await walk(input.repoPath, TOKAMA_DIR, worktreeFolder)) add("repo", path, "tokama");

    for (const { path, category } of baseFiles) add("worktree", path, category);
    // Pattern files wherever they are now: tracked in the base commit, changed or untracked (git
    // status), or on disk (bounded walk; the CI and `.tokama` folders whole).
    const walked = await boundedWalk(input.worktreePath, input.walkLimits ?? DEFAULT_WALK_LIMITS);
    if (walked === undefined) return err({ message: "the worktree is too large or too deep to check whole" });
    const candidates = [...baseTree, ...changed, ...walked];
    for (const dir of [...CI_DIRS, TOKAMA_DIR]) candidates.push(...(await walk(input.worktreePath, dir, undefined)));
    for (const path of candidates) {
      // Installed dependencies, not the repo's own config.
      if (path.split("/").includes("node_modules")) continue;
      const category = patternCategory(path);
      if (category !== undefined) add("worktree", path, category);
    }

    const roots: Record<ProtectedArea, string> = { git: commonDir, repo: input.repoPath, worktree: input.worktreePath };
    const hashes = new Map<string, ProtectedFile & { hash: string }>();
    for (const [key, file] of files) {
      const path = join(roots[file.area], ...file.path.split("/"));
      let hashed: string | undefined;
      if (file.area === "git" && configs.has(file.path)) {
        const config = await hashConfig(git, path, file.path);
        if (!config.ok) return config;
        hashed = config.value;
      } else hashed = await hashPath(path);
      if (hashed !== undefined) hashes.set(key, { ...file, hash: hashed });
    }
    // The branch may live in packed-refs: hash the commit it names, not a file.
    const tip = await git.revParse(input.worktreePath, branchRef);
    if (tip.ok) hashes.set(`git:${branchRef}`, { area: "git", path: branchRef, category: "git", hash: `commit:${tip.value}` });
    return ok(hashes);
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
