import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProcessRunner, type ProcessRunner, type RunRequest, type RunResult } from "../process/index.js";
import {
  DIFF_SAFE,
  GIT_SAFE_CONFIG,
  createGit,
  parseGitVersion,
  parseNumstat,
  parseStatus,
  parseWorktreeList,
  type Git,
} from "./git.js";

// Hardening cases ported from ai-pipeline tests/test_loop_stub.py (commit hooks do not run,
// fsmonitor written into .git/config does not run), plus one case per configured tool the issue
// names. Each case first runs plain git on the same repo and sees the marker file appear (so the
// trap is real), then runs the wrapper and sees no marker. Markers live outside the repo.

const SLOW = { timeout: 20_000 };

let root: string;
let home: string;
let repo: string;
let markers: string;
let git: Git;

/**
 * Plain git for fixtures and unhardened control runs, never through the wrapper. HOME is an empty
 * dir, so the developer's global config (signing, identity) is not read. Resolves to stdout.
 */
async function plain(cwd: string, ...args: string[]): Promise<string> {
  const lines: string[] = [];
  const stderr: string[] = [];
  const runner = createProcessRunner({ parentEnv: { PATH: process.env["PATH"], HOME: home } });
  const result = await runner.run({
    command: { argv: ["git", "-c", "commit.gpgsign=false", ...args] },
    cwd,
    env: { GIT_CONFIG_NOSYSTEM: "1" },
    stdout: { onLine: (line) => lines.push(line) },
    stderr: { onLine: (line) => stderr.push(line) },
  });
  if (result.kind !== "finished" || result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr.join("\n")}`);
  }
  return lines.map((line) => `${line}\n`).join("");
}

/** Plain git that may fail (a control run whose trap makes git exit non-zero still proves the trap ran). */
async function plainMayFail(cwd: string, ...args: string[]): Promise<void> {
  await plain(cwd, ...args).catch(() => undefined);
}

function write(path: string, content: string, mode?: number): void {
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
}

/** An executable script that creates `markers/<name>` and then behaves like `cat`. */
function trap(name: string): string {
  const path = join(markers, `${name}.sh`);
  write(path, `#!/bin/sh\ntouch '${join(markers, name)}'\ncat\n`, 0o755);
  return path;
}

const ran = (name: string) => existsSync(join(markers, name));
const clearMarker = (name: string) => rmSync(join(markers, name), { force: true });

/** Plain git sees the trap fire, then the wrapper call does not. */
async function provesBlocked(name: string, control: () => Promise<unknown>, hardened: () => Promise<unknown>): Promise<void> {
  await control();
  expect(ran(name), `control run should fire ${name}`).toBe(true);
  clearMarker(name);
  await hardened();
  expect(ran(name), `wrapper must not fire ${name}`).toBe(false);
}

function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tokama-git-test-")));
  home = join(root, "home");
  repo = join(root, "repo");
  markers = join(root, "markers");
  for (const dir of [home, repo, markers]) mkdirSync(dir);
  await plain(repo, "init", "-q", "-b", "main");
  await plain(repo, "config", "user.name", "Test");
  await plain(repo, "config", "user.email", "test@example.com");
  write(join(repo, "a.txt"), "one\n");
  await plain(repo, "add", "-A");
  await plain(repo, "commit", "-q", "-m", "seed");
  git = createGit({ runner: createProcessRunner({ parentEnv: { PATH: process.env["PATH"], HOME: home } }) });
}, SLOW.timeout);
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("repo config, hooks and attributes never run code", () => {
  it("core.fsmonitor", SLOW, async () => {
    await plain(repo, "config", "core.fsmonitor", trap("fsmonitor"));
    write(join(repo, "a.txt"), "two\n");
    await provesBlocked(
      "fsmonitor",
      () => plain(repo, "status"),
      async () => {
        value(await git.status(repo));
        value(await git.addAll(repo));
        value(await git.diffCachedNumstat(repo));
        value(await git.commit(repo, "change"));
      },
    );
  });

  it("pre-commit, commit-msg and post-commit hooks", SLOW, async () => {
    for (const hook of ["pre-commit", "commit-msg", "post-commit"]) {
      write(join(repo, ".git", "hooks", hook), `#!/bin/sh\ntouch '${join(markers, "hook")}'\n`, 0o755);
    }
    write(join(repo, "a.txt"), "two\n");
    await plain(repo, "add", "-A");
    await provesBlocked(
      "hook",
      () => plain(repo, "commit", "-q", "-m", "control"),
      async () => {
        write(join(repo, "a.txt"), "three\n");
        value(await git.addAll(repo));
        value(await git.commit(repo, "hardened"));
      },
    );
  });

  it("hooks under a configured core.hooksPath", SLOW, async () => {
    const hooks = join(root, "hooks");
    mkdirSync(hooks);
    write(join(hooks, "pre-commit"), `#!/bin/sh\ntouch '${join(markers, "hookspath")}'\n`, 0o755);
    await plain(repo, "config", "core.hooksPath", hooks);
    write(join(repo, "a.txt"), "two\n");
    await plain(repo, "add", "-A");
    await provesBlocked(
      "hookspath",
      () => plain(repo, "commit", "-q", "-m", "control"),
      async () => {
        write(join(repo, "a.txt"), "three\n");
        value(await git.addAll(repo));
        value(await git.commit(repo, "hardened"));
      },
    );
  });

  it("post-checkout hook on worktree add", SLOW, async () => {
    write(join(repo, ".git", "hooks", "post-checkout"), `#!/bin/sh\ntouch '${join(markers, "checkout")}'\n`, 0o755);
    await provesBlocked(
      "checkout",
      () => plain(repo, "worktree", "add", "-q", "-b", "control", join(root, "wt-control"), "main"),
      async () => value(await git.worktreeAdd(repo, join(root, "wt"), "hardened", "main")),
    );
  });

  it("diff.external", SLOW, async () => {
    await plain(repo, "config", "diff.external", trap("external"));
    write(join(repo, "a.txt"), "two\n");
    await provesBlocked(
      "external",
      () => plainMayFail(repo, "diff"),
      async () => {
        expect(value(await git.diff(repo))).toContain("+two");
        value(await git.addAll(repo));
        expect(value(await git.diff(repo, { cached: true }))).toContain("+two");
      },
    );
  });

  it("diff.<driver>.command chosen by .gitattributes", SLOW, async () => {
    await plain(repo, "config", "diff.evil.command", trap("driver"));
    write(join(repo, ".gitattributes"), "*.txt diff=evil\n");
    write(join(repo, "a.txt"), "two\n");
    await provesBlocked(
      "driver",
      () => plainMayFail(repo, "diff", "--", "a.txt"),
      async () => {
        expect(value(await git.diff(repo))).toContain("+two");
        value(await git.addAll(repo));
        value(await git.diff(repo, { cached: true }));
      },
    );
  });

  it("textconv chosen by .gitattributes", SLOW, async () => {
    await plain(repo, "config", "diff.tc.textconv", trap("textconv"));
    write(join(repo, ".gitattributes"), "*.txt diff=tc\n");
    write(join(repo, "a.txt"), "two\n");
    await provesBlocked(
      "textconv",
      () => plainMayFail(repo, "diff", "--", "a.txt"),
      async () => {
        value(await git.diff(repo));
        value(await git.addAll(repo));
        value(await git.diff(repo, { cached: true }));
        value(await git.diffCachedNumstat(repo));
      },
    );
  });

  it("clean filter chosen by .gitattributes, on add (not required: the call succeeds unfiltered)", SLOW, async () => {
    await plain(repo, "config", "filter.evil.clean", trap("clean"));
    write(join(repo, ".gitattributes"), "* filter=evil\n");
    write(join(repo, "a.txt"), "two\n");
    await provesBlocked(
      "clean",
      () => plain(repo, "add", "-A"),
      async () => {
        write(join(repo, "a.txt"), "three\n");
        value(await git.status(repo));
        value(await git.addAll(repo));
        value(await git.diff(repo));
        value(await git.commit(repo, "hardened"));
      },
    );
    expect(await plain(repo, "show", "HEAD:a.txt")).toBe("three\n");
  });

  it("required process filter chosen by .git/info/attributes, on add", SLOW, async () => {
    await plain(repo, "config", "filter.evil.process", trap("process"));
    await plain(repo, "config", "filter.evil.required", "true");
    write(join(repo, ".git", "info", "attributes"), "* filter=evil\n");
    write(join(repo, "a.txt"), "two\n");
    await provesBlocked(
      "process",
      () => plainMayFail(repo, "add", "-A"),
      async () => {
        // A required driver (e.g. encryption) fails closed: git refuses, nothing is staged.
        const added = await git.addAll(repo);
        expect(added).toMatchObject({ ok: false, error: { reason: "unsafe-config", args: ["add", "-A"] } });
        if (!added.ok) expect(added.error.message).toMatch(/requires filter driver\(s\) "evil"/);
      },
    );
    expect(await plain(repo, "diff", "--cached", "--name-only")).toBe("");
  });

  it("refuses a filter driver with the empty name", SLOW, async () => {
    await plain(repo, "config", "filter..clean", trap("empty"));
    write(join(repo, ".gitattributes"), "* filter=\n");
    write(join(repo, "a.txt"), "two\n");
    await provesBlocked(
      "empty",
      () => plain(repo, "add", "-A"),
      async () => {
        write(join(repo, "a.txt"), "three\n");
        expect(await git.addAll(repo)).toMatchObject({ ok: false, error: { reason: "unsafe-config" } });
      },
    );
  });

  it("diff.submodule=diff does not run a nested repo's diff driver", SLOW, async () => {
    const inner = join(repo, "inner");
    mkdirSync(inner);
    await plain(inner, "init", "-q", "-b", "main");
    await plain(inner, "config", "user.name", "Test");
    await plain(inner, "config", "user.email", "test@example.com");
    write(join(inner, ".gitattributes"), "* diff=evil\n");
    write(join(inner, "f"), "1\n");
    await plain(inner, "add", "-A");
    await plain(inner, "commit", "-q", "-m", "1");
    await plain(inner, "config", "diff.evil.textconv", trap("submodule"));
    await plain(inner, "config", "diff.evil.command", trap("submodule"));
    await plain(repo, "add", "inner");
    await plain(repo, "commit", "-q", "-m", "gitlink");
    write(join(inner, "f"), "2\n");
    await plain(inner, "commit", "-q", "-am", "2");
    await plain(repo, "config", "diff.submodule", "diff");
    await provesBlocked(
      "submodule",
      () => plainMayFail(repo, "diff"),
      async () => {
        expect(value(await git.diff(repo))).toContain("+Subproject commit ");
        await plain(repo, "add", "inner");
        value(await git.diff(repo, { cached: true }));
        value(await git.diffCachedNumstat(repo));
      },
    );
  });

  it("worktree calls use the config the worktree sees (includeIf gitdir)", SLOW, async () => {
    write(join(repo, ".gitattributes"), "* filter=evil\n");
    await plain(repo, "add", "-A");
    await plain(repo, "commit", "-q", "-m", "attributes");
    const included = join(root, "worktrees.cfg");
    write(included, `[filter "evil"]\n\tsmudge = '${trap("wt-smudge")}'\n\tclean = '${trap("wt-clean")}'\n`);
    await plain(repo, "config", "includeIf.gitdir:**/worktrees/**.path", included);
    await provesBlocked(
      "wt-smudge",
      () => plain(repo, "worktree", "add", "-q", "-b", "control", join(root, "wt-control"), "main"),
      async () => value(await git.worktreeAdd(repo, join(root, "wt"), "hardened", "main")),
    );
    const wt = join(root, "wt");
    expect(await plain(wt, "status", "--porcelain")).toBe("");
    write(join(root, "wt-control", "a.txt"), "dirty\n");
    write(join(wt, "a.txt"), "dirty\n");
    await provesBlocked(
      "wt-clean",
      () => plainMayFail(repo, "worktree", "remove", join(root, "wt-control")),
      async () => {
        expect(await git.worktreeRemove(repo, wt)).toMatchObject({ ok: false, error: { reason: "failed" } });
        value(await git.worktreeRemove(repo, wt, { force: true }));
      },
    );
    expect(existsSync(wt)).toBe(false);
  });

  it("worktree remove uses the worktree's config.worktree", SLOW, async () => {
    await plain(repo, "config", "extensions.worktreeConfig", "true");
    write(join(repo, ".gitattributes"), "* filter=evil\n");
    await plain(repo, "add", "-A");
    await plain(repo, "commit", "-q", "-m", "attributes");
    const wt = join(root, "wt");
    value(await git.worktreeAdd(repo, wt, "hardened", "main"));
    await plain(wt, "config", "--worktree", "filter.evil.clean", trap("wt-config"));
    write(join(wt, "a.txt"), "dirty\n");
    await provesBlocked(
      "wt-config",
      () => plainMayFail(repo, "worktree", "remove", wt),
      async () => {
        expect(await git.worktreeRemove(repo, wt)).toMatchObject({ ok: false, error: { reason: "failed" } });
        value(await git.worktreeRemove(repo, wt, { force: true }));
      },
    );
  });

  it("smudge filter on worktree add", SLOW, async () => {
    write(join(repo, ".gitattributes"), "* filter=evil\n");
    await plain(repo, "add", "-A");
    await plain(repo, "commit", "-q", "-m", "attributes");
    await plain(repo, "config", "filter.evil.smudge", trap("smudge"));
    await provesBlocked(
      "smudge",
      () => plain(repo, "worktree", "add", "-q", "-b", "control", join(root, "wt-control"), "main"),
      async () => value(await git.worktreeAdd(repo, join(root, "wt"), "hardened", "main")),
    );
  });

  it("a filter driver from an included config file", SLOW, async () => {
    const included = join(root, "included.cfg");
    write(included, `[filter "inc"]\n\tclean = '${trap("include")}'\n`);
    await plain(repo, "config", "include.path", included);
    write(join(repo, ".gitattributes"), "* filter=inc\n");
    write(join(repo, "a.txt"), "two\n");
    await provesBlocked(
      "include",
      () => plain(repo, "add", "-A"),
      async () => {
        write(join(repo, "a.txt"), "three\n");
        value(await git.addAll(repo));
      },
    );
  });

  it("refuses to run when a repo filter name cannot be disabled", SLOW, async () => {
    write(join(repo, ".git", "config"), `[filter "a=b"]\n\tclean = '${trap("unsafe")}'\n`);
    write(join(repo, ".gitattributes"), "* filter=a=b\n");
    write(join(repo, "a.txt"), "two\n");
    const result = await git.addAll(repo);
    expect(result).toMatchObject({ ok: false, error: { reason: "unsafe-config", args: ["add", "-A"] } });
    expect(ran("unsafe")).toBe(false);
  });

  it("no lazy fetch through the remote config of a partial clone", SLOW, async () => {
    await plain(repo, "config", "uploadpack.allowFilter", "true");
    const clone = join(root, "clone");
    await plain(root, "clone", "-q", "--filter=blob:none", "--no-checkout", `file://${repo}`, clone);
    // Not the `cat` trap: the fetch would wait on its stdin.
    write(join(markers, "fetch.sh"), `#!/bin/sh\ntouch '${join(markers, "fetch")}'\nexit 1\n`, 0o755);
    await plain(clone, "config", "remote.origin.uploadpack", join(markers, "fetch.sh"));
    let result: unknown;
    await provesBlocked(
      "fetch",
      () => plainMayFail(clone, "worktree", "add", "-q", "-b", "control", join(root, "wt-control"), "main"),
      async () => (result = await git.worktreeAdd(clone, join(root, "wt"), "hardened", "main")),
    );
    // The blob is missing and may not be fetched, so the checkout fails as a value.
    expect(result).toMatchObject({ ok: false, error: { reason: "failed" } });
  });

  // These tools run only on a terminal (pager), on network calls (ssh, credentials, askpass) or
  // for an interactive message (editor). None of the wrapper's calls on a full local repo should
  // reach them (a partial clone is the case above), so there is no control run: this checks that
  // none of them fires, not that the flags stop them.
  it("core.pager, core.sshCommand, credential.helper, core.askPass and core.editor never fire", SLOW, async () => {
    await plain(repo, "config", "core.pager", trap("pager"));
    await plain(repo, "config", "core.sshCommand", trap("ssh"));
    await plain(repo, "config", "credential.helper", `!'${trap("credential")}'`);
    await plain(repo, "config", "core.askPass", trap("askpass"));
    await plain(repo, "config", "core.editor", trap("editor"));
    write(join(repo, "a.txt"), "two\n");
    value(await git.status(repo));
    value(await git.diff(repo));
    value(await git.addAll(repo));
    value(await git.diffCachedNumstat(repo));
    value(await git.writeTree(repo));
    value(await git.commit(repo, "change"));
    value(await git.worktreeAdd(repo, join(root, "wt"), "wt", "main"));
    value(await git.worktreeList(repo));
    value(await git.worktreeRemove(repo, join(root, "wt")));
    for (const name of ["pager", "ssh", "credential", "askpass", "editor"]) expect(ran(name), name).toBe(false);
  });

  it("keeps filter drivers from the user's global config", SLOW, async () => {
    // A user-level driver (e.g. git-lfs) is the user's own choice, not repo content.
    write(join(home, ".gitconfig"), "[filter \"upper\"]\n\tclean = tr a-z A-Z\n");
    write(join(repo, ".gitattributes"), "*.txt filter=upper\n");
    write(join(repo, "a.txt"), "two\n");
    value(await git.addAll(repo));
    expect(await plain(repo, "show", ":a.txt")).toBe("TWO\n");
  });
});

describe("API on a real repo", () => {
  it("status lists changes, untracked files and renames", SLOW, async () => {
    expect(value(await git.status(repo))).toEqual([]);
    write(join(repo, "a.txt"), "two\n");
    mkdirSync(join(repo, "dir"));
    write(join(repo, "dir", "new file.txt"), "x\n");
    expect(value(await git.status(repo))).toEqual([
      { index: " ", worktree: "M", path: "a.txt" },
      { index: "?", worktree: "?", path: "dir/new file.txt" },
    ]);
    await plain(repo, "mv", "a.txt", "b.txt");
    expect(value(await git.status(repo))).toContainEqual({ index: "R", worktree: "M", path: "b.txt", origPath: "a.txt" });
  });

  it("addAll, numstat, diff, writeTree and commit", SLOW, async () => {
    write(join(repo, "a.txt"), "two\nthree\n");
    write(join(repo, "bin.dat"), Buffer.from([0, 1, 2, 0]).toString("binary"));
    value(await git.addAll(repo));
    expect(value(await git.diffCachedNumstat(repo))).toEqual([
      { path: "a.txt", added: 2, removed: 1 },
      { path: "bin.dat", added: null, removed: null },
    ]);
    expect(value(await git.diff(repo))).toBe("");
    expect(value(await git.diff(repo, { cached: true }))).toContain("-one\n+two\n+three\n");
    const tree = value(await git.writeTree(repo));
    expect(tree).toMatch(/^[0-9a-f]{40,64}$/);
    const commit = value(await git.commit(repo, "--message that looks like an option"));
    expect(commit).toBe((await plain(repo, "rev-parse", "HEAD")).trim());
    expect(value(await git.revParse(repo, "HEAD^{tree}"))).toBe(tree);
    expect(await plain(repo, "log", "-1", "--format=%s")).toBe("--message that looks like an option\n");
  });

  it("worktree add, list and remove", SLOW, async () => {
    const path = join(root, "wt");
    value(await git.worktreeAdd(repo, path, "feature", "main"));
    const head = value(await git.revParse(repo, "main"));
    expect(value(await git.worktreeList(repo))).toEqual([
      { path: repo, head, branch: "refs/heads/main", detached: false, bare: false },
      { path, head, branch: "refs/heads/feature", detached: false, bare: false },
    ]);
    write(join(path, "a.txt"), "dirty\n");
    expect(await git.worktreeRemove(repo, path)).toMatchObject({ ok: false, error: { reason: "failed" } });
    value(await git.worktreeRemove(repo, path, { force: true }));
    expect(value(await git.worktreeList(repo))).toHaveLength(1);
    expect(existsSync(path)).toBe(false);
  });

  it("cleanIgnored removes ignored files at the top of a linked worktree only", SLOW, async () => {
    write(join(repo, ".gitignore"), "node_modules/\n*.log\n");
    await plain(repo, "add", "-A");
    await plain(repo, "commit", "-q", "-m", "ignore");
    const path = join(root, "wt");
    value(await git.worktreeAdd(repo, path, "feature", "main"));
    mkdirSync(join(path, "node_modules", ".bin"), { recursive: true });
    write(join(path, "node_modules", ".bin", "vitest"), "#!/bin/sh\nexit 0\n", 0o755);
    write(join(path, "debug.log"), "x\n");
    write(join(path, "new.txt"), "untracked, not ignored\n");
    write(join(path, "a.txt"), "changed\n");
    value(await git.cleanIgnored(path));
    expect(existsSync(join(path, "node_modules"))).toBe(false);
    expect(existsSync(join(path, "debug.log"))).toBe(false);
    expect(readFileSync(join(path, "new.txt"), "utf8")).toBe("untracked, not ignored\n");
    expect(readFileSync(join(path, "a.txt"), "utf8")).toBe("changed\n");

    // The main worktree, a subfolder, and a worktree whose .git file is gone are all refused.
    write(join(repo, "main.log"), "x\n");
    expect(await git.cleanIgnored(repo)).toMatchObject({ ok: false, error: { reason: "invalid-argument" } });
    mkdirSync(join(path, "sub"));
    expect(await git.cleanIgnored(join(path, "sub"))).toMatchObject({ ok: false, error: { reason: "invalid-argument" } });
    const inside = join(repo, "inner");
    value(await git.worktreeAdd(repo, inside, "inner", "main"));
    rmSync(join(inside, ".git"));
    expect(await git.cleanIgnored(inside)).toMatchObject({ ok: false, error: { reason: "invalid-argument" } });
    expect(existsSync(join(repo, "main.log"))).toBe(true);
  });

  it("diffTreeRaw lists changed paths with blob ids; diffTrees shows the text diff between two trees", SLOW, async () => {
    const base = value(await git.revParse(repo, "HEAD^{tree}"));
    write(join(repo, "a.txt"), "two\n");
    write(join(repo, "new file.txt"), "x\n");
    value(await git.addAll(repo));
    const tree = value(await git.writeTree(repo));
    const blob = (await plain(repo, "rev-parse", ":a.txt")).trim();
    expect(value(await git.diffTreeRaw(repo, base, tree))).toEqual([
      { path: "a.txt", status: "M", oldMode: "100644", newMode: "100644", oldBlob: expect.stringMatching(/^[0-9a-f]{40,64}$/), newBlob: blob },
      { path: "new file.txt", status: "A", oldMode: "000000", newMode: "100644", oldBlob: null, newBlob: expect.stringMatching(/^[0-9a-f]{40,64}$/) },
    ]);
    expect(value(await git.diffTrees(repo, base, tree))).toContain("-one\n+two\n");
    expect(await git.diffTreeRaw(repo, "--output=x", tree)).toMatchObject({ ok: false, error: { reason: "invalid-argument" } });
  });

  it("configList: one file's entries in file order, valueless keys alone, no includes", SLOW, async () => {
    const file = join(root, "listed.config");
    write(join(root, "included.config"), "[core]\n\tpager = less\n");
    write(file, `[core]\n\tHooksPath = hooks\n[alias]\n\tflag\n[include]\n\tpath = ${join(root, "included.config")}\n[core]\n\thooksPath = other\n`);
    expect(value(await git.configList(file))).toEqual(["core.hookspath\nhooks", "alias.flag", `include.path\n${join(root, "included.config")}`, "core.hookspath\nother"]);
    expect(await git.configList(join(root, "missing.config"))).toMatchObject({ ok: false, error: { reason: "failed" } });
    write(join(root, "bad.config"), "[broken");
    expect(await git.configList(join(root, "bad.config"))).toMatchObject({ ok: false, error: { reason: "failed" } });
    expect(await git.configList("listed.config")).toMatchObject({ ok: false, error: { reason: "invalid-argument" } });
  });

  it("branchDelete, lsTree and gitDirs", SLOW, async () => {
    mkdirSync(join(repo, "dir"));
    write(join(repo, "dir", "b c.txt"), "x\n");
    await plain(repo, "add", "-A");
    await plain(repo, "commit", "-q", "-m", "second");
    const path = join(root, "wt");
    value(await git.worktreeAdd(repo, path, "feature", "main"));
    expect(value(await git.lsTree(path, "HEAD"))).toEqual(["a.txt", "dir/b c.txt"]);
    // --full-tree: the whole tree from a subfolder too.
    expect(value(await git.lsTree(join(path, "dir"), "HEAD"))).toEqual(["a.txt", "dir/b c.txt"]);

    const commonDir = join(repo, ".git");
    expect(value(await git.gitDirs(repo))).toEqual({ gitDir: commonDir, commonDir });
    expect(value(await git.gitDirs(path))).toEqual({ gitDir: join(commonDir, "worktrees", "wt"), commonDir });

    expect(await git.branchDelete(repo, "feature")).toMatchObject({ ok: false, error: { reason: "failed" } });
    value(await git.worktreeRemove(repo, path));
    value(await git.branchDelete(repo, "feature"));
    expect(await git.revParse(repo, "feature")).toMatchObject({ ok: false });
  });

  it("commitTree and updateRef commit an exact tree and move a ref only from its expected value", SLOW, async () => {
    const base = value(await git.revParse(repo, "HEAD"));
    write(join(repo, "a.txt"), "staged\n");
    value(await git.addAll(repo));
    const tree = value(await git.writeTree(repo));
    write(join(repo, "a.txt"), "written after the tree\n");
    const commit = value(await git.commitTree(repo, tree, base, "exact tree\n\nTrailer: x"));
    expect(value(await git.revParse(repo, `${commit}^{tree}`))).toBe(tree);
    expect(value(await git.revParse(repo, "HEAD"))).toBe(base);
    expect(await git.updateRef(repo, "refs/heads/main", commit, commit)).toMatchObject({ ok: false, error: { reason: "failed" } });
    value(await git.updateRef(repo, "refs/heads/main", commit, base));
    expect(value(await git.revParse(repo, "main"))).toBe(commit);
    expect(await plain(repo, "show", "main:a.txt")).toBe("staged\n");
    expect(await git.updateRef(repo, "HEAD", commit, commit)).toMatchObject({ ok: false, error: { reason: "invalid-argument" } });
    expect(await git.commitTree(repo, "--help", base, "m")).toMatchObject({ ok: false, error: { reason: "invalid-argument" } });
  });

  it("currentRef, isAncestor and mergeTree read refs and merge in the object store only", SLOW, async () => {
    const base = value(await git.revParse(repo, "HEAD"));
    expect(value(await git.currentRef(repo))).toBe("refs/heads/main");
    await plain(repo, "switch", "-q", "-c", "side");
    write(join(repo, "side.txt"), "side\n");
    await plain(repo, "add", "side.txt");
    await plain(repo, "commit", "-q", "-m", "side");
    const side = value(await git.revParse(repo, "HEAD"));
    await plain(repo, "switch", "-q", "main");
    write(join(repo, "main.txt"), "main\n");
    await plain(repo, "add", "main.txt");
    await plain(repo, "commit", "-q", "-m", "main");
    const main = value(await git.revParse(repo, "HEAD"));
    expect(value(await git.isAncestor(repo, base, side))).toBe(true);
    expect(value(await git.isAncestor(repo, side, main))).toBe(false);

    const clean = value(await git.mergeTree(repo, main, side));
    if (!clean.clean) throw new Error("expected a clean merge");
    const merge = value(await git.commitTree(repo, clean.tree, [main, side], "merge"));
    expect(await plain(repo, "rev-list", "--parents", "-n", "1", merge)).toBe(`${merge} ${main} ${side}\n`);
    expect(value(await git.revParse(repo, "HEAD"))).toBe(main);
    expect(await plain(repo, "status", "--porcelain")).toBe("");

    await plain(repo, "switch", "-q", "-c", "other", base);
    write(join(repo, "main.txt"), "other\n");
    await plain(repo, "add", "main.txt");
    await plain(repo, "commit", "-q", "-m", "other");
    const other = value(await git.revParse(repo, "HEAD"));
    expect(value(await git.mergeTree(repo, main, other))).toEqual({ clean: false, conflicts: ["main.txt"] });
    expect(await git.mergeTree(repo, main, "nosuchrev")).toMatchObject({ ok: false, error: { reason: "failed" } });
    expect(await git.mergeTree(repo, main, "--help")).toMatchObject({ ok: false, error: { reason: "invalid-argument" } });

    await plain(repo, "switch", "-q", "--detach", main);
    expect(value(await git.currentRef(repo))).toBeUndefined();
  });

  it("a merge driver the repo configures never runs: merge-tree reports the file as conflicted", SLOW, async () => {
    write(join(repo, ".gitattributes"), "a.txt merge=evil\n");
    write(join(repo, "a.txt"), "1\n2\n3\n");
    await plain(repo, "add", "-A");
    await plain(repo, "commit", "-q", "-m", "base");
    const base = value(await git.revParse(repo, "HEAD"));
    write(join(repo, "a.txt"), "1\n2\nmain\n");
    await plain(repo, "commit", "-q", "-am", "main");
    const main = value(await git.revParse(repo, "HEAD"));
    await plain(repo, "switch", "-q", "-c", "other", base);
    write(join(repo, "a.txt"), "other\n2\n3\n");
    await plain(repo, "commit", "-q", "-am", "other");
    const other = value(await git.revParse(repo, "HEAD"));
    await plain(repo, "config", "merge.evil.driver", `${trap("merge-driver")} %O %A %B`);
    await plain(repo, "config", "merge.ff", "true");
    await provesBlocked(
      "merge-driver",
      () => plainMayFail(repo, "merge-tree", "--write-tree", main, other),
      async () => expect(value(await git.mergeTree(repo, main, other))).toEqual({ clean: false, conflicts: ["a.txt"] }),
    );
  });

  it("mergeFastForward moves the checkout forward, runs no hook, and refuses what is not a fast-forward", SLOW, async () => {
    const base = value(await git.revParse(repo, "HEAD"));
    await plain(repo, "switch", "-q", "-c", "ahead");
    write(join(repo, "ahead.txt"), "ahead\n");
    await plain(repo, "add", "ahead.txt");
    await plain(repo, "commit", "-q", "-m", "ahead");
    const ahead = value(await git.revParse(repo, "HEAD"));
    await plain(repo, "switch", "-q", "main");
    write(join(repo, ".git", "hooks", "post-merge"), `#!/bin/sh\ntouch '${join(markers, "post-merge")}'\n`, 0o755);
    value(await git.mergeFastForward(repo, ahead));
    expect(ran("post-merge")).toBe(false);
    expect(value(await git.revParse(repo, "main"))).toBe(ahead);
    expect(readFileSync(join(repo, "ahead.txt"), "utf8")).toBe("ahead\n");
    await plain(repo, "switch", "-q", "-c", "behind", base);
    write(join(repo, "behind.txt"), "x\n");
    await plain(repo, "add", "behind.txt");
    await plain(repo, "commit", "-q", "-m", "behind");
    expect(await git.mergeFastForward(repo, ahead)).toMatchObject({ ok: false, error: { reason: "failed" } });
  });

  it("remotePushUrl reads the configured URL before insteadOf; push sends a commit to a branch, with no hook", SLOW, async () => {
    expect(value(await git.remotePushUrls(repo, "origin"))).toEqual([]);
    const bare = join(root, "remote.git");
    await plain(root, "init", "-q", "--bare", bare);
    await plain(repo, "remote", "add", "origin", "https://github.com/acme/orders-api.git");
    await plain(repo, "config", `url.${bare}.insteadOf`, "https://github.com/acme/orders-api.git");
    expect(value(await git.remotePushUrls(repo, "origin"))).toEqual(["https://github.com/acme/orders-api.git"]);
    expect(value(await git.remoteResolvedPushUrl(repo, "origin"))).toBe(bare);
    // Every pushurl, which replaces the url for pushes.
    await plain(repo, "config", "--add", "remote.origin.pushurl", "https://a.example/x.git");
    await plain(repo, "config", "--add", "remote.origin.pushurl", "https://github.com/acme/orders-api.git");
    expect(value(await git.remotePushUrls(repo, "origin"))).toEqual(["https://a.example/x.git", "https://github.com/acme/orders-api.git"]);
    await plain(repo, "config", "--unset-all", "remote.origin.pushurl");
    write(join(repo, ".git", "hooks", "pre-push"), `#!/bin/sh\ntouch '${join(markers, "pre-push")}'\n`, 0o755);
    const head = value(await git.revParse(repo, "HEAD"));
    value(await git.push(repo, "https://github.com/acme/orders-api.git", head, "tokama/0000000a"));
    expect(ran("pre-push")).toBe(false);
    expect(await plain(bare, "rev-parse", "refs/heads/tokama/0000000a")).toBe(`${head}\n`);
    expect(await git.push(repo, "origin", "main", "x")).toMatchObject({ ok: false, error: { reason: "invalid-argument" } });
  });

  it("worktreePrune drops an entry whose folder is gone", SLOW, async () => {
    const path = join(root, "wt");
    value(await git.worktreeAdd(repo, path, "feature", "main"));
    rmSync(path, { recursive: true, force: true });
    expect(value(await git.worktreeList(repo))).toHaveLength(2);
    value(await git.worktreePrune(repo));
    expect(value(await git.worktreeList(repo))).toHaveLength(1);
  });

  it("returns git failures as values", SLOW, async () => {
    const missing = await git.revParse(repo, "no-such-branch");
    expect(missing).toMatchObject({ ok: false, error: { reason: "failed", exitCode: 128, args: ["rev-parse", "--verify", "no-such-branch"] } });
    const notRepo = await git.status(home);
    expect(notRepo).toMatchObject({ ok: false, error: { reason: "failed" } });
    if (!notRepo.ok) expect(notRepo.error.message).toMatch(/not a git repository/);
    const noCommit = await git.commit(repo, "nothing staged");
    expect(noCommit).toMatchObject({ ok: false, error: { reason: "failed", exitCode: 1 } });
    if (!noCommit.ok) expect(noCommit.error.message).toMatch(/nothing to commit/);
  });

  it("filter lookup errors carry the caller's args", SLOW, async () => {
    write(join(repo, ".git", "config"), "[broken\n");
    const status = await git.status(repo);
    expect(status).toMatchObject({
      ok: false,
      error: { reason: "failed", args: ["status", "--porcelain", "-z", "--untracked-files=all"] },
    });
  });

  it("checkGitVersion accepts the installed git", SLOW, async () => {
    expect(value(await git.checkGitVersion())).toMatch(/^git version /);
  });

  it("refuses arguments git would read as options", SLOW, async () => {
    expect(await git.revParse(repo, "--output=x")).toMatchObject({ ok: false, error: { reason: "invalid-argument" } });
    expect(await git.worktreeAdd(repo, "--force", "b", "main")).toMatchObject({ ok: false, error: { reason: "invalid-argument" } });
    expect(await git.worktreeAdd(repo, join(root, "wt"), "-b", "main")).toMatchObject({ ok: false, error: { reason: "invalid-argument" } });
    expect(await git.worktreeAdd(repo, join(root, "wt"), "b", "")).toMatchObject({ ok: false, error: { reason: "invalid-argument" } });
    expect(await git.worktreeRemove(repo, "-f")).toMatchObject({ ok: false, error: { reason: "invalid-argument" } });
    expect(await git.branchDelete(repo, "-r")).toMatchObject({ ok: false, error: { reason: "invalid-argument" } });
    expect(await git.lsTree(repo, "--abbrev")).toMatchObject({ ok: false, error: { reason: "invalid-argument" } });
  });

  it("reports a git binary that does not start", SLOW, async () => {
    const broken = createGit({ runner: createProcessRunner(), gitPath: join(root, "no-such-git") });
    expect(await broken.status(repo)).toMatchObject({ ok: false, error: { reason: "spawn-error" } });
  });
});

describe("how git is called", () => {
  /** A runner that records each request and answers with `answer`. */
  function recordingRunner(answer: Partial<RunResult> = {}): { runner: ProcessRunner; requests: RunRequest[] } {
    const requests: RunRequest[] = [];
    const finished: RunResult = {
      kind: "finished",
      pid: 1,
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      startedAt: 0,
      endedAt: 0,
      durationMs: 0,
    };
    return {
      requests,
      runner: {
        run: (request) => {
          requests.push(request);
          if (request.stdout?.file !== undefined) writeFileSync(request.stdout.file, "");
          return Promise.resolve({ ...finished, ...answer } as RunResult);
        },
      },
    };
  }
  const argvOf = (request: RunRequest | undefined) => {
    if (request === undefined || !("argv" in request.command)) throw new Error("expected an argv command");
    return request.command.argv;
  };

  it("uses argv (never a shell), the safe config, and the git env", async () => {
    const { runner, requests } = recordingRunner();
    const stub = createGit({ runner, timeoutMs: 5_000 });
    await stub.diff("/repo", { cached: true });
    await stub.commit("/repo", "msg");
    for (const request of requests) {
      const argv = argvOf(request);
      expect(argv.slice(0, 2)).toEqual(["git", "--no-pager"]);
      expect(argv.slice(2, 2 + GIT_SAFE_CONFIG.length * 2)).toEqual(GIT_SAFE_CONFIG.flatMap((s) => ["-c", s]));
      expect(request.env).toEqual({ GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" });
      expect(request.timeoutMs).toBe(5_000);
      expect(request.cwd).toBe("/repo");
    }
    const commands = requests.map((request) => argvOf(request).slice(2 + GIT_SAFE_CONFIG.length * 2));
    // Each call first lists the repo's filter drivers.
    expect(commands.filter((args) => args[0] === "config")).toHaveLength(3);
    expect(commands).toContainEqual(["diff", "--cached", ...DIFF_SAFE]);
    expect(commands).toContainEqual(["commit", "-q", "--no-verify", "-m", "msg"]);
    expect(GIT_SAFE_CONFIG).toEqual(
      expect.arrayContaining([
        "core.fsmonitor=false",
        "core.hooksPath=/dev/null",
        "diff.external=",
        "core.pager=cat",
        "commit.gpgsign=false",
        "tag.gpgsign=false",
      ]),
    );
  });

  it("gives SSH_AUTH_SOCK to a push only, when asked", async () => {
    const { runner, requests } = recordingRunner();
    const stub = createGit({ runner });
    await stub.push("/repo", "origin", "a".repeat(40), "tokama/0000000a", { sshAuthSock: "/tmp/agent.sock" });
    const push = requests.find((request) => argvOf(request).includes("push"));
    expect(push?.env).toMatchObject({ SSH_AUTH_SOCK: "/tmp/agent.sock" });
    expect(argvOf(push).slice(-5)).toEqual(["push", "--no-verify", "--porcelain", "origin", `${"a".repeat(40)}:refs/heads/tokama/0000000a`]);
    // The filter lookup before it, and any push not asked to, never get the socket.
    expect(requests.filter((request) => request !== push).every((request) => !("SSH_AUTH_SOCK" in (request.env ?? {})))).toBe(true);
    requests.length = 0;
    await stub.push("/repo", "origin", "a".repeat(40), "tokama/0000000a");
    expect(requests.every((request) => !("SSH_AUTH_SOCK" in (request.env ?? {})))).toBe(true);
  });

  it("checkGitVersion refuses git older than 2.44", async () => {
    const runner: ProcessRunner = {
      run: (request) => {
        if (request.stdout?.file !== undefined) writeFileSync(request.stdout.file, "git version 2.43.0\n");
        return Promise.resolve({ kind: "finished", pid: 1, exitCode: 0, signal: null, timedOut: false, aborted: false, startedAt: 0, endedAt: 0, durationMs: 0 });
      },
    };
    const result = await createGit({ runner }).checkGitVersion();
    expect(result).toMatchObject({ ok: false, error: { reason: "unsupported-version" } });
    if (!result.ok) expect(result.error.message).toMatch(/2\.44 or newer.*2\.43\.0/);
  });

  it("maps a timeout to an error value", async () => {
    const { runner } = recordingRunner({ exitCode: null, signal: "SIGTERM", timedOut: true });
    expect(await createGit({ runner }).writeTree("/repo")).toMatchObject({ ok: false, error: { reason: "timed-out" } });
  });
});

describe("parsers", () => {
  it("parseStatus reads renames and paths with spaces", () => {
    expect(parseStatus("R  new name\0old name\0?? x y\0 M a\0")).toEqual([
      { index: "R", worktree: " ", path: "new name", origPath: "old name" },
      { index: "?", worktree: "?", path: "x y" },
      { index: " ", worktree: "M", path: "a" },
    ]);
    expect(parseStatus(" R new\0old\0C  copy\0src\0")).toEqual([
      { index: " ", worktree: "R", path: "new", origPath: "old" },
      { index: "C", worktree: " ", path: "copy", origPath: "src" },
    ]);
    expect(parseStatus("")).toEqual([]);
  });

  it("parseNumstat reads binary files and paths with tabs", () => {
    expect(parseNumstat("1\t2\ta\0-\t-\tb\tc\0")).toEqual([
      { path: "a", added: 1, removed: 2 },
      { path: "b\tc", added: null, removed: null },
    ]);
  });

  it("parseGitVersion reads release and vendor version strings", () => {
    expect(parseGitVersion("git version 2.54.0 (Apple Git-157)\n")).toEqual({ major: 2, minor: 54 });
    expect(parseGitVersion("git version 2.43.0.windows.1")).toEqual({ major: 2, minor: 43 });
    expect(parseGitVersion("git version 3.0.0-rc1")).toEqual({ major: 3, minor: 0 });
    expect(parseGitVersion("not git")).toBeUndefined();
  });

  it("parseWorktreeList reads bare, detached and branch entries", () => {
    expect(
      parseWorktreeList("worktree /r\0bare\0\0worktree /a\0HEAD abc\0detached\0\0worktree /b\0HEAD def\0branch refs/heads/x\0locked\0\0"),
    ).toEqual([
      { path: "/r", detached: false, bare: true },
      { path: "/a", head: "abc", detached: true, bare: false },
      { path: "/b", head: "def", branch: "refs/heads/x", detached: false, bare: false },
    ]);
  });
});
