// What a change comes to, counted from one `git diff --numstat` of the base commit to a tree:
// files, lines, and how many files of each sensitive kind. Counts only, never paths. A change
// whose lines cannot be counted says so, and is never guessed at.
import type { DiffEntry, Git } from "../../kernel/git/index.js";
import { DIFF_LIMITS, type ChangeSummary } from "../../kernel/schemas/index.js";
import { KIND_MARKERS, repoKinds, touchesOf } from "./sensitive.js";

/** The root files of `base` that name the kind of repo, as far as it has them. */
async function markersIn(git: Pick<Git, "revParse">, dir: string, base: string): Promise<string[]> {
  const names = Object.values(KIND_MARKERS).flat();
  const found = await Promise.all(names.map(async (name) => ((await git.revParse(dir, `${base}:${name}`)).ok ? name : undefined)));
  return found.filter((name) => name !== undefined);
}

/** The summary of the entries `diffFiles` listed from `base`. More files than Tokama shows is `too_large`; only binary files is `binary_only`. */
export async function summarizeChange(git: Pick<Git, "revParse">, dir: string, base: string, entries: readonly DiffEntry[]): Promise<ChangeSummary> {
  if (entries.length === 0) return { files: 0 };
  if (entries.length > DIFF_LIMITS.files) return { files: entries.length, unreadable: "too_large" };
  const kinds = repoKinds(await markersIn(git, dir, base), entries.map((entry) => entry.path));
  const touches = touchesOf(entries.map((entry) => ({ path: entry.path, added: entry.status === "A" })), kinds);
  const counted = entries.filter((entry) => entry.added !== null && entry.removed !== null);
  const found = { files: entries.length, ...(touches.length > 0 && { touches }) };
  if (counted.length === 0) return { ...found, unreadable: "binary_only" };
  return { ...found, added: counted.reduce((sum, entry) => sum + entry.added!, 0), removed: counted.reduce((sum, entry) => sum + entry.removed!, 0) };
}

/**
 * The change from `base` to a commit that differs from it, read in `dir`. A diff that git cannot
 * give, or one that lists no file though the commit differs, is `unknown`: never "no files".
 */
export async function readChange(git: Pick<Git, "diffFiles" | "revParse">, dir: string, base: string, to: string): Promise<ChangeSummary> {
  const diff = await git.diffFiles(dir, base, to);
  if (!diff.ok || diff.value.length === 0) return { files: 0, unreadable: "unknown" };
  return summarizeChange(git, dir, base, diff.value);
}
