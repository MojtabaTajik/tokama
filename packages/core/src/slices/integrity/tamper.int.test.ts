import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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
async function changesAfter(change: () => unknown) {
  const before = value(await set.hash());
  await change();
  const after = value(await set.hash());
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
  set = value(await protectedSet(git, { repoPath: repo, worktreePath: wt, worktreeFolder: ".tokama/wt", baseCommit, branch: "tokama/0b9f12ab" }));
}, SLOW.timeout);
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("no tamper event for normal work", () => {
  it("edits, new tests and snapshots, staging, and another item's worktree", SLOW, async () => {
    const changes = await changesAfter(async () => {
      write(join(wt, "src/total.ts"), "export const total = 2;\n");
      write(join(wt, "src/discount.ts"), "export const discount = 0;\n");
      write(join(wt, "src/discount.test.ts"), "test('discount', () => {});\n");
      write(join(wt, "src/__snapshots__/discount.test.ts.snap"), "exports[`d`] = `0`;\n");
      write(join(wt, "node_modules", "dep", "package.json"), "{}\n");
      write(join(wt, "node_modules", "dep", "vitest.config.ts"), "x\n");
      await plain(wt, "add", "-A");
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

  it("git config counts by its keys: layout and remote and branch keys do not count; a watched key does", SLOW, async () => {
    const config = join(repo, ".git", "config");
    expect(
      await changesAfter(async () => {
        appendFileSync(config, "\n\n# a comment\n");
        await plain(repo, "config", "remote.origin.url", "https://example.invalid/orders-api.git");
        await plain(repo, "config", "branch.main.remote", "origin");
        await plain(repo, "config", "branch.main.merge", "refs/heads/main");
      }),
    ).toEqual([]);
    for (const [key, value] of [["core.sshCommand", "touch pwned"], ["alias.st", "!touch pwned"], ["credential.helper", "!touch pwned"], ["url.https://example.invalid/.insteadOf", "x"]] as const) {
      expect(await changesAfter(() => plain(repo, "config", key, value)), key).toEqual([{ area: "git", path: "config", category: "git", change: "modified" }]);
    }
  });

  it("only the listed remote and branch keys do not count: a real `git push -u` and `git remote set-url` to network URLs do not", SLOW, async () => {
    // The https URL reaches a local bare repo through a rewrite set before the baseline.
    await plain(root, "init", "-q", "--bare", join(root, "origin.git"));
    await plain(repo, "config", `url.${root}/.insteadOf`, "https://example.invalid/");
    expect(
      await changesAfter(async () => {
        await plain(repo, "remote", "add", "origin", "https://example.invalid/origin.git");
        await plain(repo, "push", "-q", "-u", "origin", "main");
        for (const url of ["ssh://git@example.invalid/orders-api.git", "git@example.invalid:orders-api.git", "git://example.invalid/orders-api.git", "http://example.invalid/orders-api.git"]) {
          await plain(repo, "remote", "set-url", "origin", url);
        }
        await plain(repo, "remote", "set-url", "--push", "origin", "git@example.invalid:team/push.git");
        for (const [key, value] of [["remote.origin.push", "refs/heads/main"], ["remote.origin.tagOpt", "--no-tags"], ["remote.origin.prune", "true"], ["branch.main.pushRemote", "origin"], ["branch.main.rebase", "true"]]) {
          await plain(repo, "config", key!, value!);
        }
      }),
    ).toEqual([]);
    const watched = [
      ["remote.origin.uploadpack", "touch pwned"],
      ["remote.origin.receivepack", "touch pwned"],
      ["remote.origin.vcs", "pwned"],
      ["remote.origin.proxy", "http://example.invalid"],
      ["remote.pushDefault", "origin"],
      ["branch.main.description", "notes"],
      ["branch.autoSetupMerge", "always"],
      // A value or subsection that ends like an ignored key does not hide the key.
      ["remote.origin.uploadpack", "x\nremote.origin.url"],
      ["remote.origin.url.uploadpack", "touch pwned"],
      // A remote section named by a URL: git reads it for a push or fetch to that URL.
      ["remote.https://example.invalid/orders-api.git.pushurl", "https://evil.example.invalid/x.git"],
      ["remote.git@example.invalid:orders-api.git.url", "git@evil.example.invalid:x.git"],
      // A url or pushurl that is a local path or a transport helper.
      ["remote.origin.url", "/srv/evil.git"],
      ["remote.origin.url", "../evil.git"],
      ["remote.origin.url", "./evil:repo"],
      ["remote.origin.url", "~/evil.git"],
      ["remote.origin.url", "file:///srv/evil.git"],
      ["remote.origin.url", "ext::sh -c touch% pwned"],
      ["remote.origin.url", "fd::3"],
      ["remote.origin.url", "custom::anything"],
      ["remote.origin.url", "custom://example.invalid/x"],
      ["remote.origin.pushurl", "/srv/evil.git"],
      ["remote.origin.pushurl", "file:///srv/evil.git"],
      ["remote.origin.pushurl", "custom://example.invalid/x"],
      ["remote.origin.pushurl", "ext::sh -c touch% pwned"],
      // A network-looking URL that reads as another host.
      ["remote.origin.pushurl", "https://evil.example.invalid#@example.invalid/orders-api.git"],
      ["remote.origin.url", "https://evil.example.invalid?@example.invalid/orders-api.git"],
      // A branch remote that is a path or URL, not a remote name.
      ["branch.main.remote", "/srv/evil.git"],
      ["branch.main.remote", "../evil.git"],
      ["branch.main.remote", "file:///srv/evil.git"],
      ["branch.main.pushRemote", "/srv/evil.git"],
      ["branch.main.pushRemote", "git@example.invalid:evil.git"],
    ];
    for (const [key, value] of watched) {
      // From network URLs and remote names each time, so each case tests its own value.
      await plain(repo, "config", "remote.origin.url", "https://example.invalid/orders-api.git");
      await plain(repo, "config", "remote.origin.pushurl", "https://example.invalid/orders-api.git");
      await plain(repo, "config", "branch.main.remote", "origin");
      await plain(repo, "config", "branch.main.pushRemote", "origin");
      expect(await changesAfter(() => plain(repo, "config", key!, value!)), `${key} = ${value}`).toEqual([{ area: "git", path: "config", category: "git", change: "modified" }]);
    }
  });

  it("files a git config includes count by content, resolved from the including file's folder", SLOW, async () => {
    const config = join(repo, ".git", "config");
    // Relative to .git/, then relative to the included file's own folder.
    write(join(repo, "conf", "first.config"), "[include]\n\tpath = nested/second.config\n");
    write(join(repo, "conf", "nested", "second.config"), "[core]\n\tpager = less\n");
    write(join(root, "cond.config"), "[core]\n\tpager = less\n");
    appendFileSync(config, `[include]\n\tpath = ../conf/first.config\n[includeIf "onbranch:nomatch/**"]\n\tpath = ${join(root, "cond.config")}\n`);
    for (const file of [join(repo, "conf", "first.config"), join(repo, "conf", "nested", "second.config"), join(root, "cond.config")]) {
      expect(await changesAfter(() => appendFileSync(file, "\tpager = touch pwned\n")), file).toEqual([{ area: "git", path: "config", category: "git", change: "modified" }]);
    }
  });

  it("an included file that is missing, a symlink, too large or nested too deep makes the hash an error", SLOW, async () => {
    const config = join(repo, ".git", "config");
    const before = readFileSync(config, "utf8");
    /** level1.config includes level2.config and so on; the last includes nothing. */
    const chain = (levels: number) => {
      for (let level = 1; level <= levels; level++) write(join(root, `level${level}.config`), level < levels ? `[include]\n\tpath = level${level + 1}.config\n` : "");
      appendFileSync(config, `[include]\n\tpath = ${join(root, "level1.config")}\n`);
    };
    chain(5);
    expect((await set.hash()).ok).toBe(true);
    const cases: [string, () => void, RegExp][] = [
      ["missing", () => appendFileSync(config, "[include]\n\tpath = missing.config\n"), /include\.path.*not_found/],
      ["symlink", () => {
        write(join(root, "target.config"), "[core]\n\tpager = less\n");
        symlinkSync(join(root, "target.config"), join(root, "link.config"));
        appendFileSync(config, `[include]\n\tpath = ${join(root, "link.config")}\n`);
      }, /symlink/],
      ["too large", () => {
        write(join(root, "large.config"), `# ${"x".repeat(1024 * 1024)}\n`);
        appendFileSync(config, `[include]\n\tpath = ${join(root, "large.config")}\n`);
      }, /too_large/],
      ["too deep", () => chain(6), /nested more than 5 deep/],
      ["no value", () => {
        // Under a condition that does not match, so git itself never reads it.
        write(join(root, "novalue.config"), "[include]\n\tpath\n");
        appendFileSync(config, `[includeIf "onbranch:nomatch/**"]\n\tpath = ${join(root, "novalue.config")}\n`);
      }, /cannot resolve the path of include\.path/],
      ["home", () => appendFileSync(config, "[include]\n\tpath = ~/home.config\n"), /cannot resolve/],
    ];
    for (const [name, change, message] of cases) {
      writeFileSync(config, before);
      change();
      expect(await set.hash(), name).toMatchObject({ ok: false, error: { message: expect.stringMatching(message) } });
    }
    writeFileSync(config, before);
    expect((await set.hash()).ok).toBe(true);
  });

  it("git config git cannot read makes the hash an error, never absent", SLOW, async () => {
    expect((await set.hash()).ok).toBe(true);
    // Not read by `status` here (no extensions.worktreeConfig), so only the config hash sees it.
    write(join(repo, ".git", "worktrees", "0b9f12ab", "config.worktree"), "[broken");
    expect(await set.hash()).toMatchObject({ ok: false, error: { message: expect.stringMatching(/^cannot read git config/) } });
  });

  it("a hook added and the config changed together, sorted", SLOW, async () => {
    const changes = await changesAfter(() => {
      write(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\n");
      appendFileSync(join(repo, ".git", "config"), "\n[core]\n\tpager = touch pwned\n");
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

  it("git: a commit made in the worktree moves the item branch", SLOW, async () => {
    const changes = await changesAfter(async () => {
      write(join(wt, "src/total.ts"), "export const total = 2;\n");
      await plain(wt, "-c", "commit.gpgsign=false", "commit", "-q", "-am", "an agent's own commit");
    });
    expect(changes).toEqual([{ area: "git", path: "refs/heads/tokama/0b9f12ab", category: "git", change: "modified" }]);
  });

  it("git: a checkout of another branch in the worktree changes its HEAD", SLOW, async () => {
    const changes = await changesAfter(() => plain(wt, "checkout", "-q", "-b", "elsewhere"));
    expect(changes).toEqual([{ area: "git", path: "worktrees/0b9f12ab/HEAD", category: "git", change: "modified" }]);
  });

  it("git: a .gitattributes added at any depth", SLOW, async () => {
    const changes = await changesAfter(() => write(join(wt, "src/.gitattributes"), "*.ts filter=x\n"));
    expect(changes).toEqual([{ area: "worktree", path: "src/.gitattributes", category: "git", change: "added" }]);
  });

  it("git: the worktree's .git file pointed elsewhere makes the hash an error, never a clean compare", SLOW, async () => {
    expect((await set.hash()).ok).toBe(true);
    writeFileSync(join(wt, ".git"), `gitdir: ${join(root, "elsewhere")}\n`);
    const after = await set.hash();
    expect(after).toMatchObject({ ok: false });
    if (!after.ok) expect(after.error.message).toMatch(/status/);
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
    ["package.json", "package"],
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
    ["pnpm-workspace.yaml", "package"],
    [".pnpmfile.cjs", "package"],
    [".pnpmfile.mjs", "package"],
    [".npmrc", "package"],
    [".yarnrc.yml", "package"],
    ["packages/web/package.json", "package"],
    ["vite.config.ts", "test-config"],
    ["app/tests/conftest.py", "test-config"],
    ["packages/web/Vitest.Config.TS", "test-config"],
  ] as const)("new file: %s (%s)", SLOW, async (path, category) => {
    const changes = await changesAfter(() => write(join(wt, path), "x\n"));
    expect(changes).toEqual([{ area: "worktree", path, category, change: "added" }]);
  });

  it("new file: a nested test config hidden by an ignore rule", SLOW, async () => {
    write(join(wt, ".gitignore"), "jest.config.js\n");
    const changes = await changesAfter(() => write(join(wt, "packages/web/jest.config.js"), "module.exports = { testMatch: [] };\n"));
    expect(changes).toEqual([{ area: "worktree", path: "packages/web/jest.config.js", category: "test-config", change: "added" }]);
  });

  it("new file: a root test config hidden by an ignore rule", SLOW, async () => {
    write(join(wt, ".gitignore"), "vitest.config.mts\n");
    const changes = await changesAfter(() => write(join(wt, "vitest.config.mts"), "export default { test: { include: [] } };\n"));
    expect(changes).toEqual([{ area: "worktree", path: "vitest.config.mts", category: "test-config", change: "added" }]);
  });
});

describe("protectedSet", () => {
  it("reports a worktree it cannot read as an error value", SLOW, async () => {
    expect(await protectedSet(git, { repoPath: repo, worktreePath: home, worktreeFolder: ".tokama/wt", baseCommit: "main", branch: "tokama/0b9f12ab" })).toMatchObject({
      ok: false,
    });
  });

  it.each([
    ["depth", { maxDepth: 2, maxEntries: 50_000 }, "a/b/c/d/x.ts"],
    ["entry", { maxDepth: 8, maxEntries: 30 }, "many/f.ts"],
  ] as const)("fails closed when the walk hits its %s limit", SLOW, async (_limit, walkLimits, extra) => {
    const input = { repoPath: repo, worktreePath: wt, worktreeFolder: ".tokama/wt", baseCommit: await plain(repo, "rev-parse", "main"), branch: "tokama/0b9f12ab" };
    const limited = value(await protectedSet(git, { ...input, walkLimits }));
    expect((await limited.hash()).ok).toBe(true);
    if (extra.startsWith("many/")) for (let i = 0; i < 40; i++) write(join(wt, "many", `f${i}.ts`), "x\n");
    else write(join(wt, extra), "x\n");
    const after = await limited.hash();
    expect(after).toMatchObject({ ok: false });
    if (!after.ok) expect(after.error.message).toMatch(/too large or too deep/);
  });

  // Known vector: a regular file is `sha256:` and the SHA-256 hex of its bytes. Recorded baselines
  // carry it, so the format must not change.
  it("hashes a regular file as sha256:<SHA-256 hex of its bytes>", SLOW, async () => {
    write(join(repo, ".git", "hooks", "pre-commit"), "export const total = 1;\n");
    expect(value(await set.hash()).get("git:hooks/pre-commit")?.hash).toBe("sha256:0739219ff1302eacd47db855b5c2e4a0db33ec756c3945074284df2d0b89361f");
  });

  it("names files by area and relative path, never an absolute path", SLOW, async () => {
    const hashes = value(await set.hash());
    expect(hashes.size).toBeGreaterThan(5);
    for (const file of hashes.values()) expect(file.path.startsWith("/")).toBe(false);
  });
});
