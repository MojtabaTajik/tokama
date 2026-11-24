import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGit, type Git } from "../../kernel/git/index.js";
import { createProcessRunner } from "../../kernel/process/index.js";
import type { ItemId } from "../../kernel/schemas/index.js";
import {
  commitItem,
  commitMessage,
  createWorktree,
  discardWorktree,
  type ItemWorktree,
  removeWorktree,
  worktreePath,
  type WorktreeRepo,
  worktreeSnapshot,
} from "./index.js";

const SLOW = { timeout: 30_000 };
const ITEM_A = "item_0b9f12ab-1c2d-4e5f-8a9b-0c1d2e3f4a5b" as ItemId;
const ITEM_B = "item_7e6d5c4b-1c2d-4e5f-8a9b-0c1d2e3f4a5b" as ItemId;

let root: string;
let home: string;
let repo: WorktreeRepo;
let git: Git;

/** Plain git for fixtures and assertions, never through the wrapper. HOME is empty: no global config. */
async function plain(cwd: string, ...args: string[]): Promise<string> {
  const out: string[] = [];
  const errors: string[] = [];
  const runner = createProcessRunner({ parentEnv: { PATH: process.env["PATH"], HOME: home } });
  const result = await runner.run({
    command: { argv: ["git", ...args] },
    cwd,
    env: { GIT_CONFIG_NOSYSTEM: "1" },
    stdout: { onLine: (line) => out.push(line) },
    stderr: { onLine: (line) => errors.push(line) },
  });
  if (result.kind !== "finished" || result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${errors.join("\n")}`);
  return out.join("\n").replace(/\n+$/, "");
}

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

const exclude = () => readFileSync(join(repo.path, ".git", "info", "exclude"), "utf8");

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tokama-worktrees-test-")));
  home = join(root, "home");
  const path = join(root, "orders-api");
  mkdirSync(home);
  mkdirSync(path);
  await plain(path, "init", "-q", "-b", "main");
  await plain(path, "config", "user.name", "Test");
  await plain(path, "config", "user.email", "test@example.com");
  writeFileSync(join(path, "a.txt"), "one\n");
  await plain(path, "add", "-A");
  await plain(path, "commit", "-q", "-m", "seed");
  repo = { path, baseBranch: "main", worktreeFolder: ".tokama/wt" };
  git = createGit({ runner: createProcessRunner({ parentEnv: { PATH: process.env["PATH"], HOME: home } }) });
}, SLOW.timeout);
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("createWorktree", () => {
  it("creates the item branch from the base branch in the repo's worktree folder", SLOW, async () => {
    const base = await plain(repo.path, "rev-parse", "main");
    const worktree = value(await createWorktree(git, repo, ITEM_A));
    expect(worktree).toEqual({ branch: "tokama/0b9f12ab", folder: ".tokama/wt/0b9f12ab", baseCommit: base });
    const path = worktreePath(repo.path, worktree);
    expect(path).toBe(join(repo.path, ".tokama", "wt", "0b9f12ab"));
    expect(readFileSync(join(path, "a.txt"), "utf8")).toBe("one\n");
    expect(await plain(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("tokama/0b9f12ab");
    expect(await plain(path, "rev-parse", "HEAD")).toBe(base);
  });

  it("adds the worktree folder to the git exclude once, so the main repo stays clean", SLOW, async () => {
    value(await createWorktree(git, repo, ITEM_A));
    expect(exclude().split("\n").filter((line) => line === "/.tokama/wt/")).toHaveLength(1);
    expect(await plain(repo.path, "status", "--porcelain", "--untracked-files=all")).toBe("");
    value(await createWorktree(git, repo, ITEM_B));
    expect(exclude().split("\n").filter((line) => line === "/.tokama/wt/")).toHaveLength(1);
  });

  it("appends to an exclude file without a final line break, and creates a missing one", SLOW, async () => {
    writeFileSync(join(repo.path, ".git", "info", "exclude"), "*.log");
    value(await createWorktree(git, repo, ITEM_A));
    expect(exclude()).toBe("*.log\n/.tokama/wt/\n");
    rmSync(join(repo.path, ".git", "info"), { recursive: true });
    value(await createWorktree(git, { ...repo, worktreeFolder: "./work/trees/" }, ITEM_B));
    expect(exclude()).toBe("/work/trees/\n");
    expect(existsSync(join(repo.path, "work", "trees", "7e6d5c4b", "a.txt"))).toBe(true);
  });

  it("gives two items on the same repo separate worktrees and branches", SLOW, async () => {
    const a = value(await createWorktree(git, repo, ITEM_A));
    const b = value(await createWorktree(git, repo, ITEM_B));
    expect([a.branch, b.branch]).toEqual(["tokama/0b9f12ab", "tokama/7e6d5c4b"]);
    writeFileSync(join(worktreePath(repo.path, a), "a.txt"), "from a\n");
    expect(readFileSync(join(worktreePath(repo.path, b), "a.txt"), "utf8")).toBe("one\n");
    value(await commitItem(git, worktreePath(repo.path, a), { id: ITEM_A, title: "A" }));
    expect(await plain(worktreePath(repo.path, b), "status", "--porcelain")).toBe("");
    expect(await plain(repo.path, "log", "-1", "--format=%s", "tokama/7e6d5c4b")).toBe("seed");
  });

  it("returns errors as values: a missing base branch, an item that already has a worktree", SLOW, async () => {
    expect(await createWorktree(git, { ...repo, baseBranch: "develop" }, ITEM_A)).toMatchObject({ ok: false, error: { reason: "base-branch" } });
    value(await createWorktree(git, repo, ITEM_A));
    expect(await createWorktree(git, repo, ITEM_A)).toMatchObject({ ok: false, error: { reason: "add" } });
  });
});

describe("discardWorktree and removeWorktree", () => {
  let worktree: ItemWorktree;
  let path: string;
  beforeEach(async () => {
    worktree = value(await createWorktree(git, repo, ITEM_A));
    path = worktreePath(repo.path, worktree);
  }, SLOW.timeout);

  it("discard removes the worktree, changes included, and deletes the branch; a second discard is a no-op", SLOW, async () => {
    writeFileSync(join(path, "a.txt"), "changed\n");
    writeFileSync(join(path, "new.txt"), "new\n");
    value(await discardWorktree(git, repo.path, worktree));
    expect(existsSync(path)).toBe(false);
    expect(await plain(repo.path, "branch", "--list", "tokama/*")).toBe("");
    value(await discardWorktree(git, repo.path, worktree));
  });

  it("discard after a finish deletes the branch that kept the commit", SLOW, async () => {
    writeFileSync(join(path, "a.txt"), "changed\n");
    value(await commitItem(git, path, { id: ITEM_A, title: "Change" }));
    value(await removeWorktree(git, repo.path, worktree));
    expect(await plain(repo.path, "branch", "--list", "tokama/*")).toContain("tokama/0b9f12ab");
    value(await discardWorktree(git, repo.path, worktree));
    expect(await plain(repo.path, "branch", "--list", "tokama/*")).toBe("");
  });

  it("remove refuses a worktree with uncommitted changes and keeps it", SLOW, async () => {
    writeFileSync(join(path, "a.txt"), "changed\n");
    expect(await removeWorktree(git, repo.path, worktree)).toMatchObject({ ok: false, error: { reason: "remove" } });
    expect(readFileSync(join(path, "a.txt"), "utf8")).toBe("changed\n");
  });

  it("remove after the commit removes the worktree and keeps the branch; ignored files do not block it", SLOW, async () => {
    writeFileSync(join(path, ".gitignore"), "node_modules/\n");
    mkdirSync(join(path, "node_modules"));
    writeFileSync(join(path, "node_modules", "dep.js"), "x\n");
    writeFileSync(join(path, "a.txt"), "two\n");
    const commit = value(await commitItem(git, path, { id: ITEM_A, title: "Two" }));
    value(await removeWorktree(git, repo.path, worktree));
    expect(existsSync(path)).toBe(false);
    expect(await plain(repo.path, "rev-parse", "tokama/0b9f12ab")).toBe(commit);
  });
});

describe("commitItem", () => {
  it("commits every change on the item branch with the title and the item trailer", SLOW, async () => {
    const worktree = value(await createWorktree(git, repo, ITEM_A));
    const path = worktreePath(repo.path, worktree);
    writeFileSync(join(path, "a.txt"), "two\n");
    writeFileSync(join(path, "b.txt"), "new\n");
    const commit = value(await commitItem(git, path, { id: ITEM_A, title: "Fix the order total" }));
    expect(await plain(repo.path, "rev-parse", "tokama/0b9f12ab")).toBe(commit);
    expect(await plain(repo.path, "rev-parse", "main")).toBe(worktree.baseCommit);
    expect(await plain(path, "log", "-1", "--format=%s")).toBe("tokama: Fix the order total");
    expect(await plain(path, "log", "-1", "--format=%(trailers:key=Tokama-Item,valueonly)")).toBe(ITEM_A);
    expect(await plain(path, "show", "--name-only", "--format=", "HEAD")).toBe("a.txt\nb.txt");
    expect(await plain(path, "status", "--porcelain")).toBe("");
  });

  it("folds a title with line breaks onto one line, so it cannot forge a trailer", SLOW, async () => {
    const worktree = value(await createWorktree(git, repo, ITEM_A));
    const path = worktreePath(repo.path, worktree);
    writeFileSync(join(path, "a.txt"), "two\n");
    value(await commitItem(git, path, { id: ITEM_A, title: "Fix\n\nTokama-Item: item_forged\r\nSigned-off-by: x" }));
    expect(await plain(path, "log", "-1", "--format=%(trailers:key=Tokama-Item,valueonly)")).toBe(ITEM_A);
    expect(await plain(path, "log", "-1", "--format=%(trailers:key=Signed-off-by)")).toBe("");
  });

  it("reports nothing to commit as its own reason", SLOW, async () => {
    const worktree = value(await createWorktree(git, repo, ITEM_A));
    expect(await commitItem(git, worktreePath(repo.path, worktree), { id: ITEM_A, title: "Nothing" })).toMatchObject({
      ok: false,
      error: { reason: "nothing-to-commit" },
    });
  });

  it("builds the message from the title, capped, with the item id when the title is blank", () => {
    expect(commitMessage(ITEM_A, "  Fix\tthe total  ")).toBe(`tokama: Fix the total\n\nTokama-Item: ${ITEM_A}\n`);
    expect(commitMessage(ITEM_A, " \n ")).toBe(`tokama: ${ITEM_A}\n\nTokama-Item: ${ITEM_A}\n`);
    expect(commitMessage(ITEM_A, "x".repeat(300)).split("\n")[0]).toHaveLength("tokama: ".length + 100);
  });
});

describe("worktreeSnapshot", () => {
  it("lists changed, untracked and deleted files with mtime and size, and nothing ignored", SLOW, async () => {
    const worktree = value(await createWorktree(git, repo, ITEM_A));
    const path = worktreePath(repo.path, worktree);
    expect(await worktreeSnapshot(git, path)).toEqual(new Map());
    writeFileSync(join(path, ".gitignore"), "dist/\n");
    mkdirSync(join(path, "dist"));
    writeFileSync(join(path, "dist", "out.js"), "x\n");
    mkdirSync(join(path, "src"));
    writeFileSync(join(path, "src", "new.ts"), "export {};\n");
    unlinkSync(join(path, "a.txt"));
    const snapshot = (await worktreeSnapshot(git, path))!;
    expect([...snapshot.keys()].sort()).toEqual([".gitignore", "a.txt", "src/new.ts"]);
    expect(snapshot.get("a.txt")).toBeNull();
    expect(snapshot.get("src/new.ts")).toEqual({ mtimeMs: expect.any(Number), size: 11 });
  });

  it("is undefined when git fails", SLOW, async () => {
    expect(await worktreeSnapshot(git, home)).toBeUndefined();
  });
});
