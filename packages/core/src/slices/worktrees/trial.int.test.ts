import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGit, type Git } from "../../kernel/git/index.js";
import { createProcessRunner } from "../../kernel/process/index.js";
import type { ItemId } from "../../kernel/schemas/index.js";
import { checkTrialFolder, createTrialWorktree, createWorktree, removeTrialWorktree, trialWorktreePath, worktreePath, type WorktreeRepo } from "./index.js";

const SLOW = { timeout: 30_000 };
const TRIAL = "trial_019a1b2c-3d4e-7f00-8a9b-00000b9f12ab";
const OTHER = "trial_019a1b2c-3d4e-7f00-8a9b-00007e6d5c4b";
const ITEM = "item_019a1b2c-3d4e-7f00-8a9b-00000b9f12ab" as ItemId;

let root: string;
let home: string;
let outside: string;
let repo: WorktreeRepo;
let git: Git;
let commit: string;

async function plain(cwd: string, ...args: string[]): Promise<string> {
  const out: string[] = [];
  const errors: string[] = [];
  const runner = createProcessRunner({ parentEnv: { PATH: process.env["PATH"], HOME: home } });
  const result = await runner.run({ command: { argv: ["git", ...args] }, cwd, env: { GIT_CONFIG_NOSYSTEM: "1" }, stdout: { onLine: (line) => out.push(line) }, stderr: { onLine: (line) => errors.push(line) } });
  if (result.kind !== "finished" || result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${errors.join("\n")}`);
  return out.join("\n").replace(/\n+$/, "");
}

const listed = async () => {
  const entries = await git.worktreeList(repo.path);
  if (!entries.ok) throw new Error("worktree list failed");
  return entries.value;
};

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tokama-trial-test-")));
  home = join(root, "home");
  outside = join(root, "outside");
  const path = join(root, "orders-api");
  for (const dir of [home, outside, path]) mkdirSync(dir);
  await plain(path, "init", "-q", "-b", "main");
  await plain(path, "config", "user.name", "Test");
  await plain(path, "config", "user.email", "test@example.com");
  writeFileSync(join(path, "a.txt"), "one\n");
  await plain(path, "add", "-A");
  await plain(path, "commit", "-q", "-m", "seed");
  commit = await plain(path, "rev-parse", "HEAD");
  repo = { path, baseBranch: "main", worktreeFolder: ".tokama/wt" };
  git = createGit({ runner: createProcessRunner({ parentEnv: { PATH: process.env["PATH"], HOME: home } }) });
}, SLOW.timeout);
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("trial worktrees", () => {
  it("makes a detached worktree at the commit, in the folder, and keeps the folder out of git status", SLOW, async () => {
    const made = await createTrialWorktree(git, repo, TRIAL, commit);
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    expect(made.value).toBe(trialWorktreePath(repo, TRIAL));
    expect(made.value).toBe(join(repo.path, ".tokama", "wt", "try-0b9f12ab"));
    expect(readFileSync(join(made.value, "a.txt"), "utf8")).toBe("one\n");
    const entry = (await listed()).find((candidate) => candidate.path === made.value);
    expect(entry).toMatchObject({ detached: true, head: commit });
    expect(entry?.branch).toBeUndefined();
    expect(readFileSync(join(repo.path, ".git", "info", "exclude"), "utf8")).toContain("/.tokama/wt/");
    expect(await plain(repo.path, "status", "--porcelain")).toBe("");
    expect(await plain(repo.path, "branch", "--list")).toBe("* main");
  });

  it("removes it, changes included, and prunes", SLOW, async () => {
    const made = await createTrialWorktree(git, repo, TRIAL, commit);
    if (!made.ok) throw new Error("create failed");
    writeFileSync(join(made.value, "a.txt"), "dirty\n");
    writeFileSync(join(made.value, "new.txt"), "x\n");
    expect(await removeTrialWorktree(git, repo.path, made.value)).toMatchObject({ ok: true });
    expect(existsSync(made.value)).toBe(false);
    expect((await listed()).map((entry) => entry.path)).toEqual([repo.path]);
  });

  it("removing a worktree that is gone is done", SLOW, async () => {
    const made = await createTrialWorktree(git, repo, TRIAL, commit);
    if (!made.ok) throw new Error("create failed");
    rmSync(made.value, { recursive: true, force: true });
    expect(await removeTrialWorktree(git, repo.path, made.value)).toMatchObject({ ok: true });
    expect((await listed()).map((entry) => entry.path)).toEqual([repo.path]);
    expect(await removeTrialWorktree(git, repo.path, made.value)).toMatchObject({ ok: true });
  });

  it("removes only the trial asked for", SLOW, async () => {
    const first = await createTrialWorktree(git, repo, TRIAL, commit);
    const second = await createTrialWorktree(git, repo, OTHER, commit);
    if (!first.ok || !second.ok) throw new Error("create failed");
    await removeTrialWorktree(git, repo.path, first.value);
    expect(existsSync(first.value)).toBe(false);
    expect(existsSync(second.value)).toBe(true);
  });

  it("never removes an item worktree or a branch worktree named like a trial", SLOW, async () => {
    const item = await createWorktree(git, repo, ITEM);
    if (!item.ok) throw new Error("item worktree failed");
    const itemPath = worktreePath(repo.path, item.value);
    const lookalike = join(repo.path, ".tokama", "wt", "try-deadbeef");
    await plain(repo.path, "worktree", "add", "-q", "-b", "tokama/lookalike", lookalike, "main");
    expect(await removeTrialWorktree(git, repo.path, itemPath)).toMatchObject({ ok: false });
    expect(await removeTrialWorktree(git, repo.path, lookalike)).toMatchObject({ ok: true });
    expect(existsSync(itemPath)).toBe(true);
    expect(existsSync(lookalike)).toBe(true);
    expect((await listed()).some((entry) => entry.branch === "refs/heads/tokama/lookalike")).toBe(true);
    expect(await plain(repo.path, "branch", "--list", "tokama/*")).toContain("tokama/lookalike");
  });

  it("refuses a path outside the repo, even one named try-<hex>", SLOW, async () => {
    const elsewhere = join(outside, "try-deadbeef");
    mkdirSync(elsewhere);
    expect(await removeTrialWorktree(git, repo.path, elsewhere)).toMatchObject({ ok: false });
    expect(existsSync(elsewhere)).toBe(true);
  });
});

describe("a worktree folder that is a link", () => {
  const nothingMade = () => expect(readdirSync(outside)).toEqual([]);

  it("refuses a linked top folder (.tokama) and makes nothing behind it", SLOW, async () => {
    symlinkSync(outside, join(repo.path, ".tokama"));
    expect(await checkTrialFolder(repo, { create: false })).toMatchObject({ ok: false, error: { reason: "folder" } });
    expect(await createTrialWorktree(git, repo, TRIAL, commit)).toMatchObject({ ok: false, error: { reason: "folder" } });
    nothingMade();
  });

  it("refuses a linked last part (.tokama/wt)", SLOW, async () => {
    mkdirSync(join(repo.path, ".tokama"));
    symlinkSync(outside, join(repo.path, ".tokama", "wt"));
    expect(await createTrialWorktree(git, repo, TRIAL, commit)).toMatchObject({ ok: false, error: { reason: "folder" } });
    nothingMade();
    expect(existsSync(join(repo.path, ".git", "info", "exclude")) ? readFileSync(join(repo.path, ".git", "info", "exclude"), "utf8") : "").not.toContain("/.tokama/wt/");
  });

  it("refuses a link to a folder inside the repo too", SLOW, async () => {
    mkdirSync(join(repo.path, "real-wt"));
    symlinkSync(join(repo.path, "real-wt"), join(repo.path, ".tokama"));
    expect(await createTrialWorktree(git, repo, TRIAL, commit)).toMatchObject({ ok: false, error: { reason: "folder" } });
    expect(readdirSync(join(repo.path, "real-wt"))).toEqual([]);
  });

  it("refuses a worktree folder that is a file", SLOW, async () => {
    writeFileSync(join(repo.path, ".tokama"), "not a folder");
    expect(await checkTrialFolder(repo, { create: false })).toMatchObject({ ok: false, error: { reason: "folder" } });
  });

  it("accepts a folder that does not exist yet, and makes it only on create", SLOW, async () => {
    expect(await checkTrialFolder(repo, { create: false })).toMatchObject({ ok: true });
    expect(existsSync(join(repo.path, ".tokama"))).toBe(false);
    expect(await checkTrialFolder(repo, { create: true })).toMatchObject({ ok: true });
    expect(existsSync(join(repo.path, ".tokama", "wt"))).toBe(true);
  });
});
