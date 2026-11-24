import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGit, type Git } from "../../kernel/git/index.js";
import { createProcessRunner } from "../../kernel/process/index.js";
import { protectedSet, type ProtectedSet, tamperChanges } from "./index.js";

// Ported from ai-pipeline tests/test_loop_stub.py (an fsmonitor written into .git/config during a
// step is a tamper event) and tests/test_sampler_and_run.py (file_hashes over a file, a hooks
// folder and a missing path; changed_paths lists what changed). Paths here are relative, not the
// harness's absolute paths.

const SLOW = { timeout: 30_000 };

let root: string;
let home: string;
let repo: string;
let wt: string;
let git: Git;
let set: ProtectedSet;

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
  return out.join("\n").trim();
}

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const SEED: Record<string, string> = {
  "package.json": '{"scripts":{"test":"vitest"}}\n',
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "vitest.config.ts": "export default {};\n",
  ".github/workflows/ci.yml": "on: push\n",
  ".tokama/templates/fix.yaml": "format: 1\n",
  "src/total.ts": "export const total = 1;\n",
  "src/total.test.ts": "test('total', () => {});\n",
  "src/__snapshots__/total.test.ts.snap": "exports[`total`] = `1`;\n",
  "test/fixtures/order.json": "{}\n",
};

/** Hashes, applies `change`, hashes again, and returns what the tamper check reports. */
async function changesAfter(change: () => void | Promise<void>) {
  const before = await set.hash();
  await change();
  const after = await set.hash();
  return tamperChanges(before, after);
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tokama-integrity-test-")));
  home = join(root, "home");
  repo = join(root, "orders-api");
  mkdirSync(home);
  mkdirSync(repo);
  await plain(repo, "init", "-q", "-b", "main");
  await plain(repo, "config", "user.name", "Test");
  await plain(repo, "config", "user.email", "test@example.com");
  for (const [path, content] of Object.entries(SEED)) write(join(repo, path), content);
  await plain(repo, "add", "-A");
  await plain(repo, "commit", "-q", "-m", "seed");
  appendFileSync(join(repo, ".git", "info", "exclude"), "/.tokama/wt/\n");
  git = createGit({ runner: createProcessRunner({ parentEnv: { PATH: process.env["PATH"], HOME: home } }) });
  wt = join(repo, ".tokama", "wt", "0b9f12ab");
  mkdirSync(dirname(wt), { recursive: true });
  const baseCommit = await plain(repo, "rev-parse", "main");
  value(await git.worktreeAdd(repo, wt, "tokama/0b9f12ab", baseCommit));
  set = value(await protectedSet(git, { repoPath: repo, worktreePath: wt, worktreeFolder: ".tokama/wt", baseCommit }));
}, SLOW.timeout);
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("no tamper event for normal work", () => {
  it("edits, new tests and snapshots, staging and committing, and another item's worktree", SLOW, async () => {
    const changes = await changesAfter(async () => {
      write(join(wt, "src/total.ts"), "export const total = 2;\n");
      write(join(wt, "src/discount.ts"), "export const discount = 0;\n");
      write(join(wt, "src/discount.test.ts"), "test('discount', () => {});\n");
      write(join(wt, "src/__snapshots__/discount.test.ts.snap"), "exports[`d`] = `0`;\n");
      write(join(wt, "package.json"), '{"scripts":{"test":"vitest"},"dependencies":{}}\n');
      await plain(wt, "add", "-A");
      await plain(wt, "commit", "-q", "-m", "work");
      // A second item on the same repo: created and discarded through the wrapper.
      const other = join(repo, ".tokama", "wt", "7e6d5c4b");
      value(await git.worktreeAdd(repo, other, "tokama/7e6d5c4b", "main"));
      write(join(other, "src/total.test.ts"), "changed in another item\n");
      value(await git.worktreeRemove(repo, other, { force: true }));
      value(await git.branchDelete(repo, "tokama/7e6d5c4b"));
    });
    expect(changes).toEqual([]);
  });
});

describe("a tamper event for each protected category", () => {
  it("an fsmonitor written into the shared .git/config", SLOW, async () => {
    const changes = await changesAfter(() => appendFileSync(join(repo, ".git", "config"), "\n[core]\n\tfsmonitor = touch pwned\n"));
    expect(changes).toEqual([{ area: "git", path: "config", category: "git", change: "modified" }]);
  });

  it("a hook added and the config changed together, sorted", SLOW, async () => {
    const changes = await changesAfter(() => {
      write(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\n");
      appendFileSync(join(repo, ".git", "config"), "\n");
    });
    expect(changes.map((change) => [change.path, change.change])).toEqual([
      ["config", "modified"],
      ["hooks/pre-commit", "added"],
    ]);
  });

  it.each([
    ["info/attributes", "* filter=x\n"],
    ["info/exclude", "src/\n"],
    ["config.worktree", "[core]\n\tfsmonitor = x\n"],
    ["worktrees/0b9f12ab/config.worktree", "[core]\n\tfsmonitor = x\n"],
  ])("git: %s", SLOW, async (path, content) => {
    const changes = await changesAfter(() => appendFileSync(join(repo, ".git", path), content));
    expect(changes).toEqual([{ area: "git", path, category: "git", change: expect.stringMatching(/added|modified/) }]);
  });

  it("git: the worktree's .git file pointed elsewhere", SLOW, async () => {
    const changes = await changesAfter(() => writeFileSync(join(wt, ".git"), `gitdir: ${join(root, "elsewhere")}\n`));
    expect(changes).toContainEqual({ area: "worktree", path: ".git", category: "git", change: "modified" });
  });

  it.each([
    ["worktree", ".tokama/templates/fix.yaml", "modified"],
    ["worktree", ".tokama/agents/builder.md", "added"],
    ["repo", ".tokama/templates/fix.yaml", "modified"],
    ["repo", ".tokama/agents/builder.md", "added"],
  ] as const)("tokama: %s %s %s", SLOW, async (area, path, change) => {
    const changes = await changesAfter(() => write(join(area === "repo" ? repo : wt, path), "format: 1\nrole: anything\n"));
    expect(changes).toEqual([{ area, path, category: "tokama", change }]);
  });

  it.each([
    ["src/total.test.ts", "test"],
    ["test/fixtures/order.json", "test"],
    ["src/__snapshots__/total.test.ts.snap", "snapshot"],
    ["vitest.config.ts", "test-config"],
    [".github/workflows/ci.yml", "ci"],
    ["pnpm-lock.yaml", "lockfile"],
  ] as const)("worktree: %s changed (%s)", SLOW, async (path, category) => {
    const changes = await changesAfter(() => appendFileSync(join(wt, path), "// changed\n"));
    expect(changes).toEqual([{ area: "worktree", path, category, change: "modified" }]);
  });

  it("test: a base-commit test deleted, and one replaced by a symlink", SLOW, async () => {
    const changes = await changesAfter(() => {
      unlinkSync(join(wt, "src/total.test.ts"));
      unlinkSync(join(wt, "test/fixtures/order.json"));
      symlinkSync(join(root, "elsewhere.json"), join(wt, "test/fixtures/order.json"));
    });
    expect(changes).toEqual([
      { area: "worktree", path: "src/total.test.ts", category: "test", change: "removed" },
      { area: "worktree", path: "test/fixtures/order.json", category: "test", change: "modified" },
    ]);
  });

  it.each([
    ["vitest.config.mts", "test-config"],
    ["packages/web/jest.config.js", "test-config"],
    [".github/workflows/release.yml", "ci"],
    ["packages/web/package-lock.json", "lockfile"],
  ] as const)("new file: %s (%s)", SLOW, async (path, category) => {
    const changes = await changesAfter(() => write(join(wt, path), "x\n"));
    expect(changes).toEqual([{ area: "worktree", path, category, change: "added" }]);
  });

  it("new file: a root test config hidden by an ignore rule", SLOW, async () => {
    write(join(wt, ".gitignore"), "vitest.config.mts\n");
    const changes = await changesAfter(() => write(join(wt, "vitest.config.mts"), "export default { test: { include: [] } };\n"));
    expect(changes).toEqual([{ area: "worktree", path: "vitest.config.mts", category: "test-config", change: "added" }]);
  });
});

describe("protectedSet", () => {
  it("reports a worktree it cannot read as an error value", SLOW, async () => {
    expect(await protectedSet(git, { repoPath: repo, worktreePath: home, worktreeFolder: ".tokama/wt", baseCommit: "main" })).toMatchObject({ ok: false });
  });

  it("names files by area and relative path, never an absolute path", SLOW, async () => {
    const hashes = await set.hash();
    expect(hashes.size).toBeGreaterThan(5);
    for (const file of hashes.values()) expect(file.path.startsWith("/")).toBe(false);
  });
});
