// Changes to `repos.yaml`: suggest the settings of a folder, add it as a repo, change a repo's base
// branch and checks, remove a repo, and set a folder up with git and a first commit.
// Only the engine calls these, one at a time. The file is edited as a YAML document, so its format
// line, comments and order stay. The result must pass the rules loadRepos uses before it is
// written: a temp file in the same folder, fsync, rename. A linked repos.yaml keeps its link: the
// file behind it is replaced.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { Document, isMap, isScalar, isSeq, parseDocument } from "yaml";
import { readJsonFile } from "../../kernel/fs-safe/index.js";
import type { Git, GitError } from "../../kernel/git/index.js";
import { err, ok, type Result } from "../../kernel/result/index.js";
import { MAX_CHECK_CHARS, type RepoId, RepoIdSchema } from "../../kernel/schemas/index.js";
import { DEFAULT_GITIGNORE, type FirstCommitPreview, GITIGNORE_FILE, previewFirstCommit } from "./first-commit.js";
import { MAX_CONFIG_BYTES } from "./read.js";
import { BRANCH, checkProblem, DEFAULT_WORKTREE_FOLDER, type LoadReposOptions, type Repo, readReposFile, REPOS_FILE, type ReposFile, ReposFileSchema } from "./repos.js";
import { clean, CONFIG_FORMAT, formatProblem, parseYaml, quote, type ConfigProblem } from "./yaml-file.js";

/** Why a repo change was refused. `invalid_config`: repos.yaml itself has problems to fix first. */
export interface RepoEditError {
  readonly code: "invalid_request" | "already_exists" | "not_found" | "invalid_config" | "write_failed";
  readonly message: string;
}

export interface RepoEditOptions extends LoadReposOptions {
  /** Tells whether a folder is a git repo's top folder, and its branch. */
  readonly git: Pick<Git, "worktreeList" | "revParse" | "topLevel" | "init" | "addAll" | "diffCachedNumstat" | "commit">;
  /** Ids a new repo can't take though repos.yaml doesn't hold them, such as the sample engine's repos. */
  readonly reservedIds?: readonly string[];
}

/** What the engine proposes for a folder before it is added. */
export interface RepoSuggestion {
  /** The folder's real path. */
  readonly path: string;
  readonly gitRepo: boolean;
  /** False when the repo has no commit yet: work needs a base commit to start from. */
  readonly hasCommits: boolean;
  /** The current branch; undefined when HEAD is detached or the folder isn't a repo. */
  readonly branch: string | undefined;
  /** From the folder name, not used by another repo; undefined when the name gives none. */
  readonly id: RepoId | undefined;
  /** From package.json scripts: test, then lint, run with the lockfile's package manager. */
  readonly checks: readonly string[];
  /** For a JS project with no package.json: `node --check` on its entry file, when there is one. */
  readonly fallbackCheck: string | undefined;
  /** Set when Tokama can make the first commit here: no git repo yet, or a repo without commits. */
  readonly firstCommit: FirstCommitPreview | undefined;
  /** Why the folder can't be added as it is, in plain words. */
  readonly problem: string | undefined;
}

export interface AddRepoInput {
  readonly path: string;
  /** Default: the suggested id. */
  readonly id?: string;
  /** Default: the current branch. */
  readonly baseBranch?: string;
  /** Default: none. */
  readonly checks?: readonly string[];
}

/** The setup query's summary allows this many characters in a branch name. */
const MAX_BRANCH = 100;
// The placeholder `npm init` writes; it only fails.
const NPM_PLACEHOLDER_TEST = "no test specified";
const NOT_A_REPO = "This folder isn't a git repo yet.";
const NO_COMMITS = "This repo has no commits yet. Make a first commit, then add it.";
/** The files a plain JS project starts from, in the order `fallbackCheck` tries them. */
const ENTRY_FILES = ["src/main.js", "main.js", "index.js"] as const;

export async function suggestRepo(options: RepoEditOptions, path: string): Promise<Result<RepoSuggestion, RepoEditError>> {
  const folder = await inspectFolder(options.git, path);
  if (!folder.ok) return folder;
  const file = await readCurrent(options);
  const repos = file.ok ? file.value.repos : [];
  const added = await addedAs(repos, folder.value.path);
  const checks = await suggestChecks(folder.value.path);
  return ok({
    path: folder.value.path,
    gitRepo: folder.value.gitProblem === undefined,
    hasCommits: folder.value.hasCommits,
    branch: folder.value.branch,
    id: suggestId(folder.value.path, takenIds(options, repos)),
    checks: checks.commands,
    firstCommit: folder.value.canSetUp ? await previewFirstCommit(folder.value.path, options.home) : undefined,
    fallbackCheck: checks.commands.length === 0 && !checks.hasPackageJson ? await suggestFallbackCheck(folder.value.path) : undefined,
    problem: folder.value.gitProblem ?? (folder.value.hasCommits ? undefined : NO_COMMITS) ?? (added === undefined ? undefined : `This folder is already added as ${quote(added)}.`),
  });
}

export async function addRepo(options: RepoEditOptions, input: AddRepoInput): Promise<Result<Repo, RepoEditError>> {
  const folder = await inspectFolder(options.git, input.path);
  if (!folder.ok) return folder;
  if (folder.value.gitProblem !== undefined) return invalid(folder.value.gitProblem);
  if (!folder.value.hasCommits) return invalid(NO_COMMITS);
  const file = await readCurrent(options);
  if (!file.ok) return file;
  const { repos } = file.value;

  const id = input.id?.trim() || suggestId(folder.value.path, takenIds(options, repos));
  if (id === undefined) return invalid("Give the repo an id: lowercase letters, digits and hyphens.");
  if (!RepoIdSchema.safeParse(id).success) return invalid(`The id ${quote(id)} must be lowercase letters, digits and hyphens (at most 64).`);
  if (repos.some((repo) => repo.id === id)) return refused("already_exists", `A repo with the id ${quote(id)} is already added.`);
  if (options.reservedIds?.includes(id)) return refused("already_exists", `The id ${quote(id)} is taken by a sample repo. Pick another id.`);
  const added = await addedAs(repos, folder.value.path);
  if (added !== undefined) return refused("already_exists", `This folder is already added as ${quote(added)}.`);

  const baseBranch = input.baseBranch?.trim() || folder.value.branch;
  if (baseBranch === undefined) return invalid("The repo has no current branch (its HEAD is detached). Give a base branch, such as main.");
  const settings = checkSettings(baseBranch, input.checks ?? []);
  if (!settings.ok) return settings;
  const { checks } = settings.value;

  const entry = { id, path: folder.value.path, base_branch: baseBranch, ...(checks.length > 0 ? { checks } : {}) };
  const doc = file.value.text === undefined ? newDocument() : parseDocument(file.value.text, { uniqueKeys: true });
  const list = doc.get("repos", true);
  if (!isSeq(list)) return refused("invalid_config", `${REPOS_FILE} has no repos list.`);
  list.flow = false;
  list.items.push(doc.createNode(entry));
  const written = await write(file.value.path, doc);
  if (!written.ok) return written;
  return ok({ id: id as RepoId, path: folder.value.path, baseBranch, worktreeFolder: DEFAULT_WORKTREE_FOLDER, checks });
}

export interface UpdateRepoInput {
  readonly repoId: string;
  readonly baseBranch: string;
  /** Replaces the repo's checks; empty removes them. */
  readonly checks: readonly string[];
}

/** Changes the base branch and checks of a repo in repos.yaml, by the rules `addRepo` uses. */
export async function updateRepo(options: LoadReposOptions, input: UpdateRepoInput): Promise<Result<Repo, RepoEditError>> {
  const file = await readCurrent(options);
  if (!file.ok) return file;
  const index = file.value.repos.findIndex((repo) => repo.id === input.repoId);
  const current = file.value.repos[index];
  if (current === undefined || file.value.text === undefined) return refused("not_found", `No repo has the id ${quote(input.repoId)}.`);
  const baseBranch = input.baseBranch.trim();
  const settings = checkSettings(baseBranch, input.checks);
  if (!settings.ok) return settings;
  const { checks } = settings.value;

  const doc = parseDocument(file.value.text, { uniqueKeys: true });
  const list = doc.get("repos", true);
  const entry = isSeq(list) ? list.items[index] : undefined;
  if (!isMap(entry)) return refused("invalid_config", `${REPOS_FILE} has no repos list.`);
  entry.set("base_branch", baseBranch);
  if (checks.length === 0) entry.delete("checks");
  else {
    const old = entry.get("checks", true);
    if (isSeq(old)) {
      // The same list node, with the old entry of each command that stays: its comment stays too.
      const kept = new Map(old.items.filter(isScalar).map((item) => [item.value, item]));
      old.items = checks.map((command) => kept.get(command) ?? doc.createNode(command));
    } else entry.set("checks", doc.createNode(checks));
  }
  const written = await write(file.value.path, doc);
  return written.ok ? ok({ ...current, baseBranch, checks }) : written;
}

/**
 * Makes the folder ready to add: `git init` when it is no repo, a default .gitignore when it has
 * none, then a first commit of everything git does not ignore. A repo that has a commit already is
 * left alone, so a second call after a later failure does no harm.
 */
export async function setUpRepo(options: RepoEditOptions, input: { readonly path: string; readonly baseBranch?: string }): Promise<Result<void, RepoEditError>> {
  const folder = await inspectFolder(options.git, input.path);
  if (!folder.ok) return folder;
  if (!folder.value.canSetUp) return folder.value.gitProblem === undefined ? ok(undefined) : invalid(folder.value.gitProblem);
  const preview = await previewFirstCommit(folder.value.path, options.home);
  if (preview.refusal !== undefined) return invalid(preview.refusal);
  const path = folder.value.path;
  const failed = (action: string, error: GitError) => invalid(`Tokama couldn't ${action}: ${gitReason(error)}`);
  if (folder.value.gitProblem !== undefined) {
    const branch = input.baseBranch?.trim() || "main";
    if (!BRANCH.test(branch) || branch.length > MAX_BRANCH) return invalid(`The base branch ${quote(branch)} must be a branch name, such as main.`);
    const init = await options.git.init(path, branch);
    if (!init.ok) return failed("set up git here", init.error);
  }
  if (preview.addsGitignore) {
    try {
      await writeFile(join(path, GITIGNORE_FILE), `${DEFAULT_GITIGNORE.join("\n")}\n`, { flag: "wx" });
    } catch (error) {
      return invalid(`Tokama couldn't write ${GITIGNORE_FILE} (${(error as NodeJS.ErrnoException).code ?? String(error)}).`);
    }
  }
  const added = await options.git.addAll(path);
  if (!added.ok) return failed("stage the files", added.error);
  // Files staged before (in a repo with no commit) are not in the preview, and an ignore rule does
  // not unstage them: refuse rather than commit what the user was not shown.
  const staged = await options.git.diffCachedNumstat(path);
  if (!staged.ok) return failed("list the staged files", staged.error);
  if (staged.value.length > preview.files + (preview.addsGitignore ? 1 : 0)) {
    return invalid(`Git has ${staged.value.length} files staged already, more than the ${preview.files} shown. Unstage them (git reset) or pick another folder.`);
  }
  const committed = await options.git.commit(path, "Initial commit");
  if (!committed.ok) return failed("make the first commit", committed.error);
  return ok(undefined);
}

/** Why a git call failed, in plain words; the identity problem gets its fix. */
function gitReason(error: GitError): string {
  if (/identity unknown|user\.name|user\.email/i.test(error.message)) return "git doesn't know who you are. Set user.name and user.email in your git config, then try again.";
  if (/nothing to commit|nothing added/i.test(error.message)) return "git ignores every file in this folder, so there is nothing to commit.";
  const first = error.message.split("\n").find((line) => line.trim() !== "") ?? error.reason;
  return clean(first.replace(/^fatal:\s*/, ""), 200);
}

/** Removes the repo from repos.yaml. Its items and worktrees stay where they are. */
export async function removeRepo(options: LoadReposOptions, id: string): Promise<Result<Repo, RepoEditError>> {
  const file = await readCurrent(options);
  if (!file.ok) return file;
  const index = file.value.repos.findIndex((repo) => repo.id === id);
  const repo = file.value.repos[index];
  if (repo === undefined || file.value.text === undefined) return refused("not_found", `No repo has the id ${quote(id)}.`);
  const doc = parseDocument(file.value.text, { uniqueKeys: true });
  const list = doc.get("repos", true);
  if (!isSeq(list)) return refused("invalid_config", `${REPOS_FILE} has no repos list.`);
  list.items.splice(index, 1);
  const written = await write(file.value.path, doc);
  return written.ok ? ok(repo) : written;
}

/** The base branch and checks a repo may have, trimmed; a bad one is refused in plain words. */
function checkSettings(baseBranch: string, input: readonly string[]): Result<{ checks: string[] }, RepoEditError> {
  if (!BRANCH.test(baseBranch) || baseBranch.length > MAX_BRANCH) return invalid(`The base branch ${quote(baseBranch)} must be a branch name, such as main.`);
  const checks = input.map((command) => command.trim()).filter((command) => command !== "");
  for (const command of checks) {
    if (command.length > MAX_CHECK_CHARS) return invalid(`The check ${quote(command)} must be at most ${MAX_CHECK_CHARS} characters.`);
    const problem = checkProblem(command);
    if (problem !== undefined) return invalid(`The check ${quote(command)} ${problem}.`);
  }
  return ok({ checks });
}

/** A path for a message: escaped like `quote`, but cut only when very long. */
const quotePath = (path: string): string => `'${clean(path, 300)}'`;
const invalid = (message: string): Result<never, RepoEditError> => err({ code: "invalid_request", message });
const refused = (code: RepoEditError["code"], message: string): Result<never, RepoEditError> => err({ code, message });

/** repos.yaml as loaded; a file with problems is never rewritten. */
async function readCurrent(options: LoadReposOptions): Promise<Result<ReposFile, RepoEditError>> {
  const file = await readReposFile(options);
  if (file.ok) return file;
  return refused("invalid_config", `${REPOS_FILE} has problems; fix them first. ${problemList(file.error.problems)}`);
}

const problemList = (problems: readonly ConfigProblem[]): string => problems.map(formatProblem).join("; ");

function newDocument(): Document {
  const doc = new Document({ format: CONFIG_FORMAT, repos: [] });
  doc.commentBefore = " The repos Tokama works on. The app adds and removes them; comments and order are kept.";
  return doc;
}

/** Checks the new text with loadRepos' rules, then writes it atomically with mode 0600. */
async function write(path: string, doc: Document): Promise<Result<void, RepoEditError>> {
  const text = doc.toString();
  const parsed = parseYaml(ReposFileSchema, text, REPOS_FILE);
  if (!parsed.ok) return invalid(`The change would break ${REPOS_FILE}: ${problemList(parsed.error)}`);
  if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) return invalid(`${REPOS_FILE} would be larger than ${MAX_CONFIG_BYTES / 1024} KB.`);
  try {
    await writeAtomic(path, text);
    return ok(undefined);
  } catch (error) {
    return refused("write_failed", `${REPOS_FILE} can't be written (${(error as NodeJS.ErrnoException).code ?? String(error)}).`);
  }
}

/** Temp file in the same folder (so the rename is atomic), fsync, rename, then fsync the folder. */
async function writeAtomic(path: string, text: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try {
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  // Makes the rename itself durable. Not every platform can open a folder for this.
  try {
    const folder = await open(dir, "r");
    try {
      await folder.sync();
    } finally {
      await folder.close();
    }
  } catch {
    // The file is in place; only its durability across a power cut is less certain.
  }
}

interface Folder {
  /** Tokama can make the first commit: the folder is no git repo yet, or the repo has no commit. */
  readonly canSetUp?: true;
  /** Real path. */
  readonly path: string;
  /** Why the folder isn't a git repo's top folder; undefined when it is. */
  readonly gitProblem?: string;
  readonly branch?: string;
  /** False when HEAD names no commit yet. */
  readonly hasCommits: boolean;
}

/** The path is user input (a folder picker result): a full path to a readable folder. */
async function inspectFolder(git: Pick<Git, "worktreeList" | "revParse" | "topLevel">, path: string): Promise<Result<Folder, RepoEditError>> {
  if (path === "" || path.includes("\0") || !isAbsolute(path)) return invalid("The folder must be a full path, such as /home/me/code/orders-api.");
  let real: string;
  try {
    real = await realpath(path);
    if (!(await stat(real)).isDirectory()) return invalid(`${quotePath(path)} isn't a folder.`);
    await access(real, constants.R_OK | constants.X_OK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return invalid(`The folder ${quotePath(path)} doesn't exist.`);
    return invalid(`The folder ${quotePath(path)} can't be read (${code ?? "unknown error"}).`);
  }
  const worktrees = await git.worktreeList(real);
  if (!worktrees.ok) {
    const notRepo = worktrees.error.reason === "failed" && /not a git repository/i.test(worktrees.error.message);
    // A .git entry git can't use (a link to nowhere): git init would write through it.
    if (notRepo && (await exists(join(real, ".git")))) return ok({ path: real, hasCommits: false, gitProblem: "This folder has a .git entry that git can't use. Remove it or pick another folder." });
    return ok({ path: real, hasCommits: false, gitProblem: gitFailure(worktrees.error), ...(notRepo ? { canSetUp: true as const } : {}) });
  }
  for (const worktree of worktrees.value) {
    if ((await realpathOr(worktree.path)) !== real) continue;
    if (worktree.bare) return ok({ path: real, hasCommits: false, gitProblem: "This folder is a bare git repo; Tokama needs one with files checked out." });
    const branch = worktree.branch?.replace(/^refs\/heads\//, "");
    // A core.worktree setting can point the work tree elsewhere: `add -A` would stage that folder.
    const top = await git.topLevel(real);
    if (!top.ok) return ok({ path: real, hasCommits: false, gitProblem: gitFailure(top.error) });
    if ((await realpathOr(top.value)) !== real) return ok({ path: real, hasCommits: false, gitProblem: "This repo's git settings point outside the folder, so Tokama won't use it." });
    // A repo with no commit has no HEAD to resolve: git exits non-zero, which is not a failure to run git.
    const head = await git.revParse(real, "HEAD");
    if (!head.ok && head.error.reason !== "failed") return ok({ path: real, hasCommits: false, gitProblem: gitFailure(head.error) });
    return ok({ path: real, hasCommits: head.ok, ...(head.ok ? {} : { canSetUp: true as const }), ...(branch !== undefined && BRANCH.test(branch) ? { branch } : {}) });
  }
  return ok({ path: real, hasCommits: false, gitProblem: "This folder is inside a git repo. Pick the repo's top folder, the one that holds .git." });
}

/** Why git could not list the folder's worktrees, in plain words. */
function gitFailure(error: GitError): string {
  if (error.reason !== "failed") return `Tokama couldn't run git to check this folder (${error.reason}).`;
  if (/not a git repository/i.test(error.message)) return NOT_A_REPO;
  // Such as "detected dubious ownership": git names the problem on its first line.
  const first = error.message.split("\n").find((line) => line.trim() !== "") ?? `exit code ${String(error.exitCode)}`;
  return `git can't use this folder: ${clean(first.replace(/^fatal:\s*/, ""), 200)}`;
}

/** The id of the repo already added at this real path. */
async function addedAs(repos: readonly Repo[], real: string): Promise<string | undefined> {
  for (const repo of repos) if ((await realpathOr(repo.path)) === real) return repo.id;
  return undefined;
}

async function realpathOr(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/** The folder name as an id (`Orders_API` gives `orders-api`), made unique with `-2`, `-3`, ... */
const takenIds = (options: RepoEditOptions, repos: readonly Repo[]): Set<string> => new Set([...repos.map((repo) => repo.id), ...(options.reservedIds ?? [])]);

function suggestId(path: string, taken: ReadonlySet<string>): RepoId | undefined {
  const base = basename(path).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  if (!RepoIdSchema.safeParse(base).success) return undefined;
  for (let n = 1; n < 100; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (!taken.has(id)) return id as RepoId;
  }
  return undefined;
}

const LOCKFILES = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
] as const;

/** Fixed commands only, never script bodies: `pnpm test`, then `pnpm lint` (`npm run lint` for npm). */
async function suggestChecks(folder: string): Promise<{ commands: string[]; hasPackageJson: boolean }> {
  const hasPackageJson = await exists(join(folder, "package.json"));
  const pkg = await readJsonFile(join(folder, "package.json"), { maxBytes: 256 * 1024 });
  if (!pkg.ok || typeof pkg.value !== "object" || pkg.value === null) return { commands: [], hasPackageJson };
  const scripts = (pkg.value as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null) return { commands: [], hasPackageJson };
  const { test, lint } = scripts as Record<string, unknown>;
  let manager: string = "npm";
  for (const [lockfile, name] of LOCKFILES) {
    if (await exists(join(folder, lockfile))) {
      manager = name;
      break;
    }
  }
  const checks: string[] = [];
  if (typeof test === "string" && test.trim() !== "" && !test.includes(NPM_PLACEHOLDER_TEST)) checks.push(`${manager} test`);
  if (typeof lint === "string" && lint.trim() !== "") checks.push(manager === "npm" ? "npm run lint" : `${manager} lint`);
  return { commands: checks, hasPackageJson };
}

/** `node --check` on the first entry file a plain JS project has: it only proves the file parses. */
async function suggestFallbackCheck(folder: string): Promise<string | undefined> {
  for (const file of ENTRY_FILES) if (await isFile(join(folder, file))) return `node --check ${file}`;
  return undefined;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
