// What a first commit would hold, for a folder that is not a git repo yet or has no commit. The
// walk is a preview: it applies the default ignore list, or the plain names (and `name*` prefixes)
// of the folder's own .gitignore, so with other rules it can count more files than git will add,
// never fewer. Git decides the real content when the commit is made.
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** More files than this are refused: a first commit that large is almost always a mistake. */
export const MAX_FIRST_COMMIT_FILES = 5000;
/** The walk counts to here, so a refusal can name the number; beyond it only "more than". */
const COUNT_LIMIT = 50_000;
/** Files named in the preview, then the rest by name when only a few remain. */
const SAMPLE_SIZE = 10;
const MORE_NAMES = 6;
/** Files counted inside the ignored folders (node_modules and the like), in all. */
const LEFT_OUT_BUDGET = 20_000;
/** Folders walked at most, so a tree of empty folders ends too. */
const MAX_FOLDERS = 20_000;
export const GITIGNORE_FILE = ".gitignore";
/** Written only when the folder has no .gitignore. */
export const DEFAULT_GITIGNORE = [".DS_Store", "node_modules/", ".env*", "dist/", "build/"];

export interface FirstCommitPreview {
  /** Files the commit would hold; above MAX_FIRST_COMMIT_FILES the count may stop at a limit. */
  readonly files: number;
  /** Their size in bytes; 0 when there are too many files to measure. */
  readonly bytes: number;
  /** The first few, as paths in the folder, with their sizes. */
  readonly sample: readonly { readonly path: string; readonly bytes: number }[];
  /** The names of the files after the sample, when there are only a few. */
  readonly more: readonly string[];
  /** The folder has no .gitignore, so Tokama would add the default one. */
  readonly addsGitignore: boolean;
  /** What the new .gitignore leaves out, top level only: a folder with its file count (null: too many to count). */
  readonly leftOut: readonly { readonly name: string; readonly files: number | null }[];
  /** Why no first commit can be made here, in plain words. */
  readonly refusal: string | undefined;
}

const HOME_FOLDER = "This is your home folder. Pick a project folder inside it, for example ~/code/orders-api. Tokama never makes your home folder a repo.";
const DISK_ROOT = "This is the root of the disk. Pick a project folder. Tokama never makes it a repo.";
const UNUSABLE_GITIGNORE = ".gitignore here is a link or a folder, which git won't use. Replace it with a plain file first.";
const tooMany = (files: number) =>
  `This folder has ${files > COUNT_LIMIT ? `more than ${COUNT_LIMIT.toLocaleString("en-US")}` : files.toLocaleString("en-US")} files. Tokama sets up git only for folders with up to ${MAX_FIRST_COMMIT_FILES.toLocaleString("en-US")} files. If this really is one project, run git init and make a first commit yourself, then add it again.`;

const refused = (refusal: string): FirstCommitPreview => ({ files: 0, bytes: 0, sample: [], more: [], addsGitignore: false, leftOut: [], refusal });

export async function previewFirstCommit(folder: string, home: string | undefined): Promise<FirstCommitPreview> {
  const homeReal = await realpath(home ?? homedir()).catch(() => undefined);
  if (folder === "/") return refused(DISK_ROOT);
  if (folder === homeReal) return refused(HOME_FOLDER);

  // Git skips a .gitignore that is a link or a folder, so the preview must not read through it.
  const entry = await lstat(join(folder, GITIGNORE_FILE)).catch(() => undefined);
  if (entry !== undefined && !entry.isFile()) return refused(UNUSABLE_GITIGNORE);
  const text = entry === undefined ? undefined : await readFile(join(folder, GITIGNORE_FILE), "utf8").catch(() => undefined);
  const addsGitignore = entry === undefined;
  // `name` skips a file or folder of that name, `name/` only a folder.
  const ignored = new Set<string>([".git"]);
  const ignoredFolders = new Set<string>();
  const prefixes: string[] = [];
  // Only plain names and `name*` prefixes at any depth; a line with a slash inside is left out, so
  // the walk never skips what git would add.
  const lines = text === undefined ? DEFAULT_GITIGNORE : text.split(/\r?\n/);
  for (const raw of lines) {
    const trimmed = raw.trim();
    const folderOnly = trimmed.endsWith("/");
    const line = folderOnly ? trimmed.slice(0, -1) : trimmed;
    if (/^[^#!*?[\s/\\]+$/.test(line)) (folderOnly ? ignoredFolders : ignored).add(line);
    else if (/^[^#!*?[\s/\\]+\*$/.test(line)) prefixes.push(line.slice(0, -1));
  }
  const skipped = (name: string, folder: boolean) => ignored.has(name) || (folder && ignoredFolders.has(name)) || prefixes.some((prefix) => name.startsWith(prefix));

  const paths: string[] = [];
  const sizes: number[] = [];
  const leftOut: { name: string; files: number | null }[] = [];
  let files = 0;
  let bytes = 0;
  let folders = 0;
  // The new .gitignore is part of the commit.
  if (addsGitignore) {
    const ignoreBytes = Buffer.byteLength(`${DEFAULT_GITIGNORE.join("\n")}\n`);
    files = 1;
    bytes = ignoreBytes;
    paths.push(GITIGNORE_FILE);
    sizes.push(ignoreBytes);
  }
  let budget = LEFT_OUT_BUDGET;
  const sorted = async (dir: string) => (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => (a.isDirectory() === b.isDirectory() ? (a.name < b.name ? -1 : 1) : a.isDirectory() ? 1 : -1));

  /** Files inside an ignored folder, counted while the budget lasts. */
  const countInside = async (dir: string): Promise<number | null> => {
    let count = 0;
    for (const item of await sorted(dir)) {
      if (budget <= 0) return null;
      if (item.isDirectory()) {
        const inner = await countInside(join(dir, item.name));
        if (inner === null) return null;
        count += inner;
      } else {
        budget--;
        count++;
      }
    }
    return count;
  };

  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const item of await sorted(dir)) {
      if (files > COUNT_LIMIT) return;
      if (skipped(item.name, item.isDirectory())) {
        if (addsGitignore && prefix === "" && item.name !== ".git") {
          leftOut.push(item.isDirectory() ? { name: `${item.name}/`, files: await countInside(join(dir, item.name)) } : { name: item.name, files: 1 });
        }
        continue;
      }
      if (item.isDirectory()) {
        if (++folders > MAX_FOLDERS) files = COUNT_LIMIT + 1;
        await walk(join(dir, item.name), `${prefix}${item.name}/`);
        continue;
      }
      files++;
      if (files <= MAX_FIRST_COMMIT_FILES) {
        const size = (await lstat(join(dir, item.name)).catch(() => undefined))?.size ?? 0;
        bytes += size;
        if (paths.length < SAMPLE_SIZE + MORE_NAMES) {
          paths.push(`${prefix}${item.name}`);
          sizes.push(size);
        }
      }
    }
  };
  await walk(folder, "");
  // The files of the folder itself: the new .gitignore is not one of them.
  const own = files - (addsGitignore ? 1 : 0);
  const tooLarge = own > MAX_FIRST_COMMIT_FILES;
  return {
    files,
    bytes: tooLarge ? 0 : bytes,
    sample: paths.slice(0, SAMPLE_SIZE).map((path, index) => ({ path, bytes: sizes[index] ?? 0 })),
    more: files <= SAMPLE_SIZE + MORE_NAMES ? paths.slice(SAMPLE_SIZE) : [],
    addsGitignore,
    leftOut: leftOut.slice(0, 20),
    refusal: tooLarge ? tooMany(own) : undefined,
  };
}
