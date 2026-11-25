// The change between two trees, for the engineer to read before approving it: each file with its
// status, line counts and hunks. Paths, statuses and counts come from git's NUL-separated output;
// the hunks come from one unified diff, matched to the files in git's order. A section is used
// only when its header is exactly the one git writes for that file, so a hunk can never be shown
// under another file's name: when they do not match, the file is listed without hunks and marked
// cut. Every call goes through the hardened git wrapper.
import type { DiffEntry, Git } from "../../kernel/git/index.js";
import { err, ok, type Result } from "../../kernel/result/index.js";
import { DIFF_LIMITS, type DiffFile, type DiffHunk, type DiffStatus, type ItemDiff } from "../../kernel/schemas/index.js";

/** An item diff without the worktree it was read from. */
export type TreeDiff = Omit<ItemDiff, "worktree">;

const STATUS: Readonly<Record<string, DiffStatus>> = { A: "added", M: "modified", D: "deleted", R: "renamed", T: "type_changed" };

const CONTROL: Readonly<Record<number, string>> = { 7: "a", 8: "b", 9: "t", 10: "n", 11: "v", 12: "f", 13: "r" };

/** A path as git writes it in a diff header with core.quotePath on: C-quoted when it needs to be. */
export function gitQuoted(path: string): string {
  let out = "";
  let needs = false;
  for (const byte of Buffer.from(path, "utf8")) {
    if (byte >= 0x20 && byte < 0x7f && byte !== 0x22 && byte !== 0x5c) {
      out += String.fromCharCode(byte);
      continue;
    }
    needs = true;
    if (byte === 0x22 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else out += `\\${CONTROL[byte] ?? byte.toString(8).padStart(3, "0")}`;
  }
  return needs ? `"${out}"` : path;
}

const headerOf = (entry: Pick<DiffEntry, "path" | "oldPath">) => `diff --git ${gitQuoted(`a/${entry.oldPath ?? entry.path}`)} ${gitQuoted(`b/${entry.path}`)}`;

interface Section {
  readonly header: string;
  readonly lines: readonly string[];
}

/** The patch's file sections; a section the read cut short is left out. */
function sections(patch: { readonly text: string; readonly cut: boolean }): Section[] {
  const found: { header: string; lines: string[] }[] = [];
  for (const line of patch.text.split("\n")) {
    if (line.startsWith("diff --git ")) found.push({ header: line, lines: [] });
    else found.at(-1)?.lines.push(line);
  }
  if (patch.cut) found.pop();
  return found;
}

/** The hunks of a section: everything from its first `@@` line. */
function hunksOf(section: Section): { header: string; lines: string[] }[] {
  const hunks: { header: string; lines: string[] }[] = [];
  for (const line of section.lines) {
    if (line.startsWith("@@")) hunks.push({ header: line, lines: [] });
    else hunks.at(-1)?.lines.push(line);
  }
  // The text ends with a newline: the empty line after it is not part of the last hunk.
  const last = hunks.at(-1);
  if (last !== undefined && last.lines.at(-1) === "") last.lines.pop();
  return hunks;
}

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const cutLine = (line: string) => (line.length > DIFF_LIMITS.lineChars ? `${line.slice(0, DIFF_LIMITS.lineChars)}…` : line);

/** The diff of `entries` (from `diffFiles`) with the hunks of `patch` (from `diffPatch`), within DIFF_LIMITS. */
export function buildDiff(entries: readonly DiffEntry[], patch: { readonly text: string; readonly cut: boolean }): TreeDiff {
  const found = sections(patch);
  let next = 0;
  let matching = true;
  let fileBytes = 0;
  let hunkBytes = 0;
  const files: DiffFile[] = [];
  let moreFiles = 0;

  for (const entry of entries) {
    const binary = entry.added === null || entry.removed === null;
    // A type change is written as two sections: the old file removed, the new one added.
    const wanted = entry.status === "T" ? 2 : 1;
    const own: Section[] = [];
    while (matching && own.length < wanted && found[next]?.header === headerOf(entry)) own.push(found[next++]!);
    if (own.length === 0) matching = false;

    const file: DiffFile = {
      path: entry.path,
      ...(entry.oldPath !== undefined && { oldPath: entry.oldPath }),
      status: STATUS[entry.status] ?? "modified",
      added: binary ? null : entry.added,
      removed: binary ? null : entry.removed,
      binary,
      hunks: [],
      // git calls a text file with a NUL byte binary: its content is never shown, so it is cut.
      cut: binary,
    };
    const cost = jsonBytes(file);
    if (files.length >= DIFF_LIMITS.files || fileBytes + cost > DIFF_LIMITS.fileBytes) {
      moreFiles++;
      continue;
    }
    fileBytes += cost;
    files.push(file);

    const hunks = own.flatMap(hunksOf);
    const hasLines = !binary && (entry.added ?? 0) + (entry.removed ?? 0) > 0;
    if (hasLines && hunks.length === 0) file.cut = true;
    const kept: DiffHunk[] = [];
    for (const hunk of hunks) {
      const header = cutLine(hunk.header);
      // The hunk's own JSON (`{"header":…,"lines":[]},`) counts too.
      let size = jsonBytes({ header, lines: [] }) + 1;
      if (hunkBytes + size > DIFF_LIMITS.hunkBytes) {
        file.cut = true;
        break;
      }
      const lines: string[] = [];
      for (const line of hunk.lines) {
        const shown = cutLine(line);
        const lineSize = jsonBytes(shown) + 1;
        if (hunkBytes + size + lineSize > DIFF_LIMITS.hunkBytes) {
          file.cut = true;
          break;
        }
        size += lineSize;
        lines.push(shown);
      }
      hunkBytes += size;
      kept.push({ header, lines });
      if (file.cut) break;
    }
    files[files.length - 1] = { ...file, hunks: kept };
  }
  return { files, moreFiles, cut: moreFiles > 0 || files.some((file) => file.cut) };
}

export interface DiffError {
  readonly message: string;
}

/** The change from `from` to `to` (tree or commit ids) in the repo at `worktreePath`. */
export async function treeDiff(git: Git, worktreePath: string, from: string, to: string): Promise<Result<TreeDiff, DiffError>> {
  const entries = await git.diffFiles(worktreePath, from, to);
  if (!entries.ok) return err({ message: entries.error.message });
  if (entries.value.length === 0) return ok({ files: [], moreFiles: 0, cut: false });
  const patch = await git.diffPatch(worktreePath, from, to, DIFF_LIMITS.patchBytes);
  if (!patch.ok) return err({ message: patch.error.message });
  return ok(buildDiff(entries.value, patch.value));
}
