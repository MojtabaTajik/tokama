// What a first commit would hold, for a folder that is not a git repo yet or has no commit. The
// walk is a preview: it applies the default ignore list, or the plain names (no wildcards) of the
// folder's own .gitignore (and `name*` prefixes), so with other rules it can count more files than
// git will add, never fewer. Git decides the real content when the commit is made.
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** More files than this are refused: a first commit that large is almost always a mistake. */
export const MAX_FIRST_COMMIT_FILES = 5000;
const SAMPLE_SIZE = 10;
export const GITIGNORE_FILE = ".gitignore";
/** Written only when the folder has no .gitignore. */
export const DEFAULT_GITIGNORE = [".DS_Store", "node_modules/", ".env*", "dist/", "build/"];

export interface FirstCommitPreview {
  /** Files the commit would hold; MAX_FIRST_COMMIT_FILES + 1 means "more than the limit". */
  readonly files: number;
  /** The first few, as paths in the folder. */
  readonly sample: readonly string[];
  /** The folder has no .gitignore, so Tokama would add the default one. */
  readonly addsGitignore: boolean;
  /** Why no first commit can be made here, in plain words. */
  readonly refusal: string | undefined;
}

const TOO_BROAD = "This is your home folder or the root of the disk. Tokama won't make it a repo. Pick a project folder instead.";
const UNUSABLE_GITIGNORE = ".gitignore here is a link or a folder, which git won't use. Replace it with a plain file first.";
/** Folders walked at most, so a tree of empty folders ends too. */
const MAX_FOLDERS = 20_000;
const TOO_MANY = `This folder holds more than ${MAX_FIRST_COMMIT_FILES.toLocaleString("en-US")} files, too many for a first commit. Add a .gitignore for generated files, or pick a smaller folder.`;

export async function previewFirstCommit(folder: string, home: string | undefined): Promise<FirstCommitPreview> {
  const homeReal = await realpath(home ?? homedir()).catch(() => undefined);
  if (folder === "/" || folder === homeReal) return { files: 0, sample: [], addsGitignore: false, refusal: TOO_BROAD };

  // Git skips a .gitignore that is a link or a folder, so the preview must not read through it.
  const entry = await lstat(join(folder, GITIGNORE_FILE)).catch(() => undefined);
  if (entry !== undefined && !entry.isFile()) return { files: 0, sample: [], addsGitignore: false, refusal: UNUSABLE_GITIGNORE };
  const text = entry === undefined ? undefined : await readFile(join(folder, GITIGNORE_FILE), "utf8").catch(() => undefined);
  const addsGitignore = entry === undefined;
  const ignored = new Set<string>([".git"]);
  const prefixes: string[] = [];
  // Only plain names and `name*` prefixes at any depth; a line with a slash inside is left out, so
  // the walk never skips what git would add.
  const lines = text === undefined ? DEFAULT_GITIGNORE : text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim().replace(/\/$/, "");
    if (/^[^#!*?[\s/\\]+$/.test(line)) ignored.add(line);
    else if (/^[^#!*?[\s/\\]+\*$/.test(line)) prefixes.push(line.slice(0, -1));
  }
  const skipped = (name: string) => ignored.has(name) || prefixes.some((prefix) => name.startsWith(prefix));

  const sample: string[] = [];
  let files = 0;
  let folders = 0;
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      if (files > MAX_FIRST_COMMIT_FILES) return;
      if (skipped(entry.name)) continue;
      if (entry.isDirectory()) {
        if (++folders > MAX_FOLDERS) files = MAX_FIRST_COMMIT_FILES + 1;
        await walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      } else {
        files++;
        if (sample.length < SAMPLE_SIZE) sample.push(`${prefix}${entry.name}`);
      }
    }
  };
  await walk(folder, "");
  return { files, sample, addsGitignore, refusal: files > MAX_FIRST_COMMIT_FILES ? TOO_MANY : undefined };
}
