// Changes to `repos.yaml`: suggest the settings of a folder, add it as a repo, remove a repo.
// Only the engine calls these, one at a time. The file is edited as a YAML document, so its format
// line, comments and order stay. The result must pass the rules loadRepos uses before it is
// written: a temp file in the same folder, fsync, rename. A linked repos.yaml keeps its link: the
// file behind it is replaced.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { Document, isSeq, parseDocument } from "yaml";
import { readJsonFile } from "../../kernel/fs-safe/index.js";
import type { Git, GitError } from "../../kernel/git/index.js";
import { err, ok, type Result } from "../../kernel/result/index.js";
import { MAX_CHECK_CHARS, type RepoId, RepoIdSchema } from "../../kernel/schemas/index.js";
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
  readonly git: Pick<Git, "worktreeList">;
  /** Ids a new repo can't take though repos.yaml doesn't hold them, such as the sample engine's repos. */
  readonly reservedIds?: readonly string[];
}

/** What the engine proposes for a folder before it is added. */
export interface RepoSuggestion {
  /** The folder's real path. */
  readonly path: string;
  readonly gitRepo: boolean;
  /** The current branch; undefined when HEAD is detached or the folder isn't a repo. */
  readonly branch: string | undefined;
  /** From the folder name, not used by another repo; undefined when the name gives none. */
  readonly id: RepoId | undefined;
  /** From package.json scripts: test, then lint, run with the lockfile's package manager. */
  readonly checks: readonly string[];
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

export async function suggestRepo(options: RepoEditOptions, path: string): Promise<Result<RepoSuggestion, RepoEditError>> {
  const folder = await inspectFolder(options.git, path);
  if (!folder.ok) return folder;
  const file = await readCurrent(options);
  const repos = file.ok ? file.value.repos : [];
  const added = await addedAs(repos, folder.value.path);
  return ok({
    path: folder.value.path,
    gitRepo: folder.value.gitProblem === undefined,
    branch: folder.value.branch,
    id: suggestId(folder.value.path, takenIds(options, repos)),
    checks: await suggestChecks(folder.value.path),
    problem: folder.value.gitProblem ?? (added === undefined ? undefined : `This folder is already added as ${quote(added)}.`),
  });
}

export async function addRepo(options: RepoEditOptions, input: AddRepoInput): Promise<Result<Repo, RepoEditError>> {
  const folder = await inspectFolder(options.git, input.path);
  if (!folder.ok) return folder;
  if (folder.value.gitProblem !== undefined) return invalid(folder.value.gitProblem);
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
  if (!BRANCH.test(baseBranch) || baseBranch.length > MAX_BRANCH) return invalid(`The base branch ${quote(baseBranch)} must be a branch name, such as main.`);

  const checks = (input.checks ?? []).map((command) => command.trim()).filter((command) => command !== "");
  for (const command of checks) {
    if (command.length > MAX_CHECK_CHARS) return invalid(`The check ${quote(command)} must be at most ${MAX_CHECK_CHARS} characters.`);
    const problem = checkProblem(command);
    if (problem !== undefined) return invalid(`The check ${quote(command)} ${problem}.`);
  }

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
  /** Real path. */
  readonly path: string;
  /** Why the folder isn't a git repo's top folder; undefined when it is. */
  readonly gitProblem?: string;
  readonly branch?: string;
}

/** The path is user input (a folder picker result): a full path to a readable folder. */
async function inspectFolder(git: Pick<Git, "worktreeList">, path: string): Promise<Result<Folder, RepoEditError>> {
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
  if (!worktrees.ok) return ok({ path: real, gitProblem: gitFailure(worktrees.error) });
  for (const worktree of worktrees.value) {
    if ((await realpathOr(worktree.path)) !== real) continue;
    if (worktree.bare) return ok({ path: real, gitProblem: "This folder is a bare git repo; Tokama needs one with files checked out." });
    const branch = worktree.branch?.replace(/^refs\/heads\//, "");
    return ok({ path: real, ...(branch !== undefined && BRANCH.test(branch) ? { branch } : {}) });
  }
  return ok({ path: real, gitProblem: "This folder is inside a git repo. Pick the repo's top folder, the one that holds .git." });
}

/** Why git could not list the folder's worktrees, in plain words. */
function gitFailure(error: GitError): string {
  if (error.reason !== "failed") return `Tokama couldn't run git to check this folder (${error.reason}).`;
  if (/not a git repository/i.test(error.message)) return "This folder isn't a git repo.";
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
async function suggestChecks(folder: string): Promise<string[]> {
  const pkg = await readJsonFile(join(folder, "package.json"), { maxBytes: 256 * 1024 });
  if (!pkg.ok || typeof pkg.value !== "object" || pkg.value === null) return [];
  const scripts = (pkg.value as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null) return [];
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
  return checks;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
