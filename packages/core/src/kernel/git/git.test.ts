import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProcessRunner, type ProcessRunner, type RunRequest, type RunResult } from "../process/index.js";
import { DIFF_SAFE, GIT_SAFE_CONFIG, createGit, parseNumstat, parseStatus, parseWorktreeList, type Git } from "./git.js";

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

  it("clean filter chosen by .gitattributes, on add", SLOW, async () => {
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
        value(await git.addAll(repo));
        value(await git.status(repo));
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

  // These tools run only on a terminal (pager), on network calls (ssh, credentials, askpass) or
  // for an interactive message (editor). None of the wrapper's calls should reach them, so there
  // is no control run: this checks that none of them fires, not that the flags stop them.
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

  it("returns git failures as values", SLOW, async () => {
    const missing = await git.revParse(repo, "no-such-branch");
    expect(missing).toMatchObject({ ok: false, error: { reason: "failed", exitCode: 128, args: ["rev-parse", "--verify", "no-such-branch"] } });
    const notRepo = await git.status(home);
    expect(notRepo).toMatchObject({ ok: false, error: { reason: "failed" } });
    if (!notRepo.ok) expect(notRepo.error.message).toMatch(/not a git repository/);
    const noCommit = await git.commit(repo, "nothing staged");
    expect(noCommit).toMatchObject({ ok: false, error: { reason: "failed", exitCode: 1 } });
  });

  it("refuses arguments git would read as options", SLOW, async () => {
    expect(await git.revParse(repo, "--output=x")).toMatchObject({ ok: false, error: { reason: "invalid-argument" } });
    expect(await git.worktreeAdd(repo, "--force", "b", "main")).toMatchObject({ ok: false, error: { reason: "invalid-argument" } });
    expect(await git.worktreeAdd(repo, join(root, "wt"), "-b", "main")).toMatchObject({ ok: false, error: { reason: "invalid-argument" } });
    expect(await git.worktreeAdd(repo, join(root, "wt"), "b", "")).toMatchObject({ ok: false, error: { reason: "invalid-argument" } });
    expect(await git.worktreeRemove(repo, "-f")).toMatchObject({ ok: false, error: { reason: "invalid-argument" } });
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

  it("uses argv (never a shell), the safe config, and GIT_TERMINAL_PROMPT=0", async () => {
    const { runner, requests } = recordingRunner();
    const stub = createGit({ runner, timeoutMs: 5_000 });
    await stub.diff("/repo", { cached: true });
    await stub.commit("/repo", "msg");
    for (const request of requests) {
      const argv = argvOf(request);
      expect(argv.slice(0, 2)).toEqual(["git", "--no-pager"]);
      expect(argv.slice(2, 2 + GIT_SAFE_CONFIG.length * 2)).toEqual(GIT_SAFE_CONFIG.flatMap((s) => ["-c", s]));
      expect(request.env).toEqual({ GIT_TERMINAL_PROMPT: "0" });
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
    expect(parseStatus("")).toEqual([]);
  });

  it("parseNumstat reads binary files and paths with tabs", () => {
    expect(parseNumstat("1\t2\ta\0-\t-\tb\tc\0")).toEqual([
      { path: "a", added: 1, removed: 2 },
      { path: "b\tc", added: null, removed: null },
    ]);
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
