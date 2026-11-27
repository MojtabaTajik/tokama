// Try checks against a real temp repo, real git and real shell commands. Nothing outside the temp
// folder is touched.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { systemClock } from "../../kernel/clock/index.js";
import { createGit, type Git } from "../../kernel/git/index.js";
import { createProcessRunner } from "../../kernel/process/index.js";
import { ok } from "../../kernel/result/index.js";
import type { CheckTrial } from "../../kernel/schemas/index.js";
import type { WorktreeRepo } from "../worktrees/index.js";
import { checkLimitMinutes, createCheckTrialRunner, tidyOutput, trialCommandProblem, type CheckTrialHooks, type CheckTrialRequest } from "./check-trial.js";

const SLOW = { timeout: 30_000 };

let root: string;
let home: string;
let outside: string;
let repo: WorktreeRepo;
let git: Git;
let resolved: string[];

async function plain(cwd: string, ...args: string[]): Promise<string> {
  const out: string[] = [];
  const runner = createProcessRunner({ parentEnv: { PATH: process.env["PATH"], HOME: home } });
  const result = await runner.run({ command: { argv: ["git", ...args] }, cwd, env: { GIT_CONFIG_NOSYSTEM: "1" }, stdout: { onLine: (line) => out.push(line) } });
  if (result.kind !== "finished" || result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return out.join("\n");
}

const runner = () =>
  createCheckTrialRunner({
    git,
    runner: createProcessRunner({ parentEnv: { PATH: process.env["PATH"], HOME: home } }),
    clock: systemClock,
    resolveRepo: async (path) => {
      resolved.push(path);
      return ok(repo);
    },
    folders: [[home, "~/.tokama"]],
    // A "minute" of 50 ms: a check's smallest limit (2 minutes) is 100 ms.
    minuteMs: 50,
  });

interface Seen {
  readonly updates: CheckTrial[];
  readonly pids: number[];
  readonly planned: { repoPath: string; worktreePath: string; existed: boolean }[];
  readonly hooks: CheckTrialHooks;
}
function hooks(): Seen {
  const updates: CheckTrial[] = [];
  const pids: number[] = [];
  const planned: Seen["planned"] = [];
  return {
    updates,
    pids,
    planned,
    hooks: {
      onUpdate: (trial) => updates.push(trial),
      onPlanned: (value) => planned.push({ ...value, existed: existsSync(value.worktreePath) }),
      onProcess: (pid) => pids.push(pid),
    },
  };
}

async function trial(request: Partial<CheckTrialRequest> & Pick<CheckTrialRequest, "checks">, signal = new AbortController().signal) {
  const trials = runner();
  const prepared = await trials.prepare({ path: repo.path, ...request });
  if (!prepared.ok) throw new Error(`prepare refused: ${prepared.error.message}`);
  const seen = hooks();
  await trials.run(prepared.value, seen.hooks, signal);
  return { ...seen, last: seen.updates.at(-1)!, commit: prepared.value.commit };
}

const worktrees = async () => (await git.worktreeList(repo.path)).ok;
const listed = async () => {
  const entries = await git.worktreeList(repo.path);
  if (!entries.ok) throw new Error("list failed");
  return entries.value.map((entry) => entry.path);
};

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tokama-trial-run-")));
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
  repo = { path, baseBranch: "main", worktreeFolder: ".tokama/wt" };
  git = createGit({ runner: createProcessRunner({ parentEnv: { PATH: process.env["PATH"], HOME: home } }) });
  resolved = [];
}, SLOW.timeout);
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("what runs", () => {
  it("only accepts one simple command of plain text, and creates nothing for a bad one", SLOW, async () => {
    const bad = ["a && b", "x | sh", "rm -rf build; ls", "echo $(whoami)", "echo `id`", "ls > out", "sleep 1 &", "echo hi\nrm -rf x", "ls​", "ls‮", "ls rm x", "ls\u0000", ""];
    const trials = runner();
    for (const command of bad) {
      expect(await trials.prepare({ path: repo.path, checks: [{ command }] }), JSON.stringify(command)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
      expect(await trials.prepare({ path: repo.path, setup: command, checks: [{ command: "true" }] }), `setup ${JSON.stringify(command)}`).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    }
    // The good check before a bad one does not get the trial started either.
    expect(await trials.prepare({ path: repo.path, checks: [{ command: "pnpm test" }, { command: "x | sh" }] })).toMatchObject({ ok: false });
    expect(resolved).toEqual([]);
    expect(existsSync(join(repo.path, ".tokama"))).toBe(false);
    expect(readFileSync(join(repo.path, ".git", "info", "exclude"), "utf8")).not.toContain(".tokama");
    expect(trialCommandProblem("pnpm test")).toBeUndefined();
  });

  it("refuses a worktree folder that is a link before it makes anything", SLOW, async () => {
    symlinkSync(outside, join(repo.path, ".tokama"));
    expect(await runner().prepare({ path: repo.path, checks: [{ command: "true" }] })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(await runner().prepare({ path: repo.path, checks: [{ command: "true" }] })).toMatchObject({ ok: false, error: { message: expect.stringContaining("link") } });
    expect(await listed()).toEqual([repo.path]);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("says when the base branch is not there", SLOW, async () => {
    repo = { ...repo, baseBranch: "nope" };
    expect(await runner().prepare({ path: repo.path, checks: [{ command: "true" }] })).toMatchObject({ ok: false, error: { code: "invalid_request", message: expect.stringContaining("nope") } });
  });
});

describe("running", () => {
  it("runs every check, whichever fail, each with its own result, in the worktree at the base commit", SLOW, async () => {
    const run = await trial({
      checks: [{ command: "cat a.txt" }, { command: "sh -c 'echo broken; exit 3'" }, { command: "sleep 30", minutes: 1 }, { command: "true" }, { command: "no-such-command-346" }],
    });
    expect(run.last.state).toBe("done");
    expect(run.last.checks.map((check) => check.state)).toEqual(["passed", "failed", "timed_out", "passed", "failed"]);
    expect(run.last.checks[0]).toMatchObject({ exitCode: 0, outputTail: "one" });
    expect(run.last.checks[1]).toMatchObject({ exitCode: 3, outputTail: "broken" });
    expect(run.last.checks[4]?.exitCode).toBe(127);
    for (const check of run.last.checks) expect(check.durationMs).toBeGreaterThanOrEqual(0);
    expect(run.last.commit).toBe(run.commit.slice(0, 12));
    expect(run.last.endedAt).toBeGreaterThanOrEqual(run.last.startedAt);
    // Never a skip: each check ran although an earlier one failed.
    expect(run.last.checks.some((check) => check.state === "skipped")).toBe(false);
  });

  it("sets CI=1, runs in the worktree and shows each check as waiting, then running, then its result", SLOW, async () => {
    const run = await trial({ checks: [{ command: 'sh -c \'test "$CI" = 1 && pwd\'' }, { command: "true" }] });
    expect(run.last.checks[0]?.state).toBe("passed");
    expect(run.last.checks[0]?.outputTail).toBe("<worktree>");
    const first = run.updates.map((update) => update.checks[0]?.state);
    expect(first.indexOf("running")).toBeGreaterThan(first.indexOf("waiting"));
    expect(first.indexOf("passed")).toBeGreaterThan(first.indexOf("running"));
    expect(run.updates[0]?.state).toBe("running");
  });

  it("records the worktree before it exists, and leaves none behind", SLOW, async () => {
    const run = await trial({ checks: [{ command: "true" }] });
    expect(run.planned).toHaveLength(1);
    expect(run.planned[0]).toMatchObject({ repoPath: repo.path, existed: false });
    expect(run.planned[0]?.worktreePath).toMatch(/\/\.tokama\/wt\/try-[0-9a-f]{8}$/);
    expect(existsSync(run.planned[0]!.worktreePath)).toBe(false);
    expect(await listed()).toEqual([repo.path]);
    expect(await plain(repo.path, "branch", "--list")).toContain("main");
    expect((await plain(repo.path, "branch", "--list")).trim().split("\n")).toHaveLength(1);
    expect(run.pids.length).toBeGreaterThan(0);
  });

  it("runs the setup first, once, and its work is there for the checks", SLOW, async () => {
    const run = await trial({ setup: "touch ready", checks: [{ command: "test -f ready" }] });
    expect(run.last).toMatchObject({ state: "done", setup: "touch ready" });
    expect(run.last.checks[0]?.state).toBe("passed");
  });

  it("a failed setup fails the trial, with its exit code and a short cleaned tail, and skips the checks", SLOW, async () => {
    const run = await trial({ setup: "sh -c 'echo \"boom in $PWD\"; exit 4'", checks: [{ command: "touch check-ran" }, { command: "true" }] });
    expect(run.last.state).toBe("failed");
    expect(run.last.error?.code).toBe("setup_failed");
    expect(run.last.error?.message).toContain("exited with code 4");
    expect(run.last.error?.message).toContain("boom in <worktree>");
    expect(run.last.error!.message.length).toBeLessThanOrEqual(1000);
    expect(run.last.checks.map((check) => check.state)).toEqual(["skipped", "skipped"]);
    expect(await listed()).toEqual([repo.path]);
  });

  it("a setup that does not finish in 20 minutes fails the trial", SLOW, async () => {
    const run = await trial({ setup: "sleep 30", checks: [{ command: "true" }] });
    expect(run.last).toMatchObject({ state: "failed", error: { code: "setup_failed", message: expect.stringContaining("did not finish") } });
    expect(run.last.checks[0]?.state).toBe("skipped");
  });

  it("gives a check without minutes the 20 minute limit and clamps the rest between 2 and 20", () => {
    expect(checkLimitMinutes(undefined)).toBe(20);
    expect(checkLimitMinutes(1)).toBe(3);
    expect(checkLimitMinutes(0.1)).toBe(2);
    expect(checkLimitMinutes(5)).toBe(15);
    expect(checkLimitMinutes(120)).toBe(20);
  });

  it("cancelling stops the running command and its group, skips the rest and removes the worktree", SLOW, async () => {
    const controller = new AbortController();
    const trials = runner();
    const prepared = await trials.prepare({ path: repo.path, checks: [{ command: "true" }, { command: "sleep 30" }, { command: "true" }] });
    if (!prepared.ok) throw new Error("prepare refused");
    const seen = hooks();
    const done = trials.run(prepared.value, { ...seen.hooks, onUpdate: (update) => {
      seen.updates.push(update);
      if (update.checks[1]?.state === "running") setTimeout(() => controller.abort(), 100);
    } }, controller.signal);
    await done;
    const last = seen.updates.at(-1)!;
    expect(last.state).toBe("cancelled");
    expect(last.checks.map((check) => check.state)).toEqual(["passed", "skipped", "skipped"]);
    expect(await listed()).toEqual([repo.path]);
    const sleeper = seen.pids.at(-1)!;
    expect(() => process.kill(sleeper, 0)).toThrow();
  });

  it("already cancelled before it starts runs nothing and leaves nothing", SLOW, async () => {
    const controller = new AbortController();
    controller.abort();
    const run = await trial({ checks: [{ command: "touch ran" }] }, controller.signal);
    expect(run.last.state).toBe("cancelled");
    expect(run.last.checks[0]?.state).toBe("skipped");
    expect(await listed()).toEqual([repo.path]);
  });

  it("a trial changes nothing in the repo's own checkout", SLOW, async () => {
    await trial({ checks: [{ command: "touch made-in-trial" }, { command: "sh -c 'echo changed > a.txt'" }] });
    expect(existsSync(join(repo.path, "made-in-trial"))).toBe(false);
    expect(readFileSync(join(repo.path, "a.txt"), "utf8")).toBe("one\n");
    expect(await plain(repo.path, "status", "--porcelain")).toBe("");
    expect(await worktrees()).toBe(true);
  });
});

describe("output", () => {
  it("is text only: no escape or control characters, our folders written as names", () => {
    const text = tidyOutput("\u001b[31mred\u001b[0m \u001b]0;title\u0007ok\u0000‮\n/home/me/code/orders-api/src/a.ts and ~/x", [
      ["/home/me/code/orders-api", "<repo>"],
      ["/home/me", "~"],
    ]);
    expect(text).toBe("red ok\n<repo>/src/a.ts and ~/x");
  });

  it("keeps the last 2 000 characters", SLOW, async () => {
    const run = await trial({ checks: [{ command: "seq 1 3000" }] });
    const tail = run.last.checks[0]!.outputTail!;
    expect(tail.length).toBeLessThanOrEqual(2000);
    expect(tail.endsWith("3000")).toBe(true);
    expect(tail.startsWith("…")).toBe(true);
  });

  it("writes the home and the repo folder as names, and strips colour codes a command prints", SLOW, async () => {
    const run = await trial({ checks: [{ command: `sh -c 'printf "\\033[32mgreen\\033[0m ${home}/secrets $PWD\\n"'` }] });
    expect(run.last.checks[0]?.outputTail).toBe("green ~/.tokama/secrets <worktree>");
  });
});
