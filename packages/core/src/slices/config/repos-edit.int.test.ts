// suggestRepo against real git: the top folder, a subfolder, a linked worktree and a detached HEAD.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGit } from "../../kernel/git/index.js";
import { createProcessRunner } from "../../kernel/process/index.js";
import { addRepo, initRepo, makeFirstCommit, suggestRepo, type RepoEditOptions } from "./index.js";

let root: string;
let options: RepoEditOptions;
let fullGit: ReturnType<typeof createGit>;

/** Plain git for fixtures, never through the wrapper. HOME is the temp dir: no global config. */
async function run(cwd: string, ...args: string[]): Promise<void> {
  const errors: string[] = [];
  const runner = createProcessRunner({ parentEnv: { PATH: process.env["PATH"], HOME: root } });
  const result = await runner.run({ command: { argv: ["git", ...args] }, cwd, env: { GIT_CONFIG_NOSYSTEM: "1" }, stderr: { onLine: (line) => errors.push(line) } });
  if (result.kind !== "finished" || result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${errors.join("\n")}`);
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tokama-repos-git-")));
  // The identity the wrapper's own commit needs; HOME is the temp dir.
  writeFileSync(join(root, ".gitconfig"), "[user]\n\tname = t\n\temail = t@example.com\n");
  const runner = createProcessRunner({ parentEnv: { PATH: process.env["PATH"], HOME: root } });
  fullGit = createGit({ runner });
  options = { tokamaHome: join(root, "home"), git: fullGit };
  const repo = join(root, "orders-api");
  mkdirSync(join(repo, "src"), { recursive: true });
  await run(repo, "init", "-q", "-b", "trunk");
  await run(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "first");
  await run(repo, "worktree", "add", "-q", "-b", "feature/x", join(root, "orders-wt"));
  await run(root, "init", "-q", "-b", "main", "unborn");
  await run(root, "clone", "-q", repo, "detached");
  await run(join(root, "detached"), "checkout", "-q", "--detach");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("suggestRepo with git", () => {
  it("reads the branch of the top folder, of a linked worktree and of a repo without commits", async () => {
    expect(await suggestRepo(options, join(root, "orders-api"))).toMatchObject({ ok: true, value: { gitRepo: true, hasCommits: true, branch: "trunk", problem: undefined } });
    expect(await suggestRepo(options, join(root, "orders-wt"))).toMatchObject({ ok: true, value: { gitRepo: true, branch: "feature/x" } });
    expect(await suggestRepo(options, join(root, "unborn"))).toMatchObject({ ok: true, value: { gitRepo: true, hasCommits: false, branch: "main", problem: "This repo has no commits yet. Make a first commit, then add it." } });
  });

  it("has no branch for a detached HEAD", async () => {
    expect(await suggestRepo(options, join(root, "detached"))).toMatchObject({ ok: true, value: { gitRepo: true, branch: undefined } });
  });

  it("does not hang on a yarn.lock that is a FIFO, and takes it for Yarn 1", async () => {
    const folder = join(root, "fifo-repo");
    mkdirSync(folder);
    const runner = createProcessRunner({ parentEnv: { PATH: process.env["PATH"], HOME: root } });
    const made = await runner.run({ command: { argv: ["mkfifo", join(folder, "yarn.lock")] }, cwd: root });
    expect(made).toMatchObject({ kind: "finished", exitCode: 0 });
    expect(await suggestRepo(options, folder)).toMatchObject({ ok: true, value: { setup: "yarn install --frozen-lockfile", setupFrom: "yarn.lock" } });
  });

  it("asks for the top folder when given a subfolder", async () => {
    expect(await suggestRepo(options, join(root, "orders-api", "src"))).toMatchObject({
      ok: true,
      value: { gitRepo: false, problem: "This folder is inside a git repo. Pick the repo's top folder, the one that holds .git." },
    });
  });
});

/** Both steps, as the dialog runs them. */
async function setUpRepo(opts: RepoEditOptions, input: { path: string }) {
  const first = await initRepo(opts, input);
  if (!first.ok) return first;
  const second = await makeFirstCommit(opts, input);
  return second.ok ? ({ ok: true, value: undefined } as const) : second;
}

describe("the base branch with git", () => {
  it("takes a local branch such as release/1.2 and refuses a remote name or a full ref, naming the local branch", async () => {
    const folder = join(root, "base-check");
    mkdirSync(folder);
    await run(folder, "init", "-q", "-b", "trunk");
    await run(folder, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "first");
    await run(folder, "branch", "release/1.2");
    await run(folder, "update-ref", "refs/remotes/origin/trunk", "HEAD");
    const refused = (name: string) => `The base branch '${name}' is not a local branch of this repo.`;
    expect(await addRepo(options, { path: folder, baseBranch: "origin/trunk" })).toEqual({ ok: false, error: { code: "invalid_request", message: `${refused("origin/trunk")} Use 'trunk' instead.` } });
    expect(await addRepo(options, { path: folder, baseBranch: "refs/heads/trunk" })).toEqual({ ok: false, error: { code: "invalid_request", message: `${refused("refs/heads/trunk")} Use 'trunk' instead.` } });
    expect(await addRepo(options, { path: folder, baseBranch: "origin/other" })).toMatchObject({ ok: false, error: { message: `${refused("origin/other")} Pick one of its local branches.` } });
    expect(await addRepo(options, { path: folder, baseBranch: "release/1.2" })).toMatchObject({ ok: true, value: { baseBranch: "release/1.2" } });
  });
});

describe("setUpRepo with git", () => {
  it("makes a plain folder a repo with a first commit that leaves out the default ignores, then adds it", async () => {
    const folder = join(root, "plain-app");
    mkdirSync(join(folder, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(folder, "index.js"), "console.log(1);\n");
    writeFileSync(join(folder, ".env"), "SECRET=1\n");
    writeFileSync(join(folder, "node_modules", "dep", "a.js"), "1");
    expect(await suggestRepo(options, folder)).toMatchObject({ ok: true, value: { gitRepo: false, firstCommit: { files: 2, sample: [{ path: ".gitignore", bytes: 43 }, { path: "index.js", bytes: 16 }], leftOut: [{ name: ".env", files: 1 }, { name: "node_modules/", files: 1 }], addsGitignore: true } } });

    expect(await setUpRepo(options, { path: folder })).toEqual({ ok: true, value: undefined });
    expect(readFileSync(join(folder, ".gitignore"), "utf8")).toContain("node_modules/");
    expect(await fullGit.lsTree(folder, "HEAD")).toEqual({ ok: true, value: [".gitignore", "index.js"] });
    expect(await suggestRepo(options, folder)).toMatchObject({ ok: true, value: { gitRepo: true, hasCommits: true, branch: "main", firstCommit: undefined, problem: undefined } });
    expect(await addRepo(options, { path: folder })).toMatchObject({ ok: true, value: { baseBranch: "main" } });
    expect(await setUpRepo(options, { path: folder }), "a second call changes nothing").toEqual({ ok: true, value: undefined });
  });

  it("refuses a first commit that a negation in the folder's .gitignore would extend to a file the preview skipped", async () => {
    const folder = join(root, "negated");
    mkdirSync(folder);
    writeFileSync(join(folder, ".gitignore"), "secret*\n!secret.key\n");
    writeFileSync(join(folder, "secret.key"), "k");
    writeFileSync(join(folder, "index.js"), "1");
    expect(await suggestRepo(options, folder)).toMatchObject({ ok: true, value: { firstCommit: { files: 2 } } });
    expect(await initRepo(options, { path: folder })).toMatchObject({ ok: true });
    expect(await makeFirstCommit(options, { path: folder })).toMatchObject({ ok: false, error: { message: expect.stringContaining("secret.key") } });
    expect(await fullGit.revParse(folder, "HEAD")).toMatchObject({ ok: false });
  });

  it("makes the first commit in a repo that has none", async () => {
    const folder = join(root, "unborn");
    writeFileSync(join(folder, "a.txt"), "1");
    expect(await setUpRepo(options, { path: folder })).toEqual({ ok: true, value: undefined });
    expect(await suggestRepo(options, folder)).toMatchObject({ ok: true, value: { hasCommits: true, branch: "main", problem: undefined } });
  });
});
