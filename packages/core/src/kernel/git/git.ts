import { copyFile, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { hasCode } from "../errno/index.js";
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
 * Added to every call except `push`: no network or remote-helper transport. Local calls never need
 * one, and on git older than 2.44 (which may ignore GIT_NO_LAZY_FETCH) a missing object in a
 * partial clone would otherwise be fetched through the repo's own remote config (uploadpack,
 * sshCommand, credential helper). The environment variable is the one that holds: git reads
 * `protocol.<name>.allow` before `protocol.allow`, so a repo's own config (`protocol.file.allow=always`)
 * overrides the setting, but not GIT_ALLOW_PROTOCOL.
 */
const NO_TRANSPORT = "protocol.allow=never";
const NO_TRANSPORT_ENV: Readonly<Record<string, string>> = { GIT_ALLOW_PROTOCOL: "none" };
/**
 * On every diff form: no external diff driver (diff.<driver>.command), no textconv, no color, and
 * a nested repo shown as a commit range only (`diff.submodule=diff` would run a diff inside it,
 * with that repo's own drivers).
 */
export const DIFF_SAFE: readonly string[] = ["--no-ext-diff", "--no-textconv", "--no-color", "--submodule=short"];

/**
 * Rename detection on, whatever the repo config says, in git's own file order (no orderFile) and
 * over the whole tree (no diff.relative), so every diff form lists the same files in the same order.
 */
const RENAMES: readonly string[] = ["--find-renames", "-O/dev/null", "--no-relative"];

/**
 * The oldest git the wrapper supports. `merge-tree --write-tree --name-only --no-messages -z`
 * needs 2.38; no other call needs more (`worktree list -z` needs 2.36, `rev-parse --path-format`
 * 2.31).
 */
export const MIN_GIT_VERSION = { major: 2, minor: 38 } as const;

/**
 * GIT_NO_LAZY_FETCH needs 2.44. Older git ignores it, so in a partial clone a local call could
 * fetch a missing object through the repo's remote config. See `partialClone`.
 */
export const NO_LAZY_FETCH_GIT_VERSION = { major: 2, minor: 44 } as const;

/**
 * Variables added to the process runner's allowlisted environment. Git never prompts; editor and
 * askpass variables are not in the allowlist, so they never reach git. No lazy fetch: in a partial
 * clone, a missing object would otherwise make a local call (diff, worktree add) fetch it through
 * the repo's remote config (uploadpack, sshCommand, credential helper). Such a call fails instead
 * (git 2.44 or newer; older git is refused on a partial clone, and NO_TRANSPORT backs this up).
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
  /** git's stdout (capped), when git ran and failed: some commands report their result there. */
  readonly stdout?: string;
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

/** One entry of `git diff-tree --raw`: a path that differs between two trees. */
export interface TreeChange {
  readonly path: string;
  /** A added, D deleted, M modified, T type changed. */
  readonly status: string;
  /** "000000" and null blob on the side where the path does not exist. */
  readonly oldMode: string;
  readonly newMode: string;
  readonly oldBlob: string | null;
  readonly newBlob: string | null;
}

/** One path that differs between two trees, renames found, with its line counts. */
export interface DiffEntry {
  /** A added, D deleted, M modified, R renamed, T type changed. */
  readonly status: string;
  readonly path: string;
  /** For a rename: the path in `from`. */
  readonly oldPath?: string;
  /** null for a binary file. */
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
  /** `for-each-ref refs/heads`: the local branch names, without `refs/heads/` (so a tag named `main` does not turn `main` into `heads/main`). */
  branches(repo: string): Promise<GitResult<string[]>>;
  /**
   * `symbolic-ref -q refs/remotes/<remote>/HEAD`: the branch the remote's HEAD points at as last
   * recorded in this repo (e.g. `main`); undefined when it is not set. Nothing is fetched.
   */
  remoteHead(repo: string, remote: string): Promise<GitResult<string | undefined>>;
  /** `rev-parse --show-toplevel`: the folder git treats as the work tree of `repo`. */
  topLevel(repo: string): Promise<GitResult<string>>;
  /** `init -q -b <branch>`: a new repo in `repo`, which must exist. */
  init(repo: string, branch: string): Promise<GitResult<void>>;
  /** `add -A`. */
  addAll(repo: string): Promise<GitResult<void>>;
  /** `diff --cached --numstat -z --no-renames`. */
  diffCachedNumstat(repo: string): Promise<GitResult<NumstatEntry[]>>;
  /** `diff-tree -r -z --raw --no-abbrev --no-renames <from> <to>`: every path that differs, with blob ids. */
  diffTreeRaw(repo: string, from: string, to: string): Promise<GitResult<TreeChange[]>>;
  /** Unified diff from one tree (or commit) to another; no rename detection. */
  diffTrees(repo: string, from: string, to: string): Promise<GitResult<string>>;
  /**
   * `diff --raw -z -M` and `diff --numstat -z -M` from one tree (or commit) to another: every path
   * that differs, renames found, in git's order, with line counts.
   */
  diffFiles(repo: string, from: string, to: string): Promise<GitResult<DiffEntry[]>>;
  /**
   * Unified diff from one tree to another with renames found, in the order of `diffFiles`, with
   * "a/" and "b/" prefixes and quoted paths whatever the repo config says. Only the first
   * `maxBytes` are read; `cut` says there was more.
   */
  diffPatch(repo: string, from: string, to: string, maxBytes: number): Promise<GitResult<{ readonly text: string; readonly cut: boolean }>>;
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
  /**
   * The tree `add -A` then `write-tree` would give, uncommitted and untracked files included,
   * built in a copy of the index in a temp folder: the repo's own index is never written.
   */
  snapshotTree(repo: string): Promise<GitResult<string>>;
  /** `commit -q --no-verify -m <message>` of the index; returns the new commit id. */
  commit(repo: string, message: string): Promise<GitResult<string>>;
  /**
   * `commit-tree <tree> -p <parent>... -m <message>`: a commit of exactly `tree` (two parents for a
   * merge commit); returns its id. No ref moves.
   */
  commitTree(repo: string, tree: string, parent: string | readonly string[], message: string): Promise<GitResult<string>>;
  /** `update-ref <ref> <newId> <oldId>`: moves `ref` (under refs/) only if it still points at `oldId`. */
  updateRef(repo: string, ref: string, newId: string, oldId: string): Promise<GitResult<void>>;
  /** `symbolic-ref -q HEAD`: the full ref the checkout is on, e.g. refs/heads/main; undefined when HEAD is detached. */
  currentRef(repo: string): Promise<GitResult<string | undefined>>;
  /** `merge-base --is-ancestor <ancestor> <descendant>`. */
  isAncestor(repo: string, ancestor: string, descendant: string): Promise<GitResult<boolean>>;
  /**
   * `merge-tree --write-tree` of two commits, in the object store only: no checkout, index or
   * working tree is touched. A clean merge gives its tree; a conflicted one the conflicted paths.
   */
  mergeTree(repo: string, ours: string, theirs: string): Promise<GitResult<MergeTreeResult>>;
  /**
   * `merge --ff-only --no-edit <commit>` in the checkout at `repo`: moves its branch and working
   * tree forward. git refuses, and changes nothing, when local changes or untracked files would be
   * overwritten.
   */
  mergeFastForward(repo: string, commit: string): Promise<GitResult<void>>;
  /**
   * Every URL a push to `remote` goes to, as written: all `remote.<name>.pushurl` values, else all
   * `remote.<name>.url` values (git pushes to each), before any `insteadOf` rewrite. Empty when
   * the remote has none.
   */
  remotePushUrls(repo: string, remote: string): Promise<GitResult<string[]>>;
  /** `remote get-url --push <remote>`: where a push really goes (the first URL), after `insteadOf` and `pushInsteadOf`. */
  remoteResolvedPushUrl(repo: string, remote: string): Promise<GitResult<string>>;
  /**
   * `push --no-verify --porcelain <target> <commit>:refs/heads/<branch>`: no force. `target` is a
   * remote name or a URL. `sshAuthSock` passes the SSH agent socket to this push only (an SSH
   * remote); no other git call gets it.
   */
  push(repo: string, target: string, commit: string, branch: string, options?: { readonly sshAuthSock?: string }): Promise<GitResult<void>>;
  /** `diff --name-only -z --no-renames <from> <to>`: every path that differs between two commits. */
  diffNames(repo: string, from: string, to: string): Promise<GitResult<string[]>>;
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
  /**
   * `config --file <file> --list -z`: the entries of one config file, in file order, as git
   * reads them. Each record is `key` alone (a key with no value) or `key\nvalue`; section and key
   * names come lowercased. Includes are not followed. `file` must be absolute.
   */
  configList(file: string): Promise<GitResult<string[]>>;
  /** `git --version`, refused below MIN_GIT_VERSION. The engine calls it once at startup. */
  checkGitVersion(): Promise<GitResult<string>>;
  /**
   * Whether the repo is a partial clone: `extensions.partialclone` is set, or a remote is marked
   * `promisor`. Only such a repo can fetch objects by itself.
   */
  partialClone(repo: string): Promise<GitResult<boolean>>;
}

export type MergeTreeResult = { readonly clean: true; readonly tree: string } | { readonly clean: false; readonly conflicts: readonly string[] };

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
  async function raw(repo: string, args: readonly string[], extraConfig: readonly string[] = [], extraEnv: Readonly<Record<string, string>> = {}): Promise<GitResult<string>> {
    return map(capped(repo, args, extraConfig, Infinity, extraEnv), (out) => out.text);
  }

  /** As `raw`, but only the first `maxBytes` of stdout are read. */
  async function capped(
    repo: string,
    args: readonly string[],
    extraConfig: readonly string[],
    maxBytes: number,
    extraEnv: Readonly<Record<string, string>> = {},
  ): Promise<GitResult<{ text: string; cut: boolean }>> {
    const dir = await mkdtemp(join(tmpdir(), "tokama-git-"));
    try {
      const stdoutFile = join(dir, "stdout");
      const stderr: string[] = [];
      let stderrLength = 0;
      const result = await options.runner.run({
        command: { argv: [gitPath, "--no-pager", ...safe(GIT_SAFE_CONFIG), ...safe(args[0] === "push" ? [] : [NO_TRANSPORT]), ...safe(extraConfig), ...args] },
        cwd: repo,
        env: { ...GIT_ENV, ...(args[0] === "push" ? {} : NO_TRANSPORT_ENV), ...extraEnv },
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
      const failure = (reason: GitErrorReason, exitCode: number | null, message: string, stdout?: string): GitResult<never> =>
        err({ reason, args, exitCode, message, ...(stdout !== undefined && { stdout: stdout.slice(0, STDERR_CAP) }) });
      if (result.kind === "not-started") return failure("spawn-error", null, result.message);
      const stdout = Number.isFinite(maxBytes) ? await readPrefix(stdoutFile, maxBytes) : { text: await readFile(stdoutFile, "utf8"), cut: false };
      // Some failures are reported on stdout only (commit: "nothing to commit").
      const message = (stderr.length > 0 ? stderr.join("\n") : stdout.text).slice(0, STDERR_CAP);
      if (result.timedOut) return failure("timed-out", result.exitCode, message);
      if (result.exitCode !== 0) return failure("failed", result.exitCode, message, stdout.text);
      return ok(stdout);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Settings that disable every filter driver and merge driver the repo itself configures (local
   * or worktree scope, includes too). A clean or smudge filter is a command named by config and
   * chosen by .gitattributes or .git/info/attributes, so `add`, `status`, `diff` and `worktree add`
   * would run it; a merge driver (`merge.<x>.driver`) runs in `merge-tree` and `merge`. With its
   * command emptied, git reports the file as conflicted instead. Drivers only in the user's global
   * or system config (e.g. git-lfs) stay on.
   * `required` is left as configured: git then fails on a required driver (e.g. encryption)
   * instead of storing the plain content.
   */
  async function filterOverrides(
    repo: string,
    args: readonly string[],
  ): Promise<GitResult<{ config: string[]; required: string[] }>> {
    const listed = await raw(repo, ["config", "-z", "--show-scope", "--name-only", "--get-regexp", "^(filter|merge)\\."]);
    if (!listed.ok) {
      // Exit 1: no filter configured.
      if (listed.error.reason === "failed" && listed.error.exitCode === 1) return ok({ config: [], required: [] });
      return err({ ...listed.error, args });
    }
    const fields = listed.value.split("\0");
    const drivers = new Set<string>();
    const mergeDrivers = new Set<string>();
    const required = new Set<string>();
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const scope = fields[i] ?? "";
      const name = fields[i + 1] ?? "";
      const dot = name.lastIndexOf(".");
      const merge = name.startsWith("merge.");
      // Two-part merge keys (merge.ff, merge.conflictstyle) are settings, not drivers.
      if (merge && (dot === "merge".length || name.slice(dot + 1) !== "driver")) continue;
      const driver = name.slice((merge ? "merge." : "filter.").length, dot);
      if (name.slice(dot + 1) === "required") required.add(driver);
      if (scope === "global" || scope === "system") continue;
      // `-c` splits at the first "="; git also ignores a `-c` override of the empty name. Such a
      // driver cannot be disabled, so nothing runs.
      if (driver === "" || driver.includes("=") || driver.includes("\n")) {
        return err({
          reason: "unsafe-config",
          args,
          exitCode: null,
          message: `${merge ? "merge" : "filter"} driver name cannot be disabled safely: ${JSON.stringify(driver)}`,
        });
      }
      (merge ? mergeDrivers : drivers).add(driver);
    }
    return ok({
      config: [
        ...[...drivers].flatMap((driver) => FILTER_KEYS.map((key) => `filter.${driver}.${key}=`)),
        ...[...mergeDrivers].map((driver) => `merge.${driver}.driver=`),
      ],
      required: [...drivers].filter((driver) => required.has(driver)),
    });
  }

  async function git(repo: string, args: readonly string[], extraEnv: Readonly<Record<string, string>> = {}): Promise<GitResult<string>> {
    return map(gitCapped(repo, args, Infinity, extraEnv), (out) => out.text);
  }

  async function gitCapped(repo: string, args: readonly string[], maxBytes: number, extraEnv: Readonly<Record<string, string>> = {}): Promise<GitResult<{ text: string; cut: boolean }>> {
    const overrides = await filterOverrides(repo, args);
    if (!overrides.ok) return overrides;
    const result = await capped(repo, args, overrides.value.config, maxBytes, extraEnv);
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
  const map = async <A, T>(result: Promise<GitResult<A>>, parse: (out: A) => T): Promise<GitResult<T>> => {
    const settled = await result;
    return settled.ok ? ok(parse(settled.value)) : settled;
  };
  const none = () => undefined;
  const trimmed = (out: string) => out.trim();

  return {
    status: (repo) => map(git(repo, ["status", "--porcelain", "-z", "--untracked-files=all"]), parseStatus),
    branches: (repo) =>
      map(git(repo, ["for-each-ref", "--format=%(refname)", "refs/heads"]), (out) =>
        out
          .split("\n")
          .filter((ref) => ref.startsWith("refs/heads/"))
          .map((ref) => ref.slice("refs/heads/".length)),
      ),
    async remoteHead(repo, remote) {
      const args = ["symbolic-ref", "-q", `refs/remotes/${remote}/HEAD`];
      const refused = refuseOption(args, remote);
      if (refused !== undefined) return refused;
      const out = await git(repo, args);
      // Exit 1: not set, or not a symbolic ref.
      if (!out.ok && out.error.reason === "failed") return ok(undefined);
      if (!out.ok) return out;
      const prefix = `refs/remotes/${remote}/`;
      const target = out.value.trim();
      return ok(target.startsWith(prefix) ? target.slice(prefix.length) : undefined);
    },
    topLevel: (repo) => map(git(repo, ["rev-parse", "--show-toplevel"]), trimmed),
    async init(repo, branch) {
      const args = ["init", "-q", "-b", branch];
      return refuseOption(args, branch) ?? map(git(repo, args), none);
    },
    addAll: (repo) => map(git(repo, ["add", "-A"]), none),
    diffCachedNumstat: (repo) =>
      map(git(repo, ["diff", "--cached", "--numstat", "-z", "--no-renames", ...DIFF_SAFE]), parseNumstat),
    async diffTreeRaw(repo, from, to) {
      const args = ["diff-tree", "-r", "-z", "--raw", "--no-abbrev", "--no-renames", from, to, "--"];
      return refuseOption(args, from, to) ?? map(git(repo, args), parseDiffTreeRaw);
    },
    async diffFiles(repo, from, to) {
      const rawArgs = ["diff", "--raw", "-z", "--no-abbrev", ...RENAMES, ...DIFF_SAFE, from, to, "--"];
      const refused = refuseOption(rawArgs, from, to);
      if (refused !== undefined) return refused;
      const listed = await git(repo, rawArgs);
      if (!listed.ok) return listed;
      const counted = await git(repo, ["diff", "--numstat", "-z", ...RENAMES, ...DIFF_SAFE, from, to, "--"]);
      if (!counted.ok) return counted;
      const counts = new Map(parseNumstatRenames(counted.value).map((entry) => [entry.path, entry]));
      return ok(
        parseDiffRaw(listed.value).map((entry) => {
          const count = counts.get(entry.path);
          return { ...entry, added: count?.added ?? null, removed: count?.removed ?? null };
        }),
      );
    },
    async diffPatch(repo, from, to, maxBytes) {
      const args = ["-c", "core.quotePath=true", "diff", "--patch", "--src-prefix=a/", "--dst-prefix=b/", ...RENAMES, ...DIFF_SAFE, from, to, "--"];
      return refuseOption(args, from, to) ?? gitCapped(repo, args, maxBytes);
    },
    async diffTrees(repo, from, to) {
      const args = ["diff", "--no-renames", ...DIFF_SAFE, from, to, "--"];
      return refuseOption(args, from, to) ?? git(repo, args);
    },
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
    async snapshotTree(repo) {
      const index = await git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
      if (!index.ok) return index;
      const dir = await mkdtemp(join(tmpdir(), "tokama-index-"));
      try {
        const env = { GIT_INDEX_FILE: join(dir, "index") };
        // Without the copy git would hash every file again; a repo with no index yet starts empty.
        await copyFile(index.value.trim(), env.GIT_INDEX_FILE).catch((cause: unknown) => {
          if (!hasCode(cause, "ENOENT")) throw cause;
        });
        const added = await git(repo, ["add", "-A"], env);
        if (!added.ok) return added;
        return await map(git(repo, ["write-tree"], env), trimmed);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    async commit(repo, message) {
      const committed = await git(repo, ["commit", "-q", "--no-verify", "-m", message]);
      if (!committed.ok) return committed;
      return map(git(repo, ["rev-parse", "--verify", "HEAD"]), trimmed);
    },
    async commitTree(repo, tree, parent, message) {
      const parents = typeof parent === "string" ? [parent] : [...parent];
      const args = ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", message];
      return refuseOption(args, tree, ...parents) ?? map(git(repo, args), trimmed);
    },
    async currentRef(repo) {
      const args = ["symbolic-ref", "-q", "HEAD"];
      const out = await git(repo, args);
      // Exit 1: HEAD is detached.
      if (!out.ok && out.error.reason === "failed" && out.error.exitCode === 1) return ok(undefined);
      return out.ok ? ok(out.value.trim()) : out;
    },
    async isAncestor(repo, ancestor, descendant) {
      const args = ["merge-base", "--is-ancestor", ancestor, descendant];
      const refused = refuseOption(args, ancestor, descendant);
      if (refused !== undefined) return refused;
      const out = await git(repo, args);
      if (!out.ok && out.error.reason === "failed" && out.error.exitCode === 1) return ok(false);
      return out.ok ? ok(true) : out;
    },
    async mergeTree(repo, ours, theirs) {
      const args = ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", ours, theirs];
      const refused = refuseOption(args, ours, theirs);
      if (refused !== undefined) return refused;
      // git exits 1 both on a conflict and on some errors (an unknown rev): both commits are
      // checked first, and a conflict is told by its output, a tree id and the paths.
      for (const rev of [ours, theirs]) {
        const known = await git(repo, ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`]);
        if (!known.ok) return known;
      }
      const out = await git(repo, args);
      if (out.ok) return ok({ clean: true, tree: out.value.split("\0")[0]!.trim() });
      // A conflict comes on stdout; stderr may hold other notes (a disabled merge driver).
      const [tree = "", ...paths] = (out.error.stdout ?? "").split("\0");
      if (out.error.reason === "failed" && out.error.exitCode === 1 && /^[0-9a-f]{40,64}$/.test(tree)) {
        return ok({ clean: false, conflicts: [...new Set(paths.filter((path) => path !== ""))] });
      }
      return out;
    },
    async mergeFastForward(repo, commit) {
      const args = ["merge", "--ff-only", "--no-edit", "--no-verify", "-q", commit];
      return refuseOption(args, commit) ?? map(git(repo, args), none);
    },
    async remotePushUrls(repo, remote) {
      const refused = refuseOption(["config", "-z", "--get-all", `remote.${remote}.url`], remote);
      if (refused !== undefined) return refused;
      for (const key of ["pushurl", "url"]) {
        const out = await git(repo, ["config", "-z", "--get-all", `remote.${remote}.${key}`]);
        if (out.ok) return ok(out.value.split("\0").filter((value) => value !== ""));
        // Exit 1: the key is not set.
        if (!(out.error.reason === "failed" && out.error.exitCode === 1)) return out;
      }
      return ok([]);
    },
    async diffNames(repo, from, to) {
      const args = ["diff", "--name-only", "-z", "--no-renames", ...DIFF_SAFE, from, to, "--"];
      return refuseOption(args, from, to) ?? map(git(repo, args), (out) => out.split("\0").filter((path) => path !== ""));
    },
    async remoteResolvedPushUrl(repo, remote) {
      const args = ["remote", "get-url", "--push", remote];
      return refuseOption(args, remote) ?? map(git(repo, args), trimmed);
    },
    async push(repo, target, commit, branch, pushOptions = {}) {
      const args = ["push", "--no-verify", "--porcelain", target, `${commit}:refs/heads/${branch}`];
      const refused = refuseOption(args, target, commit, branch);
      if (refused !== undefined) return refused;
      if (!/^[0-9a-f]{40,64}$/.test(commit)) return err({ reason: "invalid-argument", args, exitCode: null, message: `refused commit: ${JSON.stringify(commit)}` });
      const sock = pushOptions.sshAuthSock;
      return map(git(repo, args, sock === undefined || sock === "" ? {} : { SSH_AUTH_SOCK: sock }), none);
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
    async configList(file) {
      const args = ["config", "--file", file, "--list", "-z"];
      if (!isAbsolute(file)) return err({ reason: "invalid-argument", args, exitCode: null, message: `refused relative path: ${JSON.stringify(file)}` });
      // Outside any repo: only the named file is read.
      return map(raw(tmpdir(), args), (out) => out.split("\0").filter((record) => record !== ""));
    },
    async checkGitVersion() {
      const args = ["--version"];
      const out = await raw(tmpdir(), args);
      if (!out.ok) return out;
      if (!atLeast(out.value, MIN_GIT_VERSION)) {
        return err({
          reason: "unsupported-version",
          args,
          exitCode: 0,
          message: `git ${MIN_GIT_VERSION.major}.${MIN_GIT_VERSION.minor} or newer is required; found: ${out.value.trim()}`,
        });
      }
      return ok(out.value.trim());
    },
    async partialClone(repo) {
      // A remote with a partial-clone filter is a promisor remote to git even without `promisor`.
      const out = await git(repo, ["config", "-z", "--get-regexp", "^(extensions\\.partialclone|remote\\..*\\.(promisor|partialclonefilter))$"]);
      // Exit 1: neither is set.
      if (!out.ok) return out.error.reason === "failed" && out.error.exitCode === 1 ? ok(false) : out;
      return ok(
        out.value
          .split("\0")
          .filter((record) => record !== "")
          .some((record) => {
            const [key = "", ...rest] = record.split("\n");
            // Any extensions.partialclone or partialclonefilter value counts; a promisor flag is a git boolean.
            return !key.endsWith(".promisor") || gitTrue(rest.length === 0 ? undefined : rest.join("\n"));
          }),
      );
    },
  };
}

/**
 * A git boolean, read to fail closed: a key with no value is true; only "false", "no", "off", an
 * empty value and a zero (git also reads 0x0 and 0k) are false. Any other text counts as true.
 */
function gitTrue(value: string | undefined): boolean {
  if (value === undefined) return true;
  const text = value.trim().toLowerCase();
  return !(text === "" || text === "false" || text === "no" || text === "off" || /^[+-]?(0x)?0+[kmg]?$/.test(text));
}

/** The first `maxBytes` of a file as UTF-8, and whether the file has more. */
async function readPrefix(path: string, maxBytes: number): Promise<{ text: string; cut: boolean }> {
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), cut: size > maxBytes };
  } finally {
    await handle.close();
  }
}

/** Reads major and minor from `git --version` ("git version 2.54.0 (Apple Git-157)"). */
export function parseGitVersion(out: string): { major: number; minor: number } | undefined {
  const match = /^git version (\d+)\.(\d+)/.exec(out.trim());
  return match === null ? undefined : { major: Number(match[1]), minor: Number(match[2]) };
}

/** Whether `git --version` output names a version of at least `min`. Output that cannot be read is not. */
function atLeast(versionText: string, min: { major: number; minor: number }): boolean {
  const version = parseGitVersion(versionText);
  return version !== undefined && (version.major > min.major || (version.major === min.major && version.minor >= min.minor));
}

/**
 * Whether this git honours GIT_NO_LAZY_FETCH (2.44 or newer). False when the version cannot be
 * read.
 */
export function supportsNoLazyFetch(versionText: string): boolean {
  return atLeast(versionText, NO_LAZY_FETCH_GIT_VERSION);
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

/**
 * Parses `diff --raw -z` with renames: `:<mode> <mode> <blob> <blob> <status>` then the path, or
 * for a rename or copy (status R or C with a score) the old path and then the new one.
 */
export function parseDiffRaw(out: string): { status: string; path: string; oldPath?: string }[] {
  const fields = out.split("\0");
  const entries: { status: string; path: string; oldPath?: string }[] = [];
  for (let i = 0; i + 1 < fields.length; ) {
    const meta = fields[i]!;
    if (!meta.startsWith(":")) {
      i++;
      continue;
    }
    const status = (meta.split(" ")[4] ?? "").slice(0, 1);
    if (status === "R" || status === "C") {
      entries.push({ status, oldPath: fields[i + 1]!, path: fields[i + 2] ?? "" });
      i += 3;
    } else {
      entries.push({ status, path: fields[i + 1]! });
      i += 2;
    }
  }
  return entries;
}

/**
 * Parses `diff --numstat -z` with renames: "added\tremoved\tpath\0", or for a rename
 * "added\tremoved\t\0old\0new\0"; "-" counts mean binary. Keyed by the new path.
 */
export function parseNumstatRenames(out: string): NumstatEntry[] {
  const count = (value: string) => (value === "-" ? null : Number(value));
  const fields = out.split("\0");
  const entries: NumstatEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field === "") continue;
    const [added = "", removed = "", ...rest] = field.split("\t");
    let path = rest.join("\t");
    if (path === "") {
      path = fields[i + 2] ?? "";
      i += 2;
    }
    entries.push({ path, added: count(added), removed: count(removed) });
  }
  return entries;
}

const NO_BLOB = /^0+$/;

/** Parses `diff-tree -r -z --raw`: `:<mode> <mode> <blob> <blob> <status>` then the path, NUL-separated. */
export function parseDiffTreeRaw(out: string): TreeChange[] {
  const fields = out.split("\0");
  const changes: TreeChange[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i]!;
    if (!meta.startsWith(":")) continue;
    const [oldMode = "", newMode = "", oldBlob = "", newBlob = "", status = ""] = meta.slice(1).split(" ");
    changes.push({
      path: fields[i + 1]!,
      status: status.slice(0, 1),
      oldMode,
      newMode,
      oldBlob: NO_BLOB.test(oldBlob) ? null : oldBlob,
      newBlob: NO_BLOB.test(newBlob) ? null : newBlob,
    });
  }
  return changes;
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
