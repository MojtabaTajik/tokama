// The change a step made, as the engine serves it for a decision the engineer answers: the files
// that differ between the item's base commit and the tree the decision is about, with their line
// counts and hunks. Repo content: clients show it as text only. The reply stays far below the
// API's message size: hunk text and file entries each have a byte budget, and what does not fit
// is marked, never dropped without a word.
import { z } from "zod";
import { RepoIdSchema } from "./ids.js";
import { RepoDirSchema } from "./item-log.js";

export const DIFF_LIMITS = {
  /** Bytes of hunk lines (as JSON) in one reply. */
  hunkBytes: 256 * 1024,
  /** Bytes of file entries without their hunks (as JSON) in one reply. */
  fileBytes: 128 * 1024,
  /** Files listed in one reply; the rest are counted in `moreFiles`. */
  files: 500,
  /** Changed lines of one file whose hunks are shown; a larger file is listed with its counts only. */
  fileLines: 1000,
  /** Characters of one hunk line; a longer line is cut and ends with "…". */
  lineChars: 1000,
  /** Bytes of the unified diff the engine reads from git. */
  patchBytes: 2 * 1024 * 1024,
} as const;

export const DiffStatusSchema = z.enum(["added", "modified", "deleted", "renamed", "type_changed"]);

export const DiffHunkSchema = z.strictObject({
  /** The `@@ -a,b +c,d @@` line. */
  header: z.string().min(1).max(DIFF_LIMITS.lineChars + 1),
  /** Each line with its mark: " " context, "+" added, "-" removed, "\" a note from git. */
  lines: z.array(z.string().max(DIFF_LIMITS.lineChars + 1)).max(DIFF_LIMITS.hunkBytes),
});

export const DiffFileSchema = z.strictObject({
  /** The path in the tree, relative to the repo. */
  path: z.string().min(1).max(4096),
  /** For a rename: the path in the base commit. */
  oldPath: z.string().min(1).max(4096).optional(),
  status: DiffStatusSchema,
  /** Line counts; null for a binary file. */
  added: z.int().nonnegative().nullable(),
  removed: z.int().nonnegative().nullable(),
  binary: z.boolean(),
  hunks: z.array(DiffHunkSchema).max(DIFF_LIMITS.hunkBytes),
  /**
   * Some or all of the file's content is not shown: a binary file, a file over `fileLines`
   * changed lines, or hunks left out to keep the reply small.
   */
  cut: z.boolean(),
});

export const ItemDiffSchema = z.strictObject({
  files: z.array(DiffFileSchema).max(DIFF_LIMITS.files),
  /** Files that differ but are not listed. */
  moreFiles: z.int().nonnegative(),
  /** Anything was left out: hunks of a listed file, or files. */
  cut: z.boolean(),
  /** Where to see all of it: the item's worktree, as a folder relative to its repo. */
  worktree: z.strictObject({
    repoId: RepoIdSchema,
    dir: RepoDirSchema,
    branch: z.string().min(1).max(200),
    /** The commit the item started from. */
    baseCommit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "must be a git object id"),
  }),
});

export type DiffStatus = z.output<typeof DiffStatusSchema>;
export type DiffHunk = z.output<typeof DiffHunkSchema>;
export type DiffFile = z.output<typeof DiffFileSchema>;
export type ItemDiff = z.output<typeof ItemDiffSchema>;
