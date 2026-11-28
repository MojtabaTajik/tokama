// Changes to `repos.yaml`: suggest the settings of a folder, add it as a repo, change a repo's base
// branch and checks, remove a repo, and set a folder up with git and a first commit.
// Only the engine calls these, one at a time. The file is edited as a YAML document, so its format
// line, comments and order stay. The result must pass the rules loadRepos uses before it is
// written: a temp file in the same folder, fsync, rename. A linked repos.yaml keeps its link: the
// file behind it is replaced.
import { constants } from "node:fs";
import { homedir } from "node:os";
import { access, lstat, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
// eslint-disable-next-line no-restricted-imports -- a new .gitignore is created exclusively (flag wx), so the user's own file is never replaced.
import { writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { Document, isMap, isScalar, isSeq, parseDocument } from "yaml";
import { readJsonFile, replaceTextSync } from "../../kernel/fs-safe/index.js";
import type { Git, GitError } from "../../kernel/git/index.js";
import { err, ok, type Result } from "../../kernel/result/index.js";
import { MAX_CHECK_CHARS, RESERVED_REPO_IDS, type RepoId, RepoIdSchema } from "../../kernel/schemas/index.js";
import { displayPath } from "../../kernel/text/index.js";
import { DEFAULT_GITIGNORE, type FirstCommitPreview, GITIGNORE_FILE, previewFirstCommit } from "./first-commit.js";
import { MAX_CONFIG_BYTES } from "./read.js";
import { type BranchChoice, type BranchChoices, NO_BRANCH_CHOICES, readBranchChoices } from "./branches.js";
import { simpleCommandProblem } from "../../kernel/command-policy/index.js";
import { BRANCH, MAX_BRANCH, DEFAULT_WORKTREE_FOLDER, type LoadReposOptions, type Repo, readReposFile, REPOS_FILE, type ReposFile, ReposFileSchema } from "./repos.js";
import { clean, CONFIG_FORMAT, formatProblem, parseYaml, quote, type ConfigProblem } from "./yaml-file.js";
import { errnoCode } from "../../kernel/errno/index.js";

/** Why a repo change was refused. `invalid_config`: repos.yaml itself has problems to fix first. */
export interface RepoEditError {
  readonly code: "invalid_request" | "already_exists" | "not_found" | "invalid_config" | "write_failed";
  readonly message: string;
}

export interface RepoEditOptions extends LoadReposOptions {
  /** Tells whether a folder is a git repo's top folder, and its branch. */
  readonly git: Pick<Git, "worktreeList" | "revParse" | "topLevel" | "branches" | "remoteHead" | "currentRef" | "init" | "addAll" | "diffCachedNumstat" | "commit">;
  /** Ids a new repo can't take though repos.yaml doesn't hold them, such as the sample engine's repos. */
  readonly reservedIds?: readonly string[];
}

/** What the engine proposes for a folder before it is added. */
export interface RepoSuggestion {
  /** The folder's real path. */
  readonly path: string;
  /** The path for display: the home folder written as `~`. */
  readonly displayPath: string;
  readonly gitRepo: boolean;
  /** False when the repo has no commit yet: work needs a base commit to start from. */
  readonly hasCommits: boolean;
  /** The current branch; undefined when HEAD is detached or the folder isn't a repo. */
  readonly branch: string | undefined;
  /** From the folder name, not used by another repo; undefined when the name gives none. */
  readonly id: RepoId | undefined;
  /** From package.json scripts: test, then lint, run with the lockfile's package manager. */
  readonly checks: readonly string[];
  /** The package.json scripts the checks come from, such as `test` and `lint`. */
  readonly checksFrom: readonly string[];
  /** From one known file in the top folder, such as `npm ci` for package-lock.json; undefined when none or more than one kind is there. */
  readonly setup: string | undefined;
  /** The file name `setup` comes from. */
  readonly setupFrom: string | undefined;
  /** The default base branch: see `branchChoices`. Undefined when the folder isn't a repo or has none. */
  readonly defaultBranch: string | undefined;
  /** The branches to offer as the base branch, capped; empty when the folder isn't a repo or has none. */
  readonly branches: readonly BranchChoice[];
  /** Branches the cap left out of `branches`. */
  readonly moreBranches: number;
  /** With no checks: `node --check` on the package.json `main` file, or on an entry file of a JS project with no package.json. */
  readonly fallbackCheck: string | undefined;
  /** The fallback file is the `main` of package.json. */
  readonly fallbackFromPackage: boolean;
  /** Set when Tokama can make the first commit here: no git repo yet, or a repo without commits. */
  readonly firstCommit: FirstCommitPreview | undefined;
  /** Why the folder can't be added as it is, in plain words. */
  readonly problem: string | undefined;
}

export interface AddRepoInput {
  readonly path: string;
  /** Default: the suggested id. */
  readonly id?: string;
  /** Default: the repo's default branch (`branchChoices`), else the current one. */
  readonly baseBranch?: string;
  /** Default: none. */
  readonly checks?: readonly string[];
  /** Default: none. */
  readonly setup?: string;
}

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
  const fallback = checks.commands.length === 0 ? await suggestFallbackCheck(folder.value.path, checks) : undefined;
  const choices = folder.value.gitProblem === undefined ? await readBranchChoices(options.git, folder.value.path, folder.value.branch) : NO_BRANCH_CHOICES;
  const setup = await suggestSetup(folder.value.path);
  return ok({
    setup: setup?.command,
    setupFrom: setup?.from,
    path: folder.value.path,
    displayPath: await realDisplayPath(folder.value.path, options.home),
    gitRepo: folder.value.gitProblem === undefined,
    hasCommits: folder.value.hasCommits,
    branch: folder.value.branch,
    id: suggestId(folder.value.path, takenIds(options, repos)),
    checks: checks.commands,
    firstCommit: folder.value.canSetUp ? await previewFirstCommit(folder.value.path, options.home) : undefined,
    checksFrom: checks.from,
    defaultBranch: choices.defaultBranch,
    branches: choices.branches,
    moreBranches: choices.more,
    fallbackCheck: fallback?.command,
    fallbackFromPackage: fallback?.fromPackage === true,
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
  if (RESERVED_REPO_IDS.includes(id)) return invalid(`The id ${quote(id)} is reserved: template names start with builtin/ and personal/. Pick another id.`);
  if (repos.some((repo) => repo.id === id)) return refused("already_exists", `A repo with the id ${quote(id)} is already added.`);
  if (options.reservedIds?.includes(id)) return refused("already_exists", `The id ${quote(id)} is taken by a sample repo. Pick another id.`);
  const added = await addedAs(repos, folder.value.path);
  if (added !== undefined) return refused("already_exists", `This folder is already added as ${quote(added)}.`);

  const baseBranch = input.baseBranch?.trim() || (await readBranchChoices(options.git, folder.value.path, folder.value.branch)).defaultBranch;
  if (baseBranch === undefined) return invalid("The repo has no current branch (its HEAD is detached). Give a base branch, such as main.");
  const settings = checkSettings(baseBranch, input.checks ?? [], input.setup);
  if (!settings.ok) return settings;
  const { checks, setup } = settings.value;
  const local = await requireLocalBranch(options.git, folder.value.path, baseBranch);
  if (!local.ok) return local;

  const entry = { id, path: folder.value.path, base_branch: baseBranch, ...(checks.length > 0 ? { checks } : {}), ...(setup === undefined ? {} : { setup }) };
  const doc = file.value.text === undefined ? newDocument() : parseDocument(file.value.text, { uniqueKeys: true });
  const list = doc.get("repos", true);
  if (!isSeq(list)) return refused("invalid_config", `${REPOS_FILE} has no repos list.`);
  list.flow = false;
  list.items.push(doc.createNode(entry));
  const written = await write(file.value.path, doc);
  if (!written.ok) return written;
  return ok({ id: id as RepoId, path: folder.value.path, baseBranch, worktreeFolder: DEFAULT_WORKTREE_FOLDER, checks, ...(setup === undefined ? {} : { setup }) });
}

export interface UpdateRepoInput {
  readonly repoId: string;
  readonly baseBranch: string;
  /** Replaces the repo's checks; empty removes them. */
  readonly checks: readonly string[];
  /** Absent: the setup command stays. Empty: it is removed. Otherwise it replaces the current one. */
  readonly setup?: string;
}

/** Changes the base branch and checks of a repo in repos.yaml, by the rules `addRepo` uses. */
export async function updateRepo(options: LoadReposOptions & { readonly git: Pick<Git, "revParse"> }, input: UpdateRepoInput): Promise<Result<Repo, RepoEditError>> {
  const file = await readCurrent(options);
  if (!file.ok) return file;
  const index = file.value.repos.findIndex((repo) => repo.id === input.repoId);
  const current = file.value.repos[index];
  if (current === undefined || file.value.text === undefined) return refused("not_found", `No repo has the id ${quote(input.repoId)}.`);
  const baseBranch = input.baseBranch.trim();
  const settings = checkSettings(baseBranch, input.checks, input.setup);
  if (!settings.ok) return settings;
  const { checks, setup } = settings.value;
  const local = await requireLocalBranch(options.git, current.path, baseBranch);
  if (!local.ok) return local;

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
  if (input.setup !== undefined) {
    if (setup === undefined) entry.delete("setup");
    else entry.set("setup", setup);
  }
  const written = await write(file.value.path, doc);
  if (!written.ok) return written;
  const kept = input.setup === undefined ? current.setup : setup;
  return ok({ id: current.id, path: current.path, ...(current.remote === undefined ? {} : { remote: current.remote }), baseBranch, worktreeFolder: current.worktreeFolder, checks, ...(kept === undefined ? {} : { setup: kept }) });
}

/**
 * The branches to offer for an added repo's base branch. A folder that is gone or no longer a
 * repo gives an empty list, so the base branch can still be typed.
 */
export async function repoBranches(options: RepoEditOptions, repoId: string): Promise<Result<BranchChoices, RepoEditError>> {
  const file = await readCurrent(options);
  if (!file.ok) return file;
  const repo = file.value.repos.find((entry) => entry.id === repoId);
  if (repo === undefined) return refused("not_found", `No repo has the id ${quote(repoId)}.`);
  const head = await options.git.currentRef(repo.path);
  const current = head.ok ? head.value?.replace(/^refs\/heads\//, "") : undefined;
  return ok(await readBranchChoices(options.git, repo.path, current));
}

/** What `initRepo` did, so a client can say it: git init ran, and the .gitignore it wrote has this many rules. */
export interface InitRepoResult {
  readonly gitInit: boolean;
  readonly ignoreRules: number | null;
}

/**
 * First step of making a folder ready to add: `git init` when it is no repo, and a default
 * .gitignore when it has none. A repo that has a commit already is left alone, so a second call
 * after a later failure does no harm.
 */
export async function initRepo(options: RepoEditOptions, input: { readonly path: string; readonly baseBranch?: string }): Promise<Result<InitRepoResult, RepoEditError>> {
  const folder = await inspectFolder(options.git, input.path);
  if (!folder.ok) return folder;
  if (!folder.value.canSetUp) return folder.value.gitProblem === undefined ? ok({ gitInit: false, ignoreRules: null }) : invalid(folder.value.gitProblem);
  const preview = await previewFirstCommit(folder.value.path, options.home);
  if (preview.refusal !== undefined) return invalid(preview.refusal);
  const path = folder.value.path;
  const isNew = folder.value.gitProblem !== undefined;
  if (isNew) {
    const branch = input.baseBranch?.trim() || "main";
    if (!BRANCH.test(branch) || branch.length > MAX_BRANCH) return invalid(`The base branch ${quote(branch)} must be a branch name, such as main.`);
    const init = await options.git.init(path, branch);
    if (!init.ok) return invalid(`Tokama couldn't set up git here: ${gitReason(init.error)}`);
  }
  if (preview.addsGitignore) {
    try {
      await writeFile(join(path, GITIGNORE_FILE), `${DEFAULT_GITIGNORE.join("\n")}\n`, { flag: "wx" });
    } catch (error) {
      return invalid(`Tokama couldn't write ${GITIGNORE_FILE} (${errnoCode(error) ?? String(error)}).`);
    }
  }
  return ok({ gitInit: isNew, ignoreRules: preview.addsGitignore ? DEFAULT_GITIGNORE.length : null });
}

/**
 * Second step: a first commit of everything git does not ignore, in a repo that has none. A repo
 * with a commit already is left alone (`files` is then 0).
 */
export async function makeFirstCommit(options: RepoEditOptions, input: { readonly path: string }): Promise<Result<{ readonly commit: string; readonly files: number }, RepoEditError>> {
  const folder = await inspectFolder(options.git, input.path);
  if (!folder.ok) return folder;
  const path = folder.value.path;
  if (!folder.value.canSetUp) {
    if (folder.value.gitProblem !== undefined) return invalid(folder.value.gitProblem);
    const head = await options.git.revParse(path, "HEAD");
    return head.ok ? ok({ commit: head.value.slice(0, 7), files: 0 }) : invalid(gitReason(head.error));
  }
  if (folder.value.gitProblem !== undefined) return invalid("This folder isn't a git repo yet. Set up git first.");
  const preview = await previewFirstCommit(path, options.home);
  if (preview.refusal !== undefined) return invalid(preview.refusal);
  const added = await options.git.addAll(path);
  if (!added.ok) return invalid(gitReason(added.error));
  // Files staged before (in a repo with no commit) are not in the preview, and an ignore rule does
  // not unstage them: refuse rather than commit what the user was not shown.
  const staged = await options.git.diffCachedNumstat(path);
  if (!staged.ok) return invalid(gitReason(staged.error));
  // A path the preview did not name is refused, however it got staged: files staged before, or one
  // a negation in the folder's own .gitignore (`secret*` then `!secret.key`) lets through.
  const unexpected = staged.value.map((entry) => entry.path).filter((entry) => !preview.paths.has(entry.normalize("NFC")));
  if (unexpected.length > 0) {
    const shown = unexpected.slice(0, 3).map((entry) => quote(entry)).join(", ");
    return invalid(`Git would also commit ${plural(unexpected.length)}, such as ${shown}, which the list did not show. Unstage them (git reset) or fix the .gitignore, then try again.`);
  }
  const committed = await options.git.commit(path, "Initial commit");
  if (!committed.ok) return invalid(gitReason(committed.error));
  return ok({ commit: committed.value.slice(0, 7), files: staged.value.length });
}

/** The path for display: the home folder (as its real path, which is what `path` is) written as `~`. */
async function realDisplayPath(path: string, home: string | undefined): Promise<string> {
  return displayPath(path, { home: await realpathOr(home ?? homedir()) });
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

/** The base branch, checks and setup command a repo may have, trimmed; a bad one is refused in plain words. A blank setup is undefined. */
function checkSettings(baseBranch: string, input: readonly string[], setupInput?: string): Result<{ checks: string[]; setup: string | undefined }, RepoEditError> {
  if (!BRANCH.test(baseBranch) || baseBranch.length > MAX_BRANCH) return invalid(`The base branch ${quote(baseBranch)} must be a branch name, such as main.`);
  const checks = input.map((command) => command.trim()).filter((command) => command !== "");
  const setup = setupInput?.trim() || undefined;
  for (const [label, command] of [...checks.map((check) => ["check", check] as const), ...(setup === undefined ? [] : [["setup command", setup] as const])]) {
    if (command.length > MAX_CHECK_CHARS) return invalid(`The ${label} ${quote(command)} must be at most ${MAX_CHECK_CHARS} characters.`);
    const problem = simpleCommandProblem(command);
    if (problem !== undefined) return invalid(`The ${label} ${quote(command)} ${problem}.`);
  }
  return ok({ checks, setup });
}

/**
 * Items start from `refs/heads/<name>`, so the base branch must be a local branch. A remote name
 * (`origin/main`) or a full ref (`refs/heads/main`) is refused; when the local branch it points
 * to exists, the message names it.
 */
async function requireLocalBranch(git: Pick<Git, "revParse">, repoPath: string, name: string): Promise<Result<void, RepoEditError>> {
  // A repo whose folder was moved or deleted: git cannot start there, and the folder is the cause to name.
  if (!(await exists(repoPath))) return invalid(`The repo folder ${quotePath(repoPath)} can't be found, so the base branch can't be checked. Put the folder back or remove the repo.`);
  const found = await localBranchExists(git, repoPath, name);
  if (!found.ok) return found;
  if (found.value) return ok(undefined);
  const short = name.replace(/^(?:refs\/heads\/|origin\/)/, "");
  let instead = "Pick one of its local branches.";
  if (short !== name && BRANCH.test(short) && short.length <= MAX_BRANCH) {
    const local = await localBranchExists(git, repoPath, short);
    if (local.ok && local.value) instead = `Use ${quote(short)} instead.`;
  }
  return invalid(`The base branch ${quote(name)} is not a local branch of this repo. ${instead}`);
}

async function localBranchExists(git: Pick<Git, "revParse">, repoPath: string, name: string): Promise<Result<boolean, RepoEditError>> {
  const found = await git.revParse(repoPath, `refs/heads/${name}^{commit}`);
  if (found.ok) return ok(true);
  // A missing branch is a git failure; a git that cannot run says nothing about the branch.
  return found.error.reason === "failed" ? ok(false) : invalid(`Tokama couldn't run git to check the base branch (${found.error.reason}).`);
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
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  } catch (error) {
    return refused("write_failed", `${REPOS_FILE} can't be written (${errnoCode(error) ?? String(error)}).`);
  }
  const written = replaceTextSync(path, text, 0o600);
  return written.ok ? ok(undefined) : refused("write_failed", `${REPOS_FILE} can't be written (${written.error.code ?? written.error.reason}).`);
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
    const code = errnoCode(error);
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

const plural = (count: number) => `${count} ${count === 1 ? "file" : "files"}`;

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
const takenIds = (options: RepoEditOptions, repos: readonly Repo[]): Set<string> => new Set([...repos.map((repo) => repo.id), ...RESERVED_REPO_IDS, ...(options.reservedIds ?? [])]);

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

/**
 * The setup command a known file in the top folder points to; the folder is not read deeper. Two
 * kinds of file at once (a pnpm and an npm lockfile, a .sln and a go.mod) leave it open: no
 * suggestion.
 */
export async function suggestSetup(folder: string): Promise<{ command: string; from: string } | undefined> {
  let names: string[];
  try {
    names = (await readdir(folder)).sort();
  } catch {
    return undefined;
  }
  const found: { command: string; from: string }[] = [];
  for (const [file, command] of SETUP_FILES) if (names.includes(file)) found.push({ command, from: file });
  // Yarn 1 does not know --immutable: its lockfile has no __metadata header, and its flag is --frozen-lockfile.
  const yarn = found.find((entry) => entry.from === "yarn.lock");
  if (yarn !== undefined && !(await readHead(join(folder, "yarn.lock"))).includes("__metadata:")) yarn.command = "yarn install --frozen-lockfile";
  // The name is shown to the user: a name with control, invisible or direction characters is not offered.
  const dotnet = names.find((name) => /\.(sln|csproj)$/i.test(name) && name.length <= 255 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name));
  if (dotnet !== undefined) found.push({ command: "dotnet restore", from: dotnet });
  return found.length === 1 ? found[0] : undefined;
}

/** The first 4 KB of a file as text; empty when it cannot be read. */
async function readHead(path: string): Promise<string> {
  try {
    const file = await open(path, "r");
    try {
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return buffer.toString("utf8", 0, bytesRead);
    } finally {
      await file.close();
    }
  } catch {
    return "";
  }
}

const SETUP_FILES = [
  ["package-lock.json", "npm ci"],
  ["pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
  ["yarn.lock", "yarn install --immutable"],
  ["go.mod", "go mod download"],
] as const;

/** Fixed commands only, never script bodies: `pnpm test`, then `pnpm lint` (`npm run lint` for npm). */
async function suggestChecks(folder: string): Promise<{ commands: string[]; from: string[]; hasPackageJson: boolean; main: string | undefined }> {
  const hasPackageJson = await exists(join(folder, "package.json"));
  const pkg = await readJsonFile(join(folder, "package.json"), { maxBytes: 256 * 1024 });
  if (!pkg.ok || typeof pkg.value !== "object" || pkg.value === null) return { commands: [], from: [], hasPackageJson, main: undefined };
  const main = (pkg.value as { main?: unknown }).main;
  const mainFile = typeof main === "string" ? main : undefined;
  const scripts = (pkg.value as { scripts?: unknown }).scripts;
  if (typeof scripts !== "object" || scripts === null) return { commands: [], from: [], hasPackageJson, main: mainFile };
  const { test, lint } = scripts as Record<string, unknown>;
  let manager: string = "npm";
  for (const [lockfile, name] of LOCKFILES) {
    if (await exists(join(folder, lockfile))) {
      manager = name;
      break;
    }
  }
  const checks: string[] = [];
  const from: string[] = [];
  if (typeof test === "string" && test.trim() !== "" && !test.includes(NPM_PLACEHOLDER_TEST)) {
    checks.push(`${manager} test`);
    from.push("test");
  }
  if (typeof lint === "string" && lint.trim() !== "") {
    checks.push(manager === "npm" ? "npm run lint" : `${manager} lint`);
    from.push("lint");
  }
  return { commands: checks, from, hasPackageJson, main: mainFile };
}

/**
 * `node --check` on the file named by package.json `main`, or without a package.json on the first
 * entry file a plain JS project has. It only proves the file parses.
 */
async function suggestFallbackCheck(folder: string, found: { hasPackageJson: boolean; main: string | undefined }): Promise<{ command: string; fromPackage: boolean } | undefined> {
  if (found.hasPackageJson) {
    const main = found.main;
    // A plain relative path inside the folder: it becomes a word of a command.
    if (main !== undefined && /^(?!\/)(?!.*\.\.)[\w./-]+$/.test(main) && (await isFile(join(folder, main)))) return { command: `node --check ${main}`, fromPackage: true };
    return undefined;
  }
  for (const file of ENTRY_FILES) if (await isFile(join(folder, file))) return { command: `node --check ${file}`, fromPackage: false };
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
