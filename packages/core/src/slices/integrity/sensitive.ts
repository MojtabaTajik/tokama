// Which kind of file a change touches, by repo-relative path: the one fixed table behind the
// Changed row and the risk rules. Dependencies, migrations, CI, infrastructure, secrets and
// settings, and sign-in code are sensitive; test files are counted apart (added or edited).
// Some rows belong to one kind of repo (a .NET `appsettings.json`, a Python `settings.py`); the
// kinds of a repo come from marker files in its base commit and from the extensions of the
// changed files, and a repo can be several kinds. Paths match in lowercase, as in `protected.ts`.
import type { TouchKind } from "../../kernel/schemas/index.js";
import { baseCategory, patternCategory } from "./protected.js";

export type RepoKind = "node" | "dotnet" | "python" | "go" | "rust" | "java";

/** Files at the repo root that name the kind of repo. */
export const KIND_MARKERS: Readonly<Record<RepoKind, readonly string[]>> = {
  node: ["package.json"],
  dotnet: ["global.json", "Directory.Packages.props", "Directory.Build.props"],
  python: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"],
  go: ["go.mod"],
  rust: ["Cargo.toml"],
  java: ["pom.xml", "build.gradle", "build.gradle.kts"],
};

const EXTENSIONS: readonly (readonly [RegExp, RepoKind])[] = [
  [/\.[cm]?[jt]sx?$/, "node"],
  [/\.(?:cs|csproj|fsproj|vbproj|sln)$/, "dotnet"],
  [/\.py$/, "python"],
  [/\.go$/, "go"],
  [/\.rs$/, "rust"],
  [/\.(?:java|kt)$/, "java"],
];

/** The kinds of a repo: the markers present in it, and what the changed files are written in. */
export function repoKinds(markersPresent: readonly string[], changedPaths: readonly string[]): ReadonlySet<RepoKind> {
  const kinds = new Set<RepoKind>();
  const present = new Set([...markersPresent, ...changedPaths.filter((path) => !path.includes("/"))]);
  for (const [kind, markers] of Object.entries(KIND_MARKERS) as [RepoKind, readonly string[]][]) {
    if (markers.some((marker) => present.has(marker))) kinds.add(kind);
  }
  for (const path of changedPaths) {
    const lower = path.toLowerCase();
    for (const [pattern, kind] of EXTENSIONS) if (pattern.test(lower)) kinds.add(kind);
  }
  return kinds;
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const folders = (path: string) => path.split("/").slice(0, -1);
const kindsAny = (kinds: ReadonlySet<RepoKind>, ...wanted: RepoKind[]) => wanted.some((kind) => kinds.has(kind));

function isDependency(path: string, name: string, kinds: ReadonlySet<RepoKind>): boolean {
  const category = patternCategory(path);
  if (category === "package" || category === "lockfile") return true;
  if (kindsAny(kinds, "dotnet") && (/\.csproj$/.test(name) || ["directory.packages.props", "packages.lock.json", "global.json"].includes(name))) return true;
  if (kindsAny(kinds, "python") && (name === "pyproject.toml" || /^requirements.*\.txt$/.test(name))) return true;
  if (kindsAny(kinds, "go") && name === "go.mod") return true;
  if (kindsAny(kinds, "rust") && name === "cargo.toml") return true;
  return kindsAny(kinds, "java") && (name === "pom.xml" || /^build\.gradle/.test(name));
}

function isMigration(path: string, name: string, kinds: ReadonlySet<RepoKind>): boolean {
  if (folders(path).includes("migrations") || name.endsWith(".sql")) return true;
  if (kindsAny(kinds, "node") && path.endsWith("prisma/schema.prisma")) return true;
  if (kindsAny(kinds, "python") && folders(path).includes("alembic")) return true;
  return kindsAny(kinds, "go", "rust", "java") && `/${path}`.includes("/db/migrate/");
}

function isInfrastructure(path: string, name: string): boolean {
  if (name.startsWith("dockerfile") || /^docker-compose.*\.ya?ml$/.test(name)) return true;
  if (/\.(?:tf|tfvars|bicep)$/.test(name)) return true;
  return folders(path).some((folder) => folder === "k8s" || folder === "helm" || folder === "charts");
}

function isSecret(path: string, name: string, kinds: ReadonlySet<RepoKind>): boolean {
  if (name.startsWith(".env") || path.split("/").some((part) => part.startsWith("secrets"))) return true;
  if (kindsAny(kinds, "dotnet") && /^appsettings.*\.json$/.test(name)) return true;
  return kindsAny(kinds, "python") && /^settings.*\.py$/.test(name);
}

const isSignIn = (path: string) => folders(path).some((folder) => folder === "auth" || folder === "security");

/** The kind of a changed file: a test file is added or edited; any other is sensitive or has none. `added` is whether the change created the file. */
export function touchOf(original: string, added: boolean, kinds: ReadonlySet<RepoKind>): TouchKind | undefined {
  if (baseCategory(original) === "test") return added ? "tests_added" : "tests_edited";
  const path = original.toLowerCase();
  const name = basename(path);
  if (patternCategory(path) === "ci" || /(?:^|\/)azure-pipelines[^/]*\.ya?ml$/.test(path)) return "ci";
  if (isDependency(path, name, kinds)) return "dependencies";
  if (isMigration(path, name, kinds)) return "migrations";
  if (isInfrastructure(path, name)) return "infrastructure";
  if (isSecret(path, name, kinds)) return "secrets";
  return isSignIn(path) ? "sign_in" : undefined;
}

const ORDER: readonly TouchKind[] = ["dependencies", "migrations", "ci", "infrastructure", "secrets", "sign_in", "tests_added", "tests_edited"];

/** How many changed files are of each kind, in the order of the kinds. */
export function touchesOf(files: readonly { readonly path: string; readonly added: boolean }[], kinds: ReadonlySet<RepoKind>): { kind: TouchKind; files: number }[] {
  const counts = new Map<TouchKind, number>();
  for (const file of files) {
    const kind = touchOf(file.path, file.added, kinds);
    if (kind !== undefined) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return ORDER.flatMap((kind) => (counts.has(kind) ? [{ kind, files: counts.get(kind)! }] : []));
}
