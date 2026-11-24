// Which files in an item's worktree the tamper checks protect, by path. Two kinds:
// - from the base commit only: test files and snapshots that existed when the item started. An
//   agent may add tests; changing or deleting the ones the checks were written against is tamper.
// - by pattern, at any time: test config, CI files, lockfiles and `.tokama/`. A new
//   `vitest.config.ts` or workflow file is tamper too.
// JS/TS first, with the obvious Go and Python names. Paths are repo-relative with "/" separators.

export type ProtectedCategory =
  /** Git config, hooks and attributes, and the worktree's `.git` file. */
  | "git"
  /** Tokama's own files in a repo: templates, agents. */
  | "tokama"
  | "test"
  | "snapshot"
  | "test-config"
  | "ci"
  | "lockfile";

const TEST_FILE = [
  /\.(?:test|spec)\.[cm]?[jt]sx?$/,
  /_test\.go$/,
  /(?:^|\/)test_[^/]*\.py$/,
  /_test\.py$/,
  /(?:^|\/)conftest\.py$/,
];
/** Folders whose every file is test code or test data. */
const TEST_DIRS = new Set(["__tests__", "test", "tests", "__mocks__", "__fixtures__"]);

const SNAPSHOT = [/(?:^|\/)__snapshots__\//, /\.snap$/];

const TEST_CONFIG = [
  /^(?:vitest|jest|playwright|cypress)\.config\.[cm]?[jt]s$/,
  /^vitest\.(?:workspace|projects)\.[cm]?[jt]s$/,
  /^jest\.setup\.[cm]?[jt]s$/,
  /^karma\.conf\.[cm]?js$/,
  /^\.mocharc(?:\.(?:c?js|json|jsonc|ya?ml))?$/,
  /^pytest\.ini$/,
  /^tox\.ini$/,
];

const LOCKFILES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "go.sum",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
]);

/** Root-level CI folders and files. */
export const CI_DIRS: readonly string[] = [".github/workflows", ".github/actions", ".circleci", ".buildkite"];
const CI_FILES = new Set([".gitlab-ci.yml", "azure-pipelines.yml", "Jenkinsfile", ".travis.yml"]);

export const TOKAMA_DIR = ".tokama";

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const under = (path: string, dir: string) => path.startsWith(`${dir}/`);

/** The category of a file that existed in the base commit, or undefined when only its pattern counts. */
export function baseCategory(path: string): "test" | "snapshot" | undefined {
  if (SNAPSHOT.some((pattern) => pattern.test(path))) return "snapshot";
  if (TEST_FILE.some((pattern) => pattern.test(path))) return "test";
  if (path.split("/").slice(0, -1).some((dir) => TEST_DIRS.has(dir))) return "test";
  return undefined;
}

/** The category of a file protected wherever and whenever it appears, or undefined. */
export function patternCategory(path: string): "tokama" | "test-config" | "ci" | "lockfile" | undefined {
  if (under(path, TOKAMA_DIR)) return "tokama";
  if (CI_FILES.has(path) || CI_DIRS.some((dir) => under(path, dir))) return "ci";
  const name = basename(path);
  if (LOCKFILES.has(name)) return "lockfile";
  if (TEST_CONFIG.some((pattern) => pattern.test(name))) return "test-config";
  return undefined;
}
