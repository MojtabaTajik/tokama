// suggestRepo against real git: the top folder, a subfolder, a linked worktree and a detached HEAD.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGit } from "../../kernel/git/index.js";
import { createProcessRunner } from "../../kernel/process/index.js";
import { suggestRepo, type RepoEditOptions } from "./index.js";

let root: string;
let options: RepoEditOptions;

/** Plain git for fixtures, never through the wrapper. HOME is the temp dir: no global config. */
async function run(cwd: string, ...args: string[]): Promise<void> {
  const errors: string[] = [];
  const runner = createProcessRunner({ parentEnv: { PATH: process.env["PATH"], HOME: root } });
  const result = await runner.run({ command: { argv: ["git", ...args] }, cwd, env: { GIT_CONFIG_NOSYSTEM: "1" }, stderr: { onLine: (line) => errors.push(line) } });
  if (result.kind !== "finished" || result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${errors.join("\n")}`);
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tokama-repos-git-")));
  const runner = createProcessRunner({ parentEnv: { PATH: process.env["PATH"], HOME: root } });
  options = { tokamaHome: join(root, "home"), git: createGit({ runner }) };
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
    expect(await suggestRepo(options, join(root, "orders-api"))).toMatchObject({ ok: true, value: { gitRepo: true, branch: "trunk", problem: undefined } });
    expect(await suggestRepo(options, join(root, "orders-wt"))).toMatchObject({ ok: true, value: { gitRepo: true, branch: "feature/x" } });
    expect(await suggestRepo(options, join(root, "unborn"))).toMatchObject({ ok: true, value: { gitRepo: true, branch: "main" } });
  });

  it("has no branch for a detached HEAD", async () => {
    expect(await suggestRepo(options, join(root, "detached"))).toMatchObject({ ok: true, value: { gitRepo: true, branch: undefined } });
  });

  it("asks for the top folder when given a subfolder", async () => {
    expect(await suggestRepo(options, join(root, "orders-api", "src"))).toMatchObject({
      ok: true,
      value: { gitRepo: false, problem: "This folder is inside a git repo. Pick the repo's top folder, the one that holds .git." },
    });
  });
});
