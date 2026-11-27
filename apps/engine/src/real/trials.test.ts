// The open-trials file with a fake runner and fake git: what stays in it when a worktree cannot be removed.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CheckTrial, type CheckTrialRunner, err, type Git, ok, type PreparedCheckTrial, systemClock } from "@tokama/core";
import { afterEach, describe, expect, it } from "vitest";
import { waitFor } from "../testing/helpers.js";
import { CheckTrials } from "./trials.js";

const TRIAL_ID = "trial_01a21cfa-0c20-7c94-872a-637c06226ecd";
let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

const table = { list: async () => [], bootTime: () => Date.UTC(2026, 10, 1), signalGroup: () => {} };
const brokenGit = { worktreeList: async () => err({ reason: "failed", args: [], exitCode: 1, message: "git is broken" }) } as unknown as Git;

function layout() {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tk-trials-unit-")));
  const home = join(root, "home");
  const repo = join(root, "orders-api");
  const worktree = join(repo, ".tokama", "wt", "try-01a21cfa");
  mkdirSync(home);
  mkdirSync(worktree, { recursive: true });
  return { home, repo, worktree, file: join(home, "run", "check-trials.json") };
}

/** A runner whose trial plans a worktree, ends done, and never removes the worktree. */
const leavingRunner = (repo: string, worktree: string): CheckTrialRunner => ({
  prepare: async (request) => ok({ trialId: TRIAL_ID, request, repo: { path: repo, baseBranch: "main", worktreeFolder: ".tokama/wt" }, commit: "a".repeat(40) } as unknown as PreparedCheckTrial),
  run: async (prepared, hooks) => {
    hooks.onPlanned({ repoPath: repo, worktreePath: worktree });
    const trial: CheckTrial = { trialId: prepared.trialId, state: "done", startedAt: 1, endedAt: 2, checks: [{ command: "true", state: "passed" }] };
    hooks.onUpdate(trial);
  },
});

const options = (home: string, runner: CheckTrialRunner, git: Git) => ({ runner, git, home, clock: systemClock, processes: table, emit: () => {}, log: () => {} });

describe("the open-trials file", () => {
  it("keeps a trial whose worktree is still there after the run, and the next start keeps it while git cannot remove it", async () => {
    const { home, repo, worktree, file } = layout();
    const trials = new CheckTrials(options(home, leavingRunner(repo, worktree), brokenGit));
    const started = await trials.start({ path: repo, checks: [{ command: "true" }] });
    expect(started.ok).toBe(true);
    await waitFor(() => trials.running() === 0 && existsSync(file), 5_000, "the run to end");
    await trials.close();
    expect(JSON.parse(readFileSync(file, "utf8")).trials).toMatchObject([{ trialId: TRIAL_ID, repoPath: repo, worktreePath: worktree }]);

    const next = new CheckTrials(options(home, leavingRunner(repo, worktree), brokenGit));
    await next.ready;
    await next.close();
    expect(JSON.parse(readFileSync(file, "utf8")).trials).toMatchObject([{ trialId: TRIAL_ID }]);
    expect(existsSync(worktree)).toBe(true);
  });

  it("drops the record once the worktree is gone", async () => {
    const { home, repo, worktree, file } = layout();
    const runner = leavingRunner(repo, worktree);
    const removing: CheckTrialRunner = { ...runner, run: async (prepared, hooks, signal) => (await runner.run(prepared, hooks, signal), rmSync(worktree, { recursive: true })) };
    const trials = new CheckTrials(options(home, removing, brokenGit));
    await trials.start({ path: repo, checks: [{ command: "true" }] });
    await waitFor(() => trials.running() === 0, 5_000, "the run to end");
    await trials.close();
    expect(JSON.parse(readFileSync(file, "utf8")).trials).toEqual([]);
  });
});
