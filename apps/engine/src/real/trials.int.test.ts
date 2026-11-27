// Try checks in a real engine, through the real client and socket, on temp git repos. The home is a
// temp folder, so the owner's Tokama home, engine and dotfiles are never touched.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type EngineClient } from "@tokama/client";
import { API_VERSION, type CheckTrial, createProcessRunner, type EngineEvent, type ProcessTable, systemClock } from "@tokama/core";
import { afterEach, describe, expect, it } from "vitest";
import { startEngine } from "../engine.js";
import { rawConnect, tempEngineDir, waitFor } from "../testing/helpers.js";
import type { HealthChecks } from "./health.js";

const SLOW = 40_000;
const TRIAL_ID = "trial_1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const healthy: HealthChecks = async () => ({ git: { ok: true, version: "git version 2.54.0" }, clis: [] });

let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

const gitEnvRunner = (home: string) => createProcessRunner({ parentEnv: { PATH: process.env["PATH"], HOME: home } });

async function plain(home: string, cwd: string, ...args: string[]): Promise<string> {
  const out: string[] = [];
  const result = await gitEnvRunner(home).run({ command: { argv: ["git", ...args] }, cwd, env: { GIT_CONFIG_NOSYSTEM: "1" }, stdout: { onLine: (line) => out.push(line) } });
  if (result.kind !== "finished" || result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return out.join("\n");
}

interface Fixture {
  readonly client: EngineClient;
  readonly events: EngineEvent[];
  readonly home: string;
  readonly root: string;
  readonly repo: string;
  readonly socketPath: string;
  readonly tokenPath: string;
  readonly stop: () => Promise<void>;
  readonly signals: [number, string][];
}

/** A temp home and the folder of a temp repo `orders-api`; `seed` makes the repo. */
function layout(): { root: string; home: string; repo: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tk-trials-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const repo = join(root, "orders-api");
  mkdirSync(home);
  mkdirSync(repo);
  writeFileSync(join(repo, "a.txt"), "one\n");
  return { root, home, repo };
}

async function seed(home: string, repo: string, commits = true): Promise<void> {
  await plain(home, repo, "init", "-q", "-b", "main");
  await plain(home, repo, "config", "user.name", "Test");
  await plain(home, repo, "config", "user.email", "test@example.com");
  if (!commits) return;
  await plain(home, repo, "add", "-A");
  await plain(home, repo, "commit", "-q", "-m", "seed");
}

async function engine(options: { commits?: boolean; prepare?: (paths: { home: string; repo: string; root: string }) => Promise<void> | void; alive?: { pid: number; startedAt: number }[]; bootTime?: number } = {}): Promise<Fixture> {
  const paths = layout();
  await seed(paths.home, paths.repo, options.commits ?? true);
  await options.prepare?.(paths);
  const signals: [number, string][] = [];
  const alive = options.alive ?? [];
  const table: ProcessTable = {
    list: async () => alive.filter((proc) => !signals.some(([pgid]) => pgid === proc.pid)).map((proc) => ({ ...proc, ppid: 1, pgid: proc.pid })),
    bootTime: () => options.bootTime ?? Date.UTC(2026, 10, 1),
    signalGroup: (pgid, signal) => void signals.push([pgid, signal]),
  };
  const dir = tempEngineDir(cleanups);
  const started = await startEngine({ dir, home: paths.home, clock: systemClock, processTable: table, checks: healthy, recoveryGraceMs: 0, planSources: {} });
  if (!started.ok) throw new Error(started.error.message);
  let stopped = false;
  const stop = async () => {
    if (!stopped) await started.value.close();
    stopped = true;
  };
  cleanups.push(stop);
  const connected = await connect({ dir, lockPath: started.value.endpoint.lockPath, startTimeoutMs: 2_000 });
  if (!connected.ok) throw new Error(connected.error.message);
  cleanups.push(() => connected.value.close());
  const events: EngineEvent[] = [];
  void (async () => {
    for await (const event of connected.value.events()) if (event.kind === "event") events.push(event.event);
  })();
  return { client: connected.value, events, ...paths, socketPath: started.value.endpoint.socketPath, tokenPath: started.value.endpoint.tokenPath, stop, signals };
}

const tryChecks = (fixture: Fixture, checks: { command: string; minutes?: number }[], more: Record<string, unknown> = {}) =>
  fixture.client.command({ type: "try_checks", path: fixture.repo, checks, ...more } as never);

async function started(fixture: Fixture, checks: { command: string; minutes?: number }[], more: Record<string, unknown> = {}): Promise<string> {
  const reply = await tryChecks(fixture, checks, more);
  if (!reply.ok) throw new Error(reply.error.message);
  return (reply.data as { trialId: string }).trialId;
}

const updates = (fixture: Fixture, trialId: string): CheckTrial[] => fixture.events.flatMap((event) => (event.type === "check_trial_updated" && event.trial.trialId === trialId ? [event.trial] : []));

async function ended(fixture: Fixture, trialId: string): Promise<CheckTrial> {
  await waitFor(() => updates(fixture, trialId).some((trial) => trial.state !== "running"), 20_000, `the end of ${trialId}`);
  return updates(fixture, trialId).at(-1)!;
}

const worktreesOf = async (fixture: Pick<Fixture, "home" | "repo">) => (await plain(fixture.home, fixture.repo, "worktree", "list", "--porcelain")).split("\n").filter((line) => line.startsWith("worktree "));
/** A start waits for the start-up sweep, so once a (refused) request is answered, the sweep has ended. */
const sweepDone = (fixture: Fixture) => tryChecks(fixture, [{ command: "a && b" }]);
const openFile = (home: string) => join(home, "run", "check-trials.json");

describe("try_checks in a real engine", () => {
  it("runs every check, each with its own result, announces the trial after its id, and leaves nothing behind", { timeout: SLOW }, async () => {
    const fixture = await engine();
    const trialId = await started(fixture, [{ command: "cat a.txt" }, { command: "sh -c 'echo broken; exit 3'" }, { command: "true" }]);
    const trial = await ended(fixture, trialId);
    expect(trial.state).toBe("done");
    expect(trial.checks.map((check) => check.state)).toEqual(["passed", "failed", "passed"]);
    expect(trial.checks[1]).toMatchObject({ exitCode: 3, outputTail: "broken" });
    // The first update the client hears of is the trial, running, after the reply with its id.
    expect(updates(fixture, trialId)[0]?.state).toBe("running");
    expect(await fixture.client.query({ type: "check_trial", trialId: trialId as never })).toMatchObject({ ok: true, data: { trial: { trialId, state: "done" } } });
    expect(await worktreesOf(fixture)).toEqual([`worktree ${fixture.repo}`]);
    expect(readFileSync(join(fixture.repo, ".git", "info", "exclude"), "utf8")).toContain("/.tokama/wt/");
    expect(JSON.parse(readFileSync(openFile(fixture.home), "utf8"))).toEqual({ format: 1, trials: [] });
  });

  it("refuses a bad command or setup with invalid_request, before anything exists", { timeout: SLOW }, async () => {
    const fixture = await engine();
    for (const command of ["a && b", "x | sh", "echo $(id)", "ls​", "ls\nrm x"]) {
      expect(await tryChecks(fixture, [{ command }]), JSON.stringify(command)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
      expect(await tryChecks(fixture, [{ command: "true" }], { setup: command })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    }
    expect(existsSync(join(fixture.repo, ".tokama"))).toBe(false);
    expect(existsSync(openFile(fixture.home)) ? readFileSync(openFile(fixture.home), "utf8") : "").not.toContain("trial_");
    expect(await worktreesOf(fixture)).toEqual([`worktree ${fixture.repo}`]);
  });

  it("takes its commands from the request only: an extra field pulling them from a helper run is refused", { timeout: SLOW }, async () => {
    const fixture = await engine();
    const reply = await tryChecks(fixture, [{ command: "true" }], { fromHelperRun: "hrun_0b9f3c1e-6a2d-4f7b-9c1a-2e3d4f5a6b7c" });
    expect(reply.ok).toBe(false);
    expect(fixture.events.some((event) => event.type === "check_trial_updated")).toBe(false);
  });

  it("refuses a folder that is not a repo, and a repo with no commits (invalid_state)", { timeout: SLOW }, async () => {
    const fixture = await engine({ commits: false });
    expect(await tryChecks(fixture, [{ command: "true" }])).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(await fixture.client.command({ type: "try_checks", path: fixture.root, checks: [{ command: "true" }] } as never)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(await fixture.client.command({ type: "try_checks", path: join(fixture.root, "missing"), checks: [{ command: "true" }] } as never)).toMatchObject({ ok: false });
  });

  it("refuses a worktree folder that is a link, and an unknown base branch", { timeout: SLOW }, async () => {
    const fixture = await engine();
    expect(await tryChecks(fixture, [{ command: "true" }], { baseBranch: "nope" })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(await tryChecks(fixture, [{ command: "true" }], { baseBranch: "-x" })).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    const outside = join(fixture.root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(fixture.repo, ".tokama"));
    const reply = await tryChecks(fixture, [{ command: "true" }]);
    expect(reply).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(existsSync(join(outside, "wt"))).toBe(false);
  });

  it("a failed setup fails the trial and skips the checks", { timeout: SLOW }, async () => {
    const fixture = await engine();
    const trialId = await started(fixture, [{ command: "touch ran" }], { setup: "sh -c 'echo no network; exit 7'" });
    const trial = await ended(fixture, trialId);
    expect(trial).toMatchObject({ state: "failed", error: { code: "setup_failed" }, checks: [{ state: "skipped" }] });
    expect(trial.error?.message).toContain("exited with code 7");
    expect(trial.error?.message).toContain("no network");
  });

  it("one trial at a time: a second is busy, and an idle-only stop is refused until the first ends", { timeout: SLOW }, async () => {
    const fixture = await engine();
    const trialId = await started(fixture, [{ command: "sleep 30" }]);
    expect(await tryChecks(fixture, [{ command: "true" }])).toMatchObject({ ok: false, error: { code: "busy" } });
    const token = readFileSync(fixture.tokenPath, "utf8");
    const ask = async () => {
      const raw = await rawConnect(fixture.socketPath);
      cleanups.push(() => raw.destroy());
      raw.send({ kind: "shutdown", apiVersion: API_VERSION, token, ifIdle: true });
      return raw.next();
    };
    expect(await ask()).toMatchObject({ kind: "shutdown_refused", runningItems: 1 });
    expect(await fixture.client.command({ type: "cancel_check_trial", trialId: trialId as never })).toMatchObject({ ok: true, data: null });
    const trial = await ended(fixture, trialId);
    expect(trial).toMatchObject({ state: "cancelled", checks: [{ state: "skipped" }] });
    expect(await worktreesOf(fixture)).toEqual([`worktree ${fixture.repo}`]);
    expect(await fixture.client.command({ type: "cancel_check_trial", trialId: trialId as never })).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(await ask()).toMatchObject({ kind: "shutdown_accepted" });
  });

  it("shutdown cancels a running trial and removes its worktree", { timeout: SLOW }, async () => {
    const fixture = await engine();
    await started(fixture, [{ command: "sleep 30" }]);
    await waitFor(() => existsSync(openFile(fixture.home)) && readFileSync(openFile(fixture.home), "utf8").includes("worktreePath"), 10_000, "the trial to be recorded");
    await fixture.stop();
    expect(await worktreesOf(fixture)).toEqual([`worktree ${fixture.repo}`]);
    expect(JSON.parse(readFileSync(openFile(fixture.home), "utf8"))).toEqual({ format: 1, trials: [] });
  });

  it("the file of open trials has no more than the ids, the paths and the process", { timeout: SLOW }, async () => {
    const fixture = await engine();
    await started(fixture, [{ command: "sleep 30" }]);
    await waitFor(() => existsSync(openFile(fixture.home)) && /"pid":/.test(readFileSync(openFile(fixture.home), "utf8")), 10_000, "the pid to be recorded");
    const [open] = JSON.parse(readFileSync(openFile(fixture.home), "utf8")).trials as Record<string, unknown>[];
    expect(Object.keys(open!).sort()).toEqual(["bootTime", "pid", "repoPath", "startedAt", "trialId", "worktreePath"]);
    expect(open?.["worktreePath"]).toMatch(/\/\.tokama\/wt\/try-[0-9a-f]{8}$/);
  });
});

describe("the start-up cleanup", () => {
  const ITEM_WORKTREE = ".tokama/wt/0b9f12ab";

  /** A trial the last engine left, an item worktree and a branch worktree named like a trial, with a record for each. */
  async function leftovers(paths: { home: string; repo: string }, options: { pid?: number; bootTime: number; startedAt?: number }) {
    const commit = (await plain(paths.home, paths.repo, "rev-parse", "HEAD")).trim();
    mkdirSync(join(paths.repo, ".tokama", "wt"), { recursive: true });
    const trial = join(paths.repo, ".tokama", "wt", "try-1c2d3e4f");
    const lookalike = join(paths.repo, ".tokama", "wt", "try-deadbeef");
    const item = join(paths.repo, ITEM_WORKTREE);
    await plain(paths.home, paths.repo, "worktree", "add", "-q", "--detach", trial, commit);
    await plain(paths.home, paths.repo, "worktree", "add", "-q", "-b", "tokama/0b9f12ab", item, "main");
    await plain(paths.home, paths.repo, "worktree", "add", "-q", "-b", "tokama/lookalike", lookalike, "main");
    mkdirSync(join(paths.home, "run"), { recursive: true });
    const record = (trialId: string, worktreePath: string, extra: Record<string, unknown> = {}) => ({ trialId, repoPath: paths.repo, worktreePath, bootTime: options.bootTime, ...extra });
    writeFileSync(
      openFile(paths.home),
      JSON.stringify({
        format: 1,
        trials: [
          record(TRIAL_ID, trial, options.pid === undefined ? {} : { pid: options.pid, startedAt: options.startedAt }),
          // Forged or damaged records: they must not reach a worktree that is not a detached trial.
          record("trial_forged-1", item),
          record("trial_forged-2", lookalike),
          record("trial_forged-3", join(paths.repo, ".git")),
          { trialId: "broken" },
        ],
      }),
    );
    return { trial, item, lookalike };
  }

  it("removes the trial worktree a stopped engine left, and nothing else", { timeout: SLOW }, async () => {
    let made: Awaited<ReturnType<typeof leftovers>> | undefined;
    const fixture = await engine({ prepare: async (paths) => void (made = await leftovers(paths, { bootTime: Date.UTC(2026, 10, 1) })) });
    await waitFor(() => !existsSync(made!.trial), 10_000, "the sweep");
    await sweepDone(fixture);
    expect(existsSync(made!.item)).toBe(true);
    expect(existsSync(made!.lookalike)).toBe(true);
    expect(await plain(fixture.home, fixture.repo, "branch", "--list", "tokama/*")).toContain("tokama/0b9f12ab");
    expect(await plain(fixture.home, fixture.repo, "branch", "--list", "tokama/*")).toContain("tokama/lookalike");
    expect(existsSync(join(fixture.repo, ".git"))).toBe(true);
    expect(fixture.signals).toEqual([]);
  });

  it("stops a leftover process tree only when the boot time and the start time match", { timeout: SLOW }, async () => {
    const startedAt = Date.UTC(2026, 10, 27, 9);
    const matching = await engine({ alive: [{ pid: 4242, startedAt }], prepare: async (paths) => void (await leftovers(paths, { pid: 4242, startedAt, bootTime: Date.UTC(2026, 10, 1) })) });
    await waitFor(() => matching.signals.length > 0, 10_000, "the kill");
    expect(matching.signals[0]).toEqual([4242, "SIGTERM"]);
    const rebooted = await engine({ alive: [{ pid: 4242, startedAt }], bootTime: Date.UTC(2026, 10, 20), prepare: async (paths) => void (await leftovers(paths, { pid: 4242, startedAt, bootTime: Date.UTC(2026, 10, 1) })) });
    await waitFor(() => !existsSync(join(rebooted.repo, ".tokama", "wt", "try-1c2d3e4f")), 10_000, "the sweep");
    expect(rebooted.signals).toEqual([]);
    const reused = await engine({ alive: [{ pid: 4242, startedAt: startedAt + 3_600_000 }], prepare: async (paths) => void (await leftovers(paths, { pid: 4242, startedAt, bootTime: Date.UTC(2026, 10, 1) })) });
    await waitFor(() => !existsSync(join(reused.repo, ".tokama", "wt", "try-1c2d3e4f")), 10_000, "the sweep");
    expect(reused.signals).toEqual([]);
  });

  it("cleans a folder that was never added as a repo (the repo is not in repos.yaml)", { timeout: SLOW }, async () => {
    let made: Awaited<ReturnType<typeof leftovers>> | undefined;
    const fixture = await engine({ prepare: async (paths) => void (made = await leftovers(paths, { bootTime: Date.UTC(2026, 10, 1) })) });
    expect(existsSync(join(fixture.home, "repos.yaml"))).toBe(false);
    await waitFor(() => !existsSync(made!.trial), 10_000, "the sweep");
    await sweepDone(fixture);
    expect(existsSync(made!.item)).toBe(true);
    expect(existsSync(made!.lookalike)).toBe(true);
  });
});
