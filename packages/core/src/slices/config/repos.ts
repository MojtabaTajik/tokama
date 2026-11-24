// Repos: `<tokama home>/repos.yaml`, the repo folders on this machine. Paths are host-local
// settings; everything else refers to a repo by its id.
import { homedir } from "node:os";
import { isAbsolute, join, normalize, posix, sep } from "node:path";
import { z } from "zod";
import { posixSh, type SyntaxRefusalReason } from "../../kernel/command-policy/index.js";
import { err, ok, type Result } from "../../kernel/result/index.js";
import { MAX_CHECK_CHARS, type RepoId, RepoIdSchema } from "../../kernel/schemas/index.js";
import { readConfigFile, resolveHomePath } from "./read.js";
import { CONFIG_FORMAT, type ConfigError, parseYaml } from "./yaml-file.js";

export interface Repo {
  readonly id: RepoId;
  /** Absolute path of the repo on this machine. */
  readonly path: string;
  /** The remote URL, when the repo has one. */
  readonly remote?: string;
  readonly baseBranch: string;
  /** Where item worktrees go, relative to the repo. */
  readonly worktreeFolder: string;
  /** The repo's default check commands, each one simple command; empty when none are set. */
  readonly checks: readonly string[];
}

export const DEFAULT_WORKTREE_FOLDER = ".tokama/wt";

// Branch names and remotes reach git as arguments: nothing that reads as an option or a range.
export const BRANCH = /^(?![-+/.])(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!(?:@|HEAD)$)[A-Za-z0-9._/@+-]+(?<![/.])(?<!\.lock)$/;
// No whitespace and no control characters (NUL included).
const REMOTE = /^(?!-)[^\s\p{Cc}]+$/u;

const REFUSAL_WORDS: Record<SyntaxRefusalReason, string> = {
  substitution: "command substitution ($(...) or backticks)",
  "ansi-c-quote": "$'...' quoting",
  redirect: "a redirect (>, <)",
  background: "a background &",
  subshell: "a subshell ( ... )",
  newline: "a line break",
  "unbalanced-quote": "an unclosed quote",
};

/** Why a check isn't one simple command, or undefined when it is. Parsed as the command policy parses checks. */
export function checkProblem(command: string): string | undefined {
  const split = posixSh.split(command);
  if (!split.ok) return `can't use ${REFUSAL_WORDS[split.error.reason]}`;
  if (split.value.length !== 1) return "must be one command, with no &&, ||, ; or |";
  if (split.value[0]!.words.length === 0) return "has no command words";
  return undefined;
}

/** A worktree folder must stay inside the repo, not be the repo itself, and stay out of .git. */
function isWorktreeFolder(folder: string): boolean {
  if (isAbsolute(folder) || folder.startsWith("~")) return false;
  const parts = posix.normalize(folder.replaceAll("\\", "/")).split("/").filter((part) => part !== "" && part !== ".");
  return parts.length > 0 && !parts.includes("..") && parts[0]!.toLowerCase() !== ".git";
}

const RepoEntrySchema = z.strictObject({
  id: RepoIdSchema,
  path: z
    .string()
    .min(1)
    .refine((path) => !path.includes("\0"), "can't contain a NUL character")
    .refine((path) => isAbsolute(path) || path.startsWith("~/"), "must be a full path, such as /home/me/code/orders-api or ~/code/orders-api"),
  remote: z.string().regex(REMOTE, "must be a URL with no spaces or control characters, not starting with '-'").optional(),
  base_branch: z.string().regex(BRANCH, "must be a branch name, such as main"),
  worktree_folder: z
    .string()
    .min(1)
    .refine((folder) => !folder.includes("\0"), "can't contain a NUL character")
    .refine(isWorktreeFolder, "must be a folder inside the repo and outside .git, such as .tokama/wt")
    .optional(),
  checks: z
    .array(
      z.string().max(MAX_CHECK_CHARS).superRefine((command, ctx) => {
        const problem = checkProblem(command);
        if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
      }),
    )
    .optional(),
});

export const ReposFileSchema = z
  .strictObject({
    format: z.literal(CONFIG_FORMAT),
    repos: z.array(RepoEntrySchema),
  })
  .superRefine((file, ctx) => {
    const seen = new Set<string>();
    file.repos.forEach((repo, index) => {
      if (seen.has(repo.id)) ctx.addIssue({ code: "custom", path: ["repos", index, "id"], message: `'${repo.id}' is used by an earlier repo` });
      seen.add(repo.id);
    });
  });

export interface LoadReposOptions {
  /** Tokama's home folder (`~/.tokama`), which holds `repos.yaml`. */
  readonly tokamaHome: string;
  /** What `~/` in a repo path stands for. Default: the user's home folder. */
  readonly home?: string;
}

export const REPOS_FILE = "repos.yaml";

/** `repos.yaml` as it is now. */
export interface ReposFile {
  /** The file to write: the real file behind a link, or where a new file goes. */
  readonly path: string;
  /** Undefined when there is no file yet. */
  readonly text: string | undefined;
  readonly repos: Repo[];
}

/** The repos in `repos.yaml`, in file order. No file: no repos. A linked file is followed. */
export async function loadRepos(options: LoadReposOptions): Promise<Result<Repo[], ConfigError>> {
  const file = await readReposFile(options);
  return file.ok ? ok(file.value.repos) : file;
}

/** `repos.yaml` with its text and repos; `loadRepos` and the edits read it through this. */
export async function readReposFile(options: LoadReposOptions): Promise<Result<ReposFile, ConfigError>> {
  const link = join(options.tokamaHome, REPOS_FILE);
  const real = await resolveHomePath(link, REPOS_FILE);
  if (!real.ok) return err({ problems: [real.error] });
  const content = real.value === undefined ? ok(undefined) : await readConfigFile(real.value, REPOS_FILE);
  if (!content.ok) return err({ problems: [content.error] });
  const path = real.value ?? link;
  if (content.value === undefined) return ok({ path, text: undefined, repos: [] });
  const parsed = parseYaml(ReposFileSchema, content.value, REPOS_FILE);
  if (!parsed.ok) return err({ problems: parsed.error });
  const home = options.home ?? homedir();
  return ok({
    path,
    text: content.value,
    repos: parsed.value.repos.map((entry) => ({
      id: entry.id,
      path: withoutTrailingSep(normalize(entry.path.startsWith("~/") ? join(home, entry.path.slice(2)) : entry.path)),
      ...(entry.remote === undefined ? {} : { remote: entry.remote }),
      baseBranch: entry.base_branch,
      worktreeFolder: entry.worktree_folder ?? DEFAULT_WORKTREE_FOLDER,
      checks: entry.checks?.map((command) => command.trim()) ?? [],
    })),
  });
}

const withoutTrailingSep = (path: string): string => (path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path);
