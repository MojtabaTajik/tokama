import { mkdtemp, readFile, rm } from "node:fs/promises";
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

/** On every diff form: no external diff driver (diff.<driver>.command), no textconv, no color. */
export const DIFF_SAFE: readonly string[] = ["--no-ext-diff", "--no-textconv", "--no-color"];

/**
 * Variables added to the process runner's allowlisted environment. Git never prompts; editor and
 * askpass variables are not in the allowlist, so they never reach git. No lazy fetch: in a partial
 * clone, a missing object would otherwise make a local call (diff, worktree add) fetch it through
 * the repo's remote config (uploadpack, sshCommand, credential helper). Such a call fails instead.
 *
 * Known gap: a repo nested in the worktree (an embedded repo or submodule) has its own config.
 * git runs `status` inside it as a child process, which gets the settings above but not that
 * repo's filter overrides, so a filter configured there can run.
 */
export const GIT_ENV: Readonly<Record<string, string>> = { GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" };

const FILTER_KEYS = ["clean", "smudge", "process"] as const;

export type GitErrorReason =
  /** git did not start (not installed, bad cwd). */
  | "spawn-error"
  | "timed-out"
  /** git exited non-zero. */
  | "failed"
  /** An argument was refused before git ran (e.g. it starts with "-" and would be read as an option). */
  | "invalid-argument"
  /** The repo config names a filter driver that cannot be disabled safely; nothing ran. */
  | "unsafe-config";

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
  /** `write-tree`: the tree id of the index. */
  writeTree(repo: string): Promise<GitResult<string>>;
  /** `commit -q --no-verify -m <message>` of the index; returns the new commit id. */
  commit(repo: string, message: string): Promise<GitResult<string>>;
  /** `rev-parse --verify <rev>`: the object id `rev` names. */
  revParse(repo: string, rev: string): Promise<GitResult<string>>;
  /** `worktree add -b <branch> <path> <startPoint>`. */
  worktreeAdd(repo: string, path: string, branch: string, startPoint: string): Promise<GitResult<void>>;
  /** `worktree remove [--force] <path>`. */
  worktreeRemove(repo: string, path: string, options?: { readonly force?: boolean }): Promise<GitResult<void>>;
  /** `worktree list --porcelain -z`. */
  worktreeList(repo: string): Promise<GitResult<WorktreeEntry[]>>;
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
      const message = stderr.join("\n").slice(0, STDERR_CAP);
      if (result.timedOut) return failure("timed-out", result.exitCode, message);
      if (result.exitCode !== 0) return failure("failed", result.exitCode, message);
      return ok(await readFile(stdoutFile, "utf8"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Settings that disable every filter driver the repo itself configures (local or worktree
   * scope, includes too). A clean or smudge filter is a command named by config and chosen by
   * .gitattributes or .git/info/attributes, so `add`, `status`, `diff` and `worktree add` would
   * run it. Drivers only in the user's global or system config (e.g. git-lfs) stay on.
   */
  async function filterOverrides(repo: string, args: readonly string[]): Promise<GitResult<string[]>> {
    const listed = await raw(repo, ["config", "-z", "--show-scope", "--name-only", "--get-regexp", "^filter\\."]);
    // Exit 1: no filter configured.
    if (!listed.ok) return listed.error.reason === "failed" && listed.error.exitCode === 1 ? ok([]) : listed;
    const fields = listed.value.split("\0");
    const drivers = new Set<string>();
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const scope = fields[i] ?? "";
      const name = fields[i + 1] ?? "";
      if (scope === "global" || scope === "system") continue;
      const driver = name.slice("filter.".length, name.lastIndexOf("."));
      if (driver === "") continue;
      // `-c` splits at the first "="; such a name cannot be overridden, so nothing runs.
      if (driver.includes("=") || driver.includes("\n")) {
        return err({
          reason: "unsafe-config",
          args,
          exitCode: null,
          message: `filter driver name cannot be disabled safely: ${JSON.stringify(driver)}`,
        });
      }
      drivers.add(driver);
    }
    return ok(
      [...drivers].flatMap((driver) => [
        ...FILTER_KEYS.map((key) => `filter.${driver}.${key}=`),
        `filter.${driver}.required=false`,
      ]),
    );
  }

  async function git(repo: string, args: readonly string[]): Promise<GitResult<string>> {
    const overrides = await filterOverrides(repo, args);
    return overrides.ok ? raw(repo, args, overrides.value) : overrides;
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
    writeTree: (repo) => map(git(repo, ["write-tree"]), trimmed),
    async commit(repo, message) {
      const committed = await git(repo, ["commit", "-q", "--no-verify", "-m", message]);
      if (!committed.ok) return committed;
      return map(git(repo, ["rev-parse", "--verify", "HEAD"]), trimmed);
    },
    async revParse(repo, rev) {
      const args = ["rev-parse", "--verify", rev];
      return refuseOption(args, rev) ?? map(git(repo, args), trimmed);
    },
    async worktreeAdd(repo, path, branch, startPoint) {
      const args = ["worktree", "add", "-b", branch, "--", path, startPoint];
      return refuseOption(args, path, branch, startPoint) ?? map(git(repo, args), none);
    },
    async worktreeRemove(repo, path, removeOptions = {}) {
      const args = ["worktree", "remove", ...(removeOptions.force === true ? ["--force"] : []), "--", path];
      return refuseOption(args, path) ?? map(git(repo, args), none);
    },
    worktreeList: (repo) => map(git(repo, ["worktree", "list", "--porcelain", "-z"]), parseWorktreeList),
  };
}

/** Parses `status --porcelain -z` (v1): "XY path\0", plus "orig\0" after a rename or copy. */
export function parseStatus(out: string): StatusEntry[] {
  const fields = out.split("\0");
  const entries: StatusEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? "";
    if (field.length < 4) continue;
    const index = field.charAt(0);
    const worktree = field.charAt(1);
    const path = field.slice(3);
    if (index === "R" || index === "C") {
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
