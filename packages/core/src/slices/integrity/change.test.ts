import { describe, expect, it } from "vitest";
import type { DiffEntry, Git } from "../../kernel/git/index.js";
import { DIFF_LIMITS } from "../../kernel/schemas/index.js";
import { readChange, summarizeChange } from "./change.js";

const entry = (path: string, added: number | null, removed: number | null, status = "M"): DiffEntry => ({ status, path, added, removed });

/** A git with these root files in the base commit, and this diff. */
function fakeGit(present: readonly string[], diff: readonly DiffEntry[] | "fails"): Pick<Git, "diffFiles" | "revParse"> {
  return {
    revParse: async (_dir, rev) => (present.some((name) => rev === `base:${name}`) ? { ok: true, value: "abc" } : { ok: false, error: { reason: "failed", args: [], exitCode: 128, message: "no" } }),
    diffFiles: async () => (diff === "fails" ? { ok: false, error: { reason: "failed", args: [], exitCode: 128, message: "bad object" } } : { ok: true, value: [...diff] }),
  } as Pick<Git, "diffFiles" | "revParse">;
}

describe("summarizeChange", () => {
  it("adds up files and lines, and counts the files of each kind", async () => {
    const git = fakeGit(["package.json"], []);
    const entries = [entry("src/total.ts", 10, 2), entry("src/total.test.ts", 30, 0, "A"), entry("Dockerfile", 3, 1), entry("logo.png", null, null, "A")];
    expect(await summarizeChange(git, "/w", "base", entries)).toEqual({
      files: 4,
      added: 43,
      removed: 3,
      touches: [{ kind: "infrastructure", files: 1 }, { kind: "tests_added", files: 1 }],
    });
  });

  it("is unreadable as binary only when no file has line counts", async () => {
    const git = fakeGit([], []);
    expect(await summarizeChange(git, "/w", "base", [entry("a.png", null, null, "A"), entry("b.png", null, null)])).toEqual({ files: 2, unreadable: "binary_only" });
  });

  it("is unreadable as too large past the files Tokama lists, and reads no marker for it", async () => {
    const many = Array.from({ length: DIFF_LIMITS.files + 1 }, (_, i) => entry(`f${i}.txt`, 1, 0, "A"));
    expect(await summarizeChange(fakeGit([], []), "/w", "base", many)).toEqual({ files: DIFF_LIMITS.files + 1, unreadable: "too_large" });
  });

  it("is no files for an empty diff", async () => {
    expect(await summarizeChange(fakeGit([], []), "/w", "base", [])).toEqual({ files: 0 });
  });

  it("uses the repo's kind from the base commit: a Prisma schema is a migration only in a Node repo", async () => {
    const entries = [entry("prisma/schema.prisma", 1, 1)];
    expect(await summarizeChange(fakeGit(["package.json"], []), "/w", "base", entries)).toMatchObject({ touches: [{ kind: "migrations", files: 1 }] });
    expect(await summarizeChange(fakeGit(["pyproject.toml"], []), "/w", "base", entries)).not.toHaveProperty("touches");
  });

  it("holds no path", async () => {
    const summary = await summarizeChange(fakeGit([], []), "/w", "base", [entry("secret/customers.csv", 1, 0, "A")]);
    expect(JSON.stringify(summary)).not.toContain("customers");
  });
});

describe("readChange", () => {
  it("reads the diff of the base commit to a tree", async () => {
    expect(await readChange(fakeGit([], [entry("a.ts", 2, 1)]), "/w", "base", "tree")).toEqual({ files: 1, added: 2, removed: 1 });
  });

  it("is unreadable as unknown when the diff cannot be read, not too large", async () => {
    expect(await readChange(fakeGit([], "fails"), "/w", "base", "tree")).toEqual({ files: 0, unreadable: "unknown" });
  });

  it("is unreadable as unknown when the commit differs but no file is listed, not no files", async () => {
    expect(await readChange(fakeGit([], []), "/w", "base", "tree")).toEqual({ files: 0, unreadable: "unknown" });
  });
});
