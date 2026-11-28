// Which files in an item's worktree the tamper checks protect, by path. Two kinds:
// - from the base commit only: test files and snapshots that existed when the item started. An
//   agent may add tests; changing or deleting the ones the checks were written against is tamper.
// - by pattern, at any time: test config, package manifests and package-manager config, CI
//   files, build config, lockfiles, `.gitattributes` and `.tokama/`. A new `vitest.config.ts` or workflow file
//   is tamper too.
// JS/TS first, with the manifests and lockfiles of Python, .NET, Go, Rust and Java. Paths are repo-relative with "/" separators;
// names match in lowercase (macOS and Windows file systems ignore case).

export type ProtectedCategory =
  /** Git config, hooks, refs and attributes, and the worktree's `.git` file. */
  | "git"
  /** Tokama's own files in a repo: templates, agents. */
  | "tokama"
  | "test"
  | "snapshot"
  | "test-config"
  /** package.json, the manifests of other ecosystems (`go.mod`, `Cargo.toml`, `pom.xml`, `Directory.Packages.props`), package-manager config and build config (`Directory.Build.props`, `NuGet.Config`, `.cargo/config.toml`, `build.rs`, Gradle build and settings files): they choose what a test run and an install run. */
  | "package"
  | "ci"
  | "lockfile";

const TEST_FILE = [
  /\.(?:test|spec)\.[cm]?[jt]sx?$/,
  /_test\.go$/,
  /(?:^|\/)test_[^/]*\.py$/,
  /_test\.py$/,
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
  /^vite\.config\.[cm]?[jt]s$/,
  /^pytest\.ini$/,
  /^tox\.ini$/,
  /^conftest\.py$/,
];

const PACKAGE_CONFIG = [
  /^package\.json$/,
  /^pnpm-workspace\.yaml$/,
  /^\.pnpmfile\.[cm]js$/,
  /^\.npmrc$/,
  /^\.yarnrc(?:\..+)?$/,
  /^directory\.packages\.props$/,
  /^go\.mod$/,
  /^cargo\.toml$/,
  /^pom\.xml$/,
  // Build config: files that choose what a build runs and which sources it takes packages from.
  /^directory\.build\.(?:props|targets)$/,
  /^nuget\.config$/,
  /^build\.rs$/,
  /^(?:build|settings)\.gradle(?:\.kts)?$/,
];
/** Package config that is named by its folder too: Cargo reads `.cargo/config.toml` (or the older `.cargo/config`) in any parent folder. */
const PACKAGE_PATHS = [/(?:^|\/)\.cargo\/config(?:\.toml)?$/];

const LOCKFILES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "go.sum",
  "cargo.lock",
  "poetry.lock",
  "uv.lock",
  "pipfile.lock",
  "packages.lock.json",
]);

/** Root-level CI folders and files. */
export const CI_DIRS: readonly string[] = [".github/workflows", ".github/actions", ".circleci", ".buildkite"];
const CI_FILES = new Set([".gitlab-ci.yml", "jenkinsfile", ".travis.yml"]);

export const TOKAMA_DIR = ".tokama";

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const under = (path: string, dir: string) => path.startsWith(`${dir}/`);

/** Whether a lowercase path is a CI file: a root CI file, a file in a CI folder, or an Azure Pipelines file in any folder. */
export const isCiPath = (path: string): boolean => CI_FILES.has(path) || CI_DIRS.some((dir) => under(path, dir)) || /(?:^|\/)azure-pipelines[^/]*\.ya?ml$/.test(path);

/** The category of a file that existed in the base commit, or undefined when only its pattern counts. */
export function baseCategory(original: string): "test" | "snapshot" | undefined {
  const path = original.toLowerCase();
  if (SNAPSHOT.some((pattern) => pattern.test(path))) return "snapshot";
  if (TEST_FILE.some((pattern) => pattern.test(path))) return "test";
  if (path.split("/").slice(0, -1).some((dir) => TEST_DIRS.has(dir))) return "test";
  return undefined;
}

/** The category of a file protected wherever and whenever it appears, or undefined. */
export function patternCategory(original: string): "tokama" | "git" | "test-config" | "package" | "ci" | "lockfile" | undefined {
  const path = original.toLowerCase();
  if (under(path, TOKAMA_DIR)) return "tokama";
  if (isCiPath(path)) return "ci";
  const name = basename(path);
  if (LOCKFILES.has(name)) return "lockfile";
  if (name === ".gitattributes") return "git";
  if (TEST_CONFIG.some((pattern) => pattern.test(name))) return "test-config";
  if (PACKAGE_CONFIG.some((pattern) => pattern.test(name)) || PACKAGE_PATHS.some((pattern) => pattern.test(path))) return "package";
  return undefined;
}
