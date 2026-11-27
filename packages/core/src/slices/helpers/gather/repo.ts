// Collects what suggest-checks sends: the file names of a folder, two levels deep, and the text of
// its known build files. This is the only place a helper reads a repo, and it reads nothing else:
// a file only through fs-safe (a regular file, no link), a name only when it is not a secret file's.
// Whatever the repo holds is untrusted: a name or a file can be planted to steer the agent or to
// pull a secret into the prompt, so nothing is read by a name the repo chose except as listed here.
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { listFiles, listFolders, readTextFileInside, readTextHead, type ReadFailureReason } from "../../../kernel/fs-safe/index.js";
import { err, ok, type Result } from "../../../kernel/result/index.js";
import type { HelperInput } from "../../../kernel/schemas/index.js";
import { cutText } from "../../../kernel/text/index.js";
import { HELPER_INPUTS, type HelperInputName } from "../definition.js";
import { isShownName } from "./secrets.js";

export interface RepoGathererOptions {
  /** Tokama's own folder: never read, never inside the folder a helper reads. */
  readonly tokamaHome: string;
  /** The user's home folder: a helper does not read it as a whole. */
  readonly userHome: string;
  /** Where item worktrees go, relative to a repo, for every configured repo and the default. Read at each run. */
  readonly worktreeFolders: () => readonly string[];
}

/** What a helper's gatherer is: the same shape the helper runner asks for. */
export type RepoGatherer = (input: HelperInput, signal: AbortSignal) => Promise<Result<Partial<Record<HelperInputName, string>>, string>>;

const FILE_BYTES = 16 * 1024;
const README_BYTES = 8 * 1024;
const NAMES_BYTES = HELPER_INPUTS["repo-file-names"].maxBytes;
const BUILD_BYTES = HELPER_INPUTS["repo-build-files"].maxBytes;
/** Room kept for the closing "not included" list, so adding it never pushes the text over its cap. */
const NOT_INCLUDED_BYTES = 5 * 1024;
const MORE_NAMES = "... (more names are not listed)\n";
const LISTING_MAX = 50_000;
const SHOWN_NAME_CHARS = 100;
const MAX_PROJECT_FILES = 3;

// In priority order. Each group is tried in turn; a file that does not fit is skipped, never cut.
const BUILD_FILES: readonly string[] = [
  "package.json", "pnpm-workspace.yaml", "deno.json", // JavaScript
  "Makefile", "justfile", "Taskfile.yml", // make, just, task
  "Cargo.toml", // Rust
  "go.mod", // Go
  "pyproject.toml", "tox.ini", "noxfile.py", // Python
  "pom.xml", "build.gradle", "build.gradle.kts", // Java
  "Gemfile", "Rakefile", // Ruby
  "composer.json", // PHP
];
const DOC = /^(readme|contributing)(\.(md|markdown|rst|txt|adoc))?$/i;
const SKIPPED_NAMES = new Set([".git", "node_modules"]);

const REASONS: Partial<Record<ReadFailureReason, string>> = {
  too_large: `larger than ${FILE_BYTES / 1024} KiB`,
  symlink: "a link",
  not_regular_file: "not a regular file",
  invalid_utf8: "not text",
  outside_root: "outside the folder",
};

const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");
/** A path compared as a case-insensitive disk compares it. */
const key = (path: string): string => path.normalize("NFC").toLowerCase();

/** The real path of `path`, or of its nearest existing parent with the rest added: the folder may not exist yet. */
async function realish(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(await realish(parent), basename(path));
  }
}

/** True when `child` is `parent` or inside it. Both are real paths. */
function within(parent: string, child: string): boolean {
  const rel = relative(key(parent), key(child));
  return !isAbsolute(rel) && rel.split(sep)[0] !== "..";
}

/** The disk identity (`device:inode`) of `path` and each of its parents, nearest first; a part that cannot be read is left out, and an unreadable `path` gives an empty list. */
async function identities(path: string): Promise<string[]> {
  const ids: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    try {
      const info = await stat(current, { bigint: true });
      ids.push(`${info.dev}:${info.ino}`);
    } catch {
      if (current === path) return [];
    }
    if (dirname(current) === current) return ids;
  }
}

/** The folder's real path, or why a helper must not read it. */
async function usableFolder(path: string, options: RepoGathererOptions): Promise<Result<string, string>> {
  if (path === "" || path.includes("\0") || !isAbsolute(path)) return err("The folder must be a full path, such as /home/me/code/orders-api.");
  let real: string;
  try {
    real = await realpath(path);
    if (!(await stat(real)).isDirectory()) return err("The path is not a folder.");
  } catch {
    return err("The folder does not exist or cannot be read.");
  }
  const [home, user] = await Promise.all([realish(resolve(options.tokamaHome)), realish(resolve(options.userHome))]);
  // Two spellings of one folder (macOS firmlinks such as /System/Volumes/Data, bind mounts) have different
  // real paths but the same disk identity, so the folders are also compared by it, along the whole chain of parents.
  const [chosenIds, homeIds, userIds] = await Promise.all([identities(real), identities(home), identities(user)]);
  const chosenId = chosenIds[0];
  if (within(home, real) || (homeIds.length > 0 && chosenIds.includes(homeIds[0]!))) return err("This folder is Tokama's own, and a helper does not read it.");
  if (within(real, home) || (chosenId !== undefined && homeIds.includes(chosenId))) return err("This folder holds Tokama's own folder, and a helper does not read it. Pick the project's folder.");
  if (within(real, user) || (chosenId !== undefined && userIds.includes(chosenId))) return err("This is the home folder, not a project's. Pick the project's folder.");
  return ok(real);
}

const sorted = (names: readonly string[]): string[] => [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** A folder's entries, `[files, folders]`, or nothing when it cannot be listed. Folders that are links are not folders. */
async function entries(root: string, rel: string): Promise<{ files: string[]; folders: string[] } | undefined> {
  const [files, folders] = await Promise.all([listFiles(root, rel, { max: LISTING_MAX }), listFolders(root, rel, { max: LISTING_MAX })]);
  return files.ok && folders.ok ? { files: files.value, folders: folders.value } : undefined;
}

/** `.tokama/wt` as a key to compare with a listed path, whatever the folder's own spelling (`./`, `\`, trailing `/`). */
const folderKey = (folder: string): string => {
  const normal = posix.normalize(folder.replaceAll("\\", "/")).split("/").filter((part) => part !== "" && part !== ".");
  return key(normal.join("/"));
};

/** The names two levels deep, folders with a closing `/`, in the order depth one then depth two. Never more than the cap. */
async function fileNames(root: string, skipFolders: ReadonlySet<string>, signal: AbortSignal): Promise<string> {
  const skipped = (rel: string, name: string) => SKIPPED_NAMES.has(name.toLowerCase()) || skipFolders.has(key(rel));
  const lines: string[] = [];
  const top = await entries(root, "");
  if (top === undefined) return "(the folder could not be listed)\n";
  const shown = (names: readonly string[], parent: string) => names.filter((name) => isShownName(name) && !skipped(parent === "" ? name : `${parent}/${name}`, name));
  const topFolders = shown(top.folders, "");
  lines.push(...sorted([...shown(top.files, ""), ...topFolders.map((name) => `${name}/`)]));
  for (const folder of sorted(topFolders)) {
    if (signal.aborted) break;
    const inner = await entries(root, folder);
    if (inner === undefined) continue;
    lines.push(...sorted([...shown(inner.files, folder), ...shown(inner.folders, folder).map((name) => `${name}/`)]).map((name) => `${folder}/${name}`));
  }
  if (lines.length === 0) return "(no files)\n";
  const all = `${lines.join("\n")}\n`;
  if (bytesOf(all) <= NAMES_BYTES) return all;
  let text = "";
  let size = 0;
  for (const line of lines) {
    size += bytesOf(line) + 1;
    if (size > NAMES_BYTES - bytesOf(MORE_NAMES)) break;
    text += `${line}\n`;
  }
  return `${text}${MORE_NAMES}`;
}

/** The first of `names` whose lower-case form is `lower`; names are sorted, so the choice is stable. */
const named = (names: readonly string[], lower: string): string | undefined => names.find((name) => name.toLowerCase() === lower);

/** The build files to read, in priority order, as paths relative to the folder. */
async function candidates(root: string): Promise<{ rel: string; head?: true }[]> {
  const top = await entries(root, "");
  if (top === undefined) return [];
  const files = sorted(top.files.filter(isShownName));
  const found: { rel: string; head?: true }[] = [];
  const add = (names: readonly (string | undefined)[], head?: true) => {
    for (const name of names) if (name !== undefined) found.push({ rel: name, ...(head && { head }) });
  };
  const withExtension = (...extensions: string[]) => files.filter((name) => extensions.some((extension) => name.toLowerCase().endsWith(extension))).slice(0, MAX_PROJECT_FILES);
  add(BUILD_FILES.map((name) => named(files, name.toLowerCase())));
  add(withExtension(".sln"));
  add(withExtension(".csproj", ".fsproj"));
  add([named(files, "global.json"), named(files, "directory.build.props")]);
  // The workflows folder is read only when each folder on the way is a real folder, not a link.
  if (top.folders.includes(".github")) {
    const github = await entries(root, ".github");
    if (github?.folders.includes("workflows") === true) {
      const workflows = await listFiles(root, ".github/workflows", { max: LISTING_MAX });
      if (workflows.ok) add(workflows.value.filter((name) => isShownName(name) && /\.ya?ml$/i.test(name)).slice(0, MAX_PROJECT_FILES).map((name) => `.github/workflows/${name}`));
    }
  }
  for (const word of ["readme", "contributing"]) add([files.find((name) => DOC.test(name) && name.toLowerCase().startsWith(word))], true);
  return found;
}

/** The text of the build files that fit, then the names of those that did not. Never a cut file, except a README's first part. */
async function buildFiles(root: string, signal: AbortSignal): Promise<string> {
  let text = "";
  const left: string[] = [];
  const skip = (rel: string, why: string) => left.push(`${cutText(rel, SHOWN_NAME_CHARS)} (${why})`);
  for (const { rel, head } of await candidates(root)) {
    if (signal.aborted) break;
    const path = join(root, rel);
    let body: string;
    let cut = false;
    if (head === true) {
      const read = await readTextHead(path, { maxBytes: README_BYTES, replaceInvalid: true });
      if (!read.ok) {
        if (read.error.reason !== "not_found") skip(rel, REASONS[read.error.reason] ?? "could not be read");
        continue;
      }
      body = read.value.text;
      cut = read.value.truncated;
    } else {
      const read = await readTextFileInside(root, path, { maxBytes: FILE_BYTES });
      if (!read.ok) {
        if (read.error.reason !== "not_found") skip(rel, REASONS[read.error.reason] ?? "could not be read");
        continue;
      }
      body = read.value;
    }
    const section = `--- ${rel}${cut ? ` (the first ${README_BYTES / 1024} KiB)` : ""} ---\n${body}${body.endsWith("\n") ? "" : "\n"}\n`;
    if (bytesOf(text) + bytesOf(section) > BUILD_BYTES - NOT_INCLUDED_BYTES) {
      skip(rel, `would pass the ${BUILD_BYTES / 1024} KiB limit`);
      continue;
    }
    text += section;
  }
  if (left.length > 0) text += `--- not included ---\n${left.join("\n")}\n`;
  return text === "" ? "(no build files found)\n" : text;
}

export function createRepoGatherer(options: RepoGathererOptions): RepoGatherer {
  return async (input, signal) => {
    const root = await usableFolder(input.path, options);
    if (!root.ok) return root;
    const skipFolders = new Set(options.worktreeFolders().map(folderKey));
    const names = await fileNames(root.value, skipFolders, signal);
    const builds = await buildFiles(root.value, signal);
    return ok({ "repo-file-names": names, "repo-build-files": builds });
  };
}
