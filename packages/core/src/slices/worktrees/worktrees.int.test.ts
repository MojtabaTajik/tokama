import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGit, type Git } from "../../kernel/git/index.js";
import { createProcessRunner } from "../../kernel/process/index.js";
import type { ItemId } from "../../kernel/schemas/index.js";
import {
  commitItem,
  createWorktree,
  discardWorktree,
  findItemWorktree,
  type ItemWorktree,
  removeWorktree,
  shortItemId,
  stageItem,
  worktreePath,
  type WorktreeRepo,
  worktreeSnapshot,
} from "./index.js";

const SLOW = { timeout: 30_000 };
// UUIDv7 ids made in the same millisecond: the same timestamp prefix, different random tails.
const ITEM_A = "item_019a1b2c-3d4e-7f00-8a9b-00000b9f12ab" as ItemId;
const ITEM_B = "item_019a1b2c-3d4e-7f00-8a9b-00007e6d5c4b" as ItemId;

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

/** Stages and commits the worktree, as the engine does around the checks. */
async function finish(worktree: ItemWorktree, id: ItemId, title: string, text = title) {
  const path = worktreePath(repo.path, worktree);
  const tree = value(await stageItem(git, path));
  return commitItem(git, path, worktree, { id, title, text, tree });
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
    value(await finish(a, ITEM_A, "A"));
    expect(await plain(worktreePath(repo.path, b), "status", "--porcelain")).toBe("");
    expect(await plain(repo.path, "log", "-1", "--format=%s", "tokama/7e6d5c4b")).toBe("seed");
  });

  it("finds an item's registered worktree after a start that crashed before recording it", SLOW, async () => {
    expect(value(await findItemWorktree(git, repo, ITEM_A))).toBeUndefined();
    const created = value(await createWorktree(git, repo, ITEM_A));
    expect(await createWorktree(git, repo, ITEM_A)).toMatchObject({ ok: false, error: { reason: "exists" } });
    expect(value(await findItemWorktree(git, repo, ITEM_A))).toEqual(created);
    // Another item's worktree is not this item's.
    expect(value(await findItemWorktree(git, repo, ITEM_B))).toBeUndefined();
  });

  it("takes the short id from the random tail of the item id", () => {
    expect([shortItemId(ITEM_A), shortItemId(ITEM_B)]).toEqual(["0b9f12ab", "7e6d5c4b"]);
  });

  it("returns errors as values: a missing base branch, an item that already has a worktree", SLOW, async () => {
    expect(await createWorktree(git, { ...repo, baseBranch: "develop" }, ITEM_A)).toMatchObject({ ok: false, error: { reason: "base-branch" } });
    value(await createWorktree(git, repo, ITEM_A));
    expect(await createWorktree(git, repo, ITEM_A)).toMatchObject({ ok: false, error: { reason: "exists" } });
  });

  it("refuses a branch that exists already and leaves it alone", SLOW, async () => {
    writeFileSync(join(repo.path, "a.txt"), "someone else's work\n");
    await plain(repo.path, "commit", "-q", "-am", "theirs");
    await plain(repo.path, "branch", "tokama/0b9f12ab");
    const tip = await plain(repo.path, "rev-parse", "tokama/0b9f12ab");
    await plain(repo.path, "reset", "-q", "--hard", "HEAD~1");
    expect(await createWorktree(git, repo, ITEM_A)).toMatchObject({ ok: false, error: { reason: "exists" } });
    expect(await plain(repo.path, "rev-parse", "tokama/0b9f12ab")).toBe(tip);
    expect(existsSync(join(repo.path, ".tokama", "wt", "0b9f12ab"))).toBe(false);
  });

  it("leaves another worktree registered at the path alone when the add fails", SLOW, async () => {
    const path = join(repo.path, ".tokama", "wt", "0b9f12ab");
    await plain(repo.path, "worktree", "add", "-q", "-b", "other", path, "main");
    rmSync(path, { recursive: true, force: true });
    expect(await createWorktree(git, repo, ITEM_A)).toMatchObject({ ok: false, error: { reason: "add" } });
    expect(await plain(repo.path, "worktree", "list", "--porcelain")).toContain("branch refs/heads/other");
    expect(await plain(repo.path, "branch", "--list", "other")).toContain("other");
    expect(await plain(repo.path, "branch", "--list", "tokama/*")).toBe("");
  });

  it("rolls back the branch and worktree it made when the checkout fails", SLOW, async () => {
    // A required filter the wrapper does not run: the add succeeds, the checkout in it fails.
    await plain(repo.path, "config", "filter.crypt.process", "false");
    await plain(repo.path, "config", "filter.crypt.required", "true");
    writeFileSync(join(repo.path, ".git", "info", "attributes"), "*.txt filter=crypt\n");
    const created = await createWorktree(git, repo, ITEM_A);
    expect(created).toMatchObject({ ok: false, error: { reason: "add" } });
    if (!created.ok) expect(created.error.message).toMatch(/filter/);
    expect(await plain(repo.path, "branch", "--list", "tokama/*")).toBe("");
    expect(await plain(repo.path, "worktree", "list", "--porcelain")).not.toContain("0b9f12ab");
    expect(existsSync(join(repo.path, ".tokama", "wt", "0b9f12ab"))).toBe(false);
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
    value(await finish(worktree, ITEM_A, "Change"));
    value(await removeWorktree(git, repo.path, worktree));
    expect(await plain(repo.path, "branch", "--list", "tokama/*")).toContain("tokama/0b9f12ab");
    value(await discardWorktree(git, repo.path, worktree));
    expect(await plain(repo.path, "branch", "--list", "tokama/*")).toBe("");
  });

  it("discard finds a worktree whose branch an agent switched, and leaves no folder behind", SLOW, async () => {
    await plain(path, "checkout", "-q", "-b", "elsewhere");
    value(await discardWorktree(git, repo.path, worktree));
    expect(existsSync(path)).toBe(false);
    expect(await plain(repo.path, "branch", "--list", "tokama/*")).toBe("");
  });

  it("remove and discard work again after a folder was deleted by hand, and after they ran", SLOW, async () => {
    rmSync(path, { recursive: true, force: true });
    value(await removeWorktree(git, repo.path, worktree));
    expect(await plain(repo.path, "worktree", "list", "--porcelain")).not.toContain("0b9f12ab");
    value(await removeWorktree(git, repo.path, worktree));
    value(await discardWorktree(git, repo.path, worktree));
    expect(await plain(repo.path, "branch", "--list", "tokama/*")).toBe("");
  });

  it("remove refuses a worktree with uncommitted changes and keeps it; force removes it", SLOW, async () => {
    writeFileSync(join(path, "a.txt"), "changed\n");
    expect(await removeWorktree(git, repo.path, worktree)).toMatchObject({ ok: false, error: { reason: "remove" } });
    expect(readFileSync(join(path, "a.txt"), "utf8")).toBe("changed\n");
    value(await removeWorktree(git, repo.path, worktree, { force: true }));
    expect(existsSync(path)).toBe(false);
  });

  it("remove after the commit removes the worktree and keeps the branch; ignored files do not block it", SLOW, async () => {
    writeFileSync(join(path, ".gitignore"), "node_modules/\n");
    mkdirSync(join(path, "node_modules"));
    writeFileSync(join(path, "node_modules", "dep.js"), "x\n");
    writeFileSync(join(path, "a.txt"), "two\n");
    const commit = value(await finish(worktree, ITEM_A, "Two"));
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
    const commit = value(await finish(worktree, ITEM_A, "Fix the order total"));
    expect(await plain(repo.path, "rev-parse", "tokama/0b9f12ab")).toBe(commit);
    expect(await plain(repo.path, "rev-parse", "main")).toBe(worktree.baseCommit);
    expect(await plain(path, "log", "-1", "--format=%s")).toBe("tokama: Fix the order total");
    expect(await plain(path, "log", "-1", "--format=%(trailers:key=Tokama-Item,valueonly)")).toBe(ITEM_A);
    expect(await plain(path, "show", "--name-only", "--format=", "HEAD")).toBe("a.txt\nb.txt");
    expect(await plain(path, "status", "--porcelain")).toBe("");
  });

  it("commits the tree staged before the checks, not files the checks wrote after it", SLOW, async () => {
    const worktree = value(await createWorktree(git, repo, ITEM_A));
    const path = worktreePath(repo.path, worktree);
    writeFileSync(join(path, "a.txt"), "the agent's fix\n");
    const tree = value(await stageItem(git, path));
    // A check run writes after the tree was fixed.
    writeFileSync(join(path, "a.txt"), "written by a check\n");
    writeFileSync(join(path, "planted.txt"), "x\n");
    value(await commitItem(git, path, worktree, { id: ITEM_A, title: "Fix", text: "Fix", tree }));
    expect(await plain(repo.path, "show", "tokama/0b9f12ab:a.txt")).toBe("the agent's fix");
    expect(await plain(repo.path, "show", "--name-only", "--format=", "tokama/0b9f12ab")).toBe("a.txt");
    expect(await plain(repo.path, "rev-parse", "tokama/0b9f12ab^")).toBe(worktree.baseCommit);
  });

  it("refuses to commit when the branch moved since the item started", SLOW, async () => {
    const worktree = value(await createWorktree(git, repo, ITEM_A));
    const path = worktreePath(repo.path, worktree);
    writeFileSync(join(path, "a.txt"), "two\n");
    const tree = value(await stageItem(git, path));
    await plain(path, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "an agent's own commit");
    const moved = await plain(repo.path, "rev-parse", "tokama/0b9f12ab");
    expect(await commitItem(git, path, worktree, { id: ITEM_A, title: "Fix", text: "Fix", tree })).toMatchObject({ ok: false, error: { reason: "git" } });
    expect(await plain(repo.path, "rev-parse", "tokama/0b9f12ab")).toBe(moved);
  });

  it("commits a short subject, the full request and the item trailer as the last paragraph", SLOW, async () => {
    const worktree = value(await createWorktree(git, repo, ITEM_A));
    const path = worktreePath(repo.path, worktree);
    writeFileSync(join(path, "a.txt"), "two\n");
    const text = `Fix the order total.\n\nIt drops the shipping line when the cart has one item.\n${"long ".repeat(60)}`;
    value(await finish(worktree, ITEM_A, "Fix the order total.", text));
    expect(await plain(path, "log", "-1", "--format=%s")).toBe("tokama: Fix the order total.");
    expect(await plain(path, "log", "-1", "--format=%b")).toBe(`${text.trimEnd()}\n\nTokama-Item: ${ITEM_A}`);
    expect(await plain(path, "log", "-1", "--format=%(trailers:key=Tokama-Item,valueonly)")).toBe(ITEM_A);
  });

  it("a request cannot forge a trailer, even with a patch separator, a scissors line or a trailer-only paragraph", SLOW, async () => {
    const forged = [
      "Fix\n\nTokama-Item: item_forged\r\nSigned-off-by: x",
      "Fix\n\n---\nTokama-Item: item_forged",
      "Fix\n\n--- a/file\n+++ b/file\n\nSigned-off-by: x",
      "Fix\n\nSigned-off-by: x\nTokama-Item: item_forged",
      "Fix\n\n# ------------------------ >8 ------------------------\nTokama-Item: item_forged",
      "; ------------------------ >8 ------------------------\nFix",
    ];
    for (const [index, text] of forged.entries()) {
      const worktree = value(await createWorktree(git, repo, ITEM_A));
      const path = worktreePath(repo.path, worktree);
      writeFileSync(join(path, "a.txt"), `two ${index}\n`);
      value(await finish(worktree, ITEM_A, "Fix", text));
      const message = await plain(path, "log", "-1", "--format=%B");
      writeFileSync(join(home, "message.txt"), message);
      expect(await plain(path, "interpret-trailers", "--parse", join(home, "message.txt"))).toBe(`Tokama-Item: ${ITEM_A}`);
      expect(await plain(path, "log", "-1", "--format=%(trailers:only,unfold)")).toBe(`Tokama-Item: ${ITEM_A}`);
      expect(await plain(path, "log", "-1", "--format=%(trailers:key=Signed-off-by)")).toBe("");
      expect(message.trimEnd().split("\n").at(-1)).toBe(`Tokama-Item: ${ITEM_A}`);
      await plain(repo.path, "worktree", "remove", "--force", path);
      await plain(repo.path, "branch", "-D", worktree.branch);
    }
  });

  it("reports nothing to commit as its own reason", SLOW, async () => {
    const worktree = value(await createWorktree(git, repo, ITEM_A));
    expect(await finish(worktree, ITEM_A, "Nothing")).toMatchObject({
      ok: false,
      error: { reason: "nothing-to-commit" },
    });
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
