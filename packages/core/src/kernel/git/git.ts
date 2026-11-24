import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok, type Result } from "../result/index.js";
import type { ProcessRunner } from "../process/index.js";

// A repo's config, hooks and attributes may be written by an agent or come from a cloned repo.
// None of them may make Tokama's own git calls run code. Every call gets these settings:
// no fsmonitor, no hooks, no external diff, no pager, no signing (a signing agent would block an
// unattended run on a prompt), and no automatic gc (it can daemonize and outlive the call).
export const GIT_SAFE_CONFIG: readonly string[] = [
  "core.fsmonitor=false",
  "core.hooksPath=/dev/null",
  "diff.external=",
  "core.pager=cat",
  "commit.gpgsign=false",
  "tag.gpgsign=false",
  "gc.auto=0",
  "maintenance.auto=false",
];

/**
 * On every diff form: no external diff driver (diff.<driver>.command), no textconv, no color, and
 * a nested repo shown as a commit range only (`diff.submodule=diff` would run a diff inside it,
 * with that repo's own drivers).
 */
export const DIFF_SAFE: readonly string[] = ["--no-ext-diff", "--no-textconv", "--no-color", "--submodule=short"];

/**
 * The oldest git the wrapper supports: GIT_NO_LAZY_FETCH needs 2.44 (`worktree list -z` needs
 * 2.36). Older git ignores the variable, so a partial clone could fetch through repo config.
 */
export const MIN_GIT_VERSION = { major: 2, minor: 44 } as const;

/**
 * Variables added to the process runner's allowlisted environment. Git never prompts; editor and
 * askpass variables are not in the allowlist, so they never reach git. No lazy fetch: in a partial
 * clone, a missing object would otherwise make a local call (diff, worktree add) fetch it through
 * the repo's remote config (uploadpack, sshCommand, credential helper). Such a call fails instead.
 *
 * Known gap (#25): a repo nested in the worktree (an embedded repo or submodule) has its own config.
 * git runs `status` inside it as a child process, which gets the settings above but not that
 * repo's filter overrides, so a filter configured there can run.
 *
 * No optional locks: `status` polled while an agent works would otherwise refresh the index and
 * take its lock, and an agent's own git call could then fail on index.lock.
 */
export const GIT_ENV: Readonly<Record<string, string>> = { GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" };

const FILTER_KEYS = ["clean", "smudge", "process"] as const;

export type GitErrorReason =
  /** git did not start (not installed, bad cwd). */
  | "spawn-error"
  | "timed-out"
  /** git exited non-zero. */
  | "failed"
  /** An argument was refused before git ran (e.g. it starts with "-" and would be read as an option). */
  | "invalid-argument"
  /**
   * The repo config names a filter driver that cannot be disabled safely, or a required one that
   * git refused to skip; no filter ran.
   */
  | "unsafe-config"
  /** git is older than MIN_GIT_VERSION, or its version could not be read. */
  | "unsupported-version";

export interface GitError {
  readonly reason: GitErrorReason;
  /** The git arguments after the safe config, e.g. ["commit", "-q", ...]. */
  readonly args: readonly string[];
  readonly exitCode: number | null;
  /** git's stderr (capped) or the refusal message. */
  readonly message: string;
}

export type GitResult<T> = Result<T, GitError>;

/** One `git status --porcelain -z` entry. */
export interface StatusEntry {
  /** Index status letter (porcelain v1 X). */
  readonly index: string;
  /** Worktree status letter (porcelain v1 Y). */
  readonly worktree: string;
  readonly path: string;
  /** Source path of a rename or copy. */
  readonly origPath?: string;
}

/** One `git diff --numstat` line. Counts are null for binary files. */
export interface NumstatEntry {
  readonly path: string;
  readonly added: number | null;
  readonly removed: number | null;
}

export interface WorktreeEntry {
  readonly path: string;
  /** Absent in a bare repo or before the first commit. */
  readonly head?: string;
  /** Full ref, e.g. refs/heads/main; absent when detached. */
  readonly branch?: string;
  readonly detached: boolean;
  readonly bare: boolean;
}

export interface Git {
  /** `status --porcelain -z --untracked-files=all`. */
  status(repo: string): Promise<GitResult<StatusEntry[]>>;
  /** `add -A`. */
  addAll(repo: string): Promise<GitResult<void>>;
  /** `diff --cached --numstat -z --no-renames`. */
  diffCachedNumstat(repo: string): Promise<GitResult<NumstatEntry[]>>;
  /** Unified diff of the worktree against the index, or of the index against HEAD with `cached`. */
  diff(repo: string, options?: { readonly cached?: boolean }): Promise<GitResult<string>>;
  /**
   * `clean -ffdX` at the top of a linked worktree: removes ignored files and folders (installed
   * dependencies too, nested repos included), so a check cannot run a tool an agent swapped in
   * there. Refused unless `repo` is the top of a linked worktree, so a missing or replaced `.git`
   * file can never point the clean at the main repo.
   */
  cleanIgnored(repo: string): Promise<GitResult<void>>;
  /** `write-tree`: the tree id of the index. */
  writeTree(repo: string): Promise<GitResult<string>>;
  /** `commit -q --no-verify -m <message>` of the index; returns the new commit id. */
  commit(repo: string, message: string): Promise<GitResult<string>>;
  /** `commit-tree <tree> -p <parent> -m <message>`: a commit of exactly `tree`; returns its id. No ref moves. */
  commitTree(repo: string, tree: string, parent: string, message: string): Promise<GitResult<string>>;
  /** `update-ref <ref> <newId> <oldId>`: moves `ref` (under refs/) only if it still points at `oldId`. */
  updateRef(repo: string, ref: string, newId: string, oldId: string): Promise<GitResult<void>>;
  /** `rev-parse --verify <rev>`: the object id `rev` names. */
  revParse(repo: string, rev: string): Promise<GitResult<string>>;
  /**
   * `worktree add --no-checkout -b <branch> <path> <startPoint>`, then `reset --hard` inside the
   * new worktree, so the filter overrides come from the config that worktree sees (includeIf
   * gitdir, config.worktree).
   */
  worktreeAdd(repo: string, path: string, branch: string, startPoint: string): Promise<GitResult<void>>;
  /**
   * Without `force`: refuses a worktree with changes or untracked files (checked by `status`
   * inside it). Then `worktree remove --force <path>`; a locked worktree is still refused.
   */
  worktreeRemove(repo: string, path: string, options?: { readonly force?: boolean }): Promise<GitResult<void>>;
  /** `worktree list --porcelain -z`. */
  worktreeList(repo: string): Promise<GitResult<WorktreeEntry[]>>;
  /** `worktree prune`: drops entries whose folder is gone. */
  worktreePrune(repo: string): Promise<GitResult<void>>;
  /** `branch -D <branch>`: deletes a local branch, merged or not. */
  branchDelete(repo: string, branch: string): Promise<GitResult<void>>;
  /** `ls-tree -r -z --name-only --full-tree <rev>`: every file path in the tree of `rev`. */
  lsTree(repo: string, rev: string): Promise<GitResult<string[]>>;
  /**
   * Absolute paths of the repo's git dir and of its common dir. In a linked worktree the git dir
   * is `<common>/worktrees/<name>`; in the main worktree both are the same.
   */
  gitDirs(repo: string): Promise<GitResult<GitDirs>>;
  /** `git --version`, refused below MIN_GIT_VERSION. The engine calls it once at startup. */
  checkGitVersion(): Promise<GitResult<string>>;
}

export interface GitDirs {
  readonly gitDir: string;
  readonly commonDir: string;
}

export interface GitOptions {
  readonly runner: ProcessRunner;
  /** Default: "git", found on the allowlisted PATH. */
  readonly gitPath?: string;
  /** Per git call. Default: 120 s. */
  readonly timeoutMs?: number;
}

const STDERR_CAP = 4_000;

export function createGit(options: GitOptions): Git {
  const gitPath = options.gitPath ?? "git";
  const timeoutMs = options.timeoutMs ?? 120_000;
  const safe = (config: readonly string[]) => config.flatMap((setting) => ["-c", setting]);

  /** Runs git with the safe config plus `extraConfig`; stdout comes back whole, through a temp file. */
  async function raw(repo: string, args: readonly string[], extraConfig: readonly string[] = []) {
    const dir = await mkdtemp(join(tmpdir(), "tokama-git-"));
    try {
      const stdoutFile = join(dir, "stdout");
      const stderr: string[] = [];
      let stderrLength = 0;
      const result = await options.runner.run({
        command: { argv: [gitPath, "--no-pager", ...safe(GIT_SAFE_CONFIG), ...safe(extraConfig), ...args] },
        cwd: repo,
        env: GIT_ENV,
        timeoutMs,
        stdout: { file: stdoutFile },
        stderr: {
          onLine: (line) => {
            if (stderrLength >= STDERR_CAP) return;
            stderr.push(line);
            stderrLength += line.length + 1;
          },
        },
      });
      const failure = (reason: GitErrorReason, exitCode: number | null, message: string): GitResult<string> =>
        err({ reason, args, exitCode, message });
      if (result.kind === "not-started") return failure("spawn-error", null, result.message);
      const stdout = await readFile(stdoutFile, "utf8");
      // Some failures are reported on stdout only (commit: "nothing to commit").
      const message = (stderr.length > 0 ? stderr.join("\n") : stdout).slice(0, STDERR_CAP);
      if (result.timedOut) return failure("timed-out", result.exitCode, message);
      if (result.exitCode !== 0) return failure("failed", result.exitCode, message);
      return ok(stdout);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Settings that disable every filter driver the repo itself configures (local or worktree
   * scope, includes too). A clean or smudge filter is a command named by config and chosen by
   * .gitattributes or .git/info/attributes, so `add`, `status`, `diff` and `worktree add` would
   * run it. Drivers only in the user's global or system config (e.g. git-lfs) stay on.
   * `required` is left as configured: git then fails on a required driver (e.g. encryption)
   * instead of storing the plain content.
   */
  async function filterOverrides(
    repo: string,
    args: readonly string[],
  ): Promise<GitResult<{ config: string[]; required: string[] }>> {
    const listed = await raw(repo, ["config", "-z", "--show-scope", "--name-only", "--get-regexp", "^filter\\."]);
    if (!listed.ok) {
      // Exit 1: no filter configured.
      if (listed.error.reason === "failed" && listed.error.exitCode === 1) return ok({ config: [], required: [] });
      return err({ ...listed.error, args });
    }
    const fields = listed.value.split("\0");
    const drivers = new Set<string>();
    const required = new Set<string>();
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const scope = fields[i] ?? "";
      const name = fields[i + 1] ?? "";
      const dot = name.lastIndexOf(".");
      const driver = name.slice("filter.".length, dot);
      if (name.slice(dot + 1) === "required") required.add(driver);
      if (scope === "global" || scope === "system") continue;
      // `-c` splits at the first "="; git also ignores a `-c` override of the empty name. Such a
      // driver cannot be disabled, so nothing runs.
      if (driver === "" || driver.includes("=") || driver.includes("\n")) {
        return err({
          reason: "unsafe-config",
          args,
          exitCode: null,
          message: `filter driver name cannot be disabled safely: ${JSON.stringify(driver)}`,
        });
      }
      drivers.add(driver);
    }
    return ok({
      config: [...drivers].flatMap((driver) => FILTER_KEYS.map((key) => `filter.${driver}.${key}=`)),
      required: [...drivers].filter((driver) => required.has(driver)),
    });
  }

  async function git(repo: string, args: readonly string[]): Promise<GitResult<string>> {
    const overrides = await filterOverrides(repo, args);
    if (!overrides.ok) return overrides;
    const result = await raw(repo, args, overrides.value.config);
    const { required } = overrides.value;
    const refusedRequired =
      !result.ok &&
      result.error.reason === "failed" &&
      required.length > 0 &&
      /filter '.*' failed/.test(result.error.message);
    if (refusedRequired) {
      const names = required.map((driver) => JSON.stringify(driver)).join(", ");
      return err({
        ...result.error,
        reason: "unsafe-config",
        message: `the repo requires filter driver(s) ${names}, which Tokama does not run; git refused: ${result.error.message}`,
      });
    }
    return result;
  }

  const refuseOption = (args: readonly string[], ...values: string[]): GitResult<never> | undefined => {
    const bad = values.find((value) => value === "" || value.startsWith("-"));
    return bad === undefined
      ? undefined
      : err({ reason: "invalid-argument", args, exitCode: null, message: `refused argument: ${JSON.stringify(bad)}` });
  };
  const map = async <T>(result: Promise<GitResult<string>>, parse: (out: string) => T): Promise<GitResult<T>> => {
    const settled = await result;
    return settled.ok ? ok(parse(settled.value)) : settled;
  };
  const none = () => undefined;
  const trimmed = (out: string) => out.trim();

  return {
    status: (repo) => map(git(repo, ["status", "--porcelain", "-z", "--untracked-files=all"]), parseStatus),
    addAll: (repo) => map(git(repo, ["add", "-A"]), none),
    diffCachedNumstat: (repo) =>
      map(git(repo, ["diff", "--cached", "--numstat", "-z", "--no-renames", ...DIFF_SAFE]), parseNumstat),
    diff: (repo, diffOptions = {}) => git(repo, ["diff", ...(diffOptions.cached === true ? ["--cached"] : []), ...DIFF_SAFE]),
    async cleanIgnored(repo) {
      const args = ["clean", "-ffdX"];
      const where = await git(repo, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"]);
      if (!where.ok) return where;
      const [top, gitDir, commonDir] = where.value.split("\n");
      const [realTop, realRepo] = await Promise.all([realpath(top ?? "").catch(() => ""), realpath(repo).catch(() => repo)]);
      if (realTop !== realRepo || gitDir === commonDir) {
        return err({ reason: "invalid-argument", args, exitCode: null, message: `refused: ${repo} is not the top of a linked worktree` });
      }
      return map(git(repo, args), none);
    },
    writeTree: (repo) => map(git(repo, ["write-tree"]), trimmed),
    async commit(repo, message) {
      const committed = await git(repo, ["commit", "-q", "--no-verify", "-m", message]);
      if (!committed.ok) return committed;
      return map(git(repo, ["rev-parse", "--verify", "HEAD"]), trimmed);
    },
    async commitTree(repo, tree, parent, message) {
      const args = ["commit-tree", tree, "-p", parent, "-m", message];
      return refuseOption(args, tree, parent) ?? map(git(repo, args), trimmed);
    },
    async updateRef(repo, ref, newId, oldId) {
      const args = ["update-ref", ref, newId, oldId];
      const refused = refuseOption(args, ref, newId, oldId);
      if (refused !== undefined) return refused;
      if (!ref.startsWith("refs/")) {
        return err({ reason: "invalid-argument", args, exitCode: null, message: `refused ref outside refs/: ${JSON.stringify(ref)}` });
      }
      return map(git(repo, args), none);
    },
    async revParse(repo, rev) {
      const args = ["rev-parse", "--verify", rev];
      return refuseOption(args, rev) ?? map(git(repo, args), trimmed);
    },
    async worktreeAdd(repo, path, branch, startPoint) {
      const args = ["worktree", "add", "-q", "--no-checkout", "-b", branch, "--", path, startPoint];
      const refused = refuseOption(args, path, branch, startPoint);
      if (refused !== undefined) return refused;
      const added = await git(repo, args);
      if (!added.ok) return added;
      // The checkout runs in the new worktree, with overrides for the config it sees.
      return map(git(path, ["reset", "-q", "--hard"]), none);
    },
    async worktreeRemove(repo, path, removeOptions = {}) {
      const args = ["worktree", "remove", "--force", "--", path];
      const refused = refuseOption(args, path);
      if (refused !== undefined) return refused;
      if (removeOptions.force !== true) {
        // git's own clean check runs `status` in the worktree with the main repo's overrides.
        const statusArgs = ["status", "--porcelain", "-z", "--untracked-files=all"];
        const status = await git(path, statusArgs);
        if (!status.ok) return status;
        if (status.value !== "") {
          return err({ reason: "failed", args, exitCode: null, message: `worktree has changes or untracked files: ${path}` });
        }
      }
      // One --force skips the clean check done above; a locked worktree still needs two.
      return map(git(repo, args), none);
    },
    worktreeList: (repo) => map(git(repo, ["worktree", "list", "--porcelain", "-z"]), parseWorktreeList),
    worktreePrune: (repo) => map(git(repo, ["worktree", "prune"]), none),
    async branchDelete(repo, branch) {
      const args = ["branch", "-D", branch];
      return refuseOption(args, branch) ?? map(git(repo, args), none);
    },
    async lsTree(repo, rev) {
      const args = ["ls-tree", "-r", "-z", "--name-only", "--full-tree", rev];
      return refuseOption(args, rev) ?? map(git(repo, args), (out) => out.split("\0").filter((path) => path !== ""));
    },
    gitDirs: (repo) =>
      map(git(repo, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]), (out) => {
        const [gitDir = "", commonDir = ""] = out.split("\n");
        return { gitDir, commonDir };
      }),
    async checkGitVersion() {
      const args = ["--version"];
      const out = await raw(tmpdir(), args);
      if (!out.ok) return out;
      const version = parseGitVersion(out.value);
      const supported =
        version !== undefined &&
        (version.major > MIN_GIT_VERSION.major ||
          (version.major === MIN_GIT_VERSION.major && version.minor >= MIN_GIT_VERSION.minor));
      if (!supported) {
        return err({
          reason: "unsupported-version",
          args,
          exitCode: 0,
          message: `git ${MIN_GIT_VERSION.major}.${MIN_GIT_VERSION.minor} or newer is required; found: ${out.value.trim()}`,
        });
      }
      return ok(out.value.trim());
    },
  };
}

/** Reads major and minor from `git --version` ("git version 2.54.0 (Apple Git-157)"). */
export function parseGitVersion(out: string): { major: number; minor: number } | undefined {
  const match = /^git version (\d+)\.(\d+)/.exec(out.trim());
  return match === null ? undefined : { major: Number(match[1]), minor: Number(match[2]) };
}

/** Parses `status --porcelain -z` (v1): "XY path\0", plus "orig\0" after a rename or copy in either column. */
export function parseStatus(out: string): StatusEntry[] {
  const fields = out.split("\0");
  const entries: StatusEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? "";
    if (field.length < 4) continue;
    const index = field.charAt(0);
    const worktree = field.charAt(1);
    const path = field.slice(3);
    if ("RC".includes(index) || "RC".includes(worktree)) {
      const origPath = fields[++i] ?? "";
      entries.push({ index, worktree, path, origPath });
    } else {
      entries.push({ index, worktree, path });
    }
  }
  return entries;
}

/** Parses `diff --numstat -z --no-renames`: "added\tremoved\tpath\0"; "-" counts mean binary. */
export function parseNumstat(out: string): NumstatEntry[] {
  const count = (value: string) => (value === "-" ? null : Number(value));
  return out
    .split("\0")
    .filter((field) => field !== "")
    .map((field) => {
      const [added = "", removed = "", ...path] = field.split("\t");
      return { path: path.join("\t"), added: count(added), removed: count(removed) };
    });
}

/** Parses `worktree list --porcelain -z`: attribute fields, each worktree ended by an empty field. */
export function parseWorktreeList(out: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: { path: string; head?: string; branch?: string; detached: boolean; bare: boolean } | undefined;
  for (const field of out.split("\0")) {
    if (field === "") {
      if (current !== undefined) entries.push(current);
      current = undefined;
      continue;
    }
    const space = field.indexOf(" ");
    const key = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? "" : field.slice(space + 1);
    if (key === "worktree") current = { path: value, detached: false, bare: false };
    else if (current === undefined) continue;
    else if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value;
    else if (key === "detached") current.detached = true;
    else if (key === "bare") current.bare = true;
  }
  if (current !== undefined) entries.push(current);
  return entries;
}
