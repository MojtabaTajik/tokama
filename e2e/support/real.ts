// What both real tests share: a temp workspace with a tiny fixture repo, the built engine started
// in real mode, the checks that decide whether Claude Code can run, and the assertions about the
// finished item.
//
// Two homes, on purpose. Tokama's own home (repos.yaml, items, agents) is `<workspace>/h/.tokama`,
// never `~/.tokama`. But the engine process keeps the real OS HOME: Claude Code finds its login
// there (on macOS in the login keychain, which a temp HOME cannot reach), so a temp HOME would
// always read as logged out. The engine is told its Tokama home with `--home`.
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { connect, type EngineClient } from "@tokama/client";
import type { ItemRecord } from "@tokama/core";
import { expect } from "vitest";

export const ENGINE_ENTRY = resolve(import.meta.dirname, "../../apps/engine/dist/main.js");
export const DESKTOP_DIR = resolve(import.meta.dirname, "../../apps/desktop");

/** The task Claude gets. The bug is `+` where `*` belongs; the failing test names it. */
export const TASK = "lineTotal in src/total.js returns the wrong amount, and its test in test/total.test.js fails. Fix it.";
export const REPO_ID = "orders-api";
export const CHECK_COMMAND = "node --test";
/** Hard limit of one item. The tests stop the item and the engine when it passes. */
export const ITEM_DEADLINE_MS = 240_000;

/** The one agent a run uses: the same role as the built-in Builder, pinned to the cheapest model. */
const BUILDER = [
  "---",
  "format: 1",
  "name: Builder",
  "runs_on: claude-code",
  "model: haiku",
  "tools: edit",
  "---",
  "You are Builder. Make the change the task asks for, in this worktree only. Do not commit.",
  "",
].join("\n");

export interface Workspace {
  /** Everything of one test: removed at the end. */
  readonly root: string;
  /** HOME of the app in the app test; the engine keeps the real one. */
  readonly home: string;
  /** Tokama's home folder. */
  readonly tokamaHome: string;
  /** The engine dir. Kept short: a socket path is limited on macOS. */
  readonly engineDir: string;
  /** The fixture repo. */
  readonly repo: string;
  cleanup(): void;
}

export function createWorkspace(): Workspace {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tk-real-")));
  const home = join(root, "h");
  const tokamaHome = join(home, ".tokama");
  const workspace: Workspace = { root, home, tokamaHome, engineDir: join(root, "e"), repo: join(root, REPO_ID), cleanup: () => rmSync(root, { recursive: true, force: true }) };
  mkdirSync(join(tokamaHome, "agents"), { recursive: true });
  writeFileSync(join(tokamaHome, "agents", "builder.md"), BUILDER);
  createFixture(workspace.repo);
  return workspace;
}

/** Runs git in `cwd` without the machine's git config, so a signing setup cannot get in the way. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
}

/** A tiny project with one bug: `node --test` fails until `lineTotal` multiplies. */
function createFixture(repo: string): void {
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "test"));
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: REPO_ID, private: true, type: "module" }, null, 2)}\n`);
  writeFileSync(join(repo, "src", "total.js"), "export function lineTotal(price, quantity) {\n  return price + quantity;\n}\n");
  writeFileSync(
    join(repo, "test", "total.test.js"),
    [
      'import assert from "node:assert/strict";',
      'import { test } from "node:test";',
      'import { lineTotal } from "../src/total.js";',
      "",
      'test("lineTotal multiplies price by quantity", () => {',
      "  assert.equal(lineTotal(5, 3), 15);",
      "});",
      "",
    ].join("\n"),
  );
  git(repo, "init", "-q", "-b", "main");
  // Tokama commits with the repo's own identity.
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@example.com");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");
}

/** Adds the fixture to Tokama's repos, as `+ Add repo` would. */
export function writeRepos(workspace: Workspace): void {
  writeFileSync(join(workspace.tokamaHome, "repos.yaml"), `format: 1\nrepos:\n  - id: ${REPO_ID}\n    path: ${workspace.repo}\n    base_branch: main\n    checks: ["${CHECK_COMMAND}"]\n`);
}

export interface MainTree {
  readonly head: string;
  readonly branch: string;
  readonly status: string;
  readonly files: string;
}

/** What a run must leave as it is: the main working tree of the fixture. */
export function mainTree(workspace: Workspace): MainTree {
  const { repo } = workspace;
  return {
    head: git(repo, "rev-parse", "HEAD"),
    branch: git(repo, "branch", "--show-current"),
    status: git(repo, "status", "--porcelain=v1", "--untracked-files=all"),
    files: git(repo, "hash-object", "src/total.js", "test/total.test.js"),
  };
}

export interface RunningEngine {
  readonly client: EngineClient;
  readonly pid: number;
  /** Stops the engine; it stops running agents on SIGTERM. Never throws. */
  stop(): Promise<void>;
}

/** The environment the built engine gets: the reduced set it passes on anyway, with the real HOME. */
function engineEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM"]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** SIGKILLs every process group the item logs record, so no agent outlives a killed engine. */
function killAgentGroups(workspace: Workspace): void {
  try {
    for (const item of readdirSync(join(workspace.tokamaHome, "items"))) {
      for (const line of readFileSync(join(workspace.tokamaHome, "items", item, "events.jsonl"), "utf8").split("\n")) {
        if (!line.includes('"process_started"')) continue;
        const { pgid } = JSON.parse(line) as { pgid?: number };
        if (pgid !== undefined) {
          try {
            process.kill(-pgid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }
    }
  } catch {
    // No items yet.
  }
}

/**
 * What starts the engine: the built engine on this node, or, when TOKAMA_REAL_ENGINE_DIR names the
 * engine folder of a packaged app, that folder's own Node and bundle.
 */
function engineLaunch(): { node: string; entry: string } {
  const packaged = process.env["TOKAMA_REAL_ENGINE_DIR"];
  if (packaged === undefined || packaged === "") return { node: process.execPath, entry: ENGINE_ENTRY };
  if (!isAbsolute(packaged)) throw new Error(`TOKAMA_REAL_ENGINE_DIR must be an absolute path, not ${packaged}`);
  return { node: join(packaged, "tokama-engine"), entry: join(packaged, "dist", "main.js") };
}

/** Starts the built engine in real mode on the workspace and connects to it. */
export async function startEngine(workspace: Workspace): Promise<RunningEngine> {
  const out = openSync(join(workspace.root, "engine.out"), "a");
  let child: ChildProcess;
  try {
    const launch = engineLaunch();
    child = spawn(launch.node, [launch.entry, "--dir", workspace.engineDir, "--home", workspace.tokamaHome], { env: engineEnv(), stdio: ["ignore", out, out] });
  } finally {
    closeSync(out);
  }
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  let client: EngineClient | undefined;
  const stop = async () => {
    await client?.close().catch(() => undefined);
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill(signal);
      await Promise.race([exited, new Promise((done) => setTimeout(done, 15_000))]);
    }
    // The engine had to be killed, so it may not have stopped its agents: end their process groups.
    killAgentGroups(workspace);
  };
  try {
    for (const deadline = Date.now() + 20_000; client === undefined; await new Promise((done) => setTimeout(done, 100))) {
      if (child.exitCode !== null) throw new Error(`the engine exited with ${child.exitCode}: ${readFileSync(join(workspace.root, "engine.out"), "utf8")}`);
      const connected = await connect({ dir: workspace.engineDir, startTimeoutMs: 1_000 });
      if (connected.ok) client = connected.value;
      else if (Date.now() > deadline) throw new Error(`no connection to the engine: ${connected.error.message}`);
    }
  } catch (error) {
    await stop();
    throw error;
  }
  return { client, pid: child.pid ?? 0, stop };
}

/** Why Claude Code cannot run here, or undefined when it can. Read with the engine's own health check. */
export async function claudeProblem(client: EngineClient): Promise<string | undefined> {
  const setup = await client.query({ type: "setup" });
  if (!setup.ok) return `the engine's setup query failed: ${setup.error.message}`;
  const claude = setup.data.health.clis.find((cli) => cli.cliId === "claude-code");
  if (claude === undefined || !claude.installed) return "Claude Code is not installed, or `claude` is not on the PATH.";
  if (!claude.loggedIn) return "Claude Code is not logged in. Run `claude auth login`, then try again.";
  return undefined;
}

/** Prints why a real test does not run; vitest shows the skip itself. */
export function skipNote(reason: string): string {
  const note = `real end-to-end test skipped: ${reason}`;
  process.stderr.write(`${note}\n`);
  return note;
}

/** The real ~/.tokama as a list of entries, to prove a run never touched it. */
export function realTokamaHome(): string[] {
  const root = join(homedir(), ".tokama");
  const entries: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const stat = statSync(path, { throwIfNoEntry: false });
      // The engine's own run dir holds sockets and locks of an engine the user may run.
      if (stat === undefined || entry.name === "run") continue;
      entries.push(`${path} ${stat.size} ${stat.mtimeMs}`);
      if (entry.isDirectory()) walk(path);
    }
  };
  try {
    walk(root);
  } catch {
    // No ~/.tokama: nothing to compare.
  }
  return entries.sort();
}

export type Waited = { readonly item: ItemRecord; readonly timedOut: boolean };

/** Polls the item until it ends or needs the user; at the deadline it stops the item and says so. */
export async function waitForItem(client: EngineClient, itemId: string, deadlineMs = ITEM_DEADLINE_MS): Promise<Waited> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const reply = await client.query({ type: "item", itemId });
    if (!reply.ok) throw new Error(`item query failed: ${reply.error.message}`);
    const { item } = reply.data;
    if (item.state !== "running" && item.state !== "queued") return { item, timedOut: false };
    if (Date.now() > deadline) {
      await client.command({ type: "stop_item", itemId });
      const stopped = await client.query({ type: "item", itemId });
      return { item: stopped.ok ? stopped.data.item : item, timedOut: true };
    }
    await new Promise((done) => setTimeout(done, 500));
  }
}

type LoggedEvent = { readonly type: string; readonly [key: string]: unknown };

/** The item's event log, one parsed event per line. */
export function readEvents(workspace: Workspace, itemId: string): LoggedEvent[] {
  const text = readFileSync(join(workspace.tokamaHome, "items", itemId, "events.jsonl"), "utf8");
  return text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as LoggedEvent);
}

/**
 * Asserts what a good run leaves behind and returns what it measured:
 * - the item ended `done` with one commit, on a `tokama/` branch that holds the fix;
 * - `node --test` passes on that commit, run in a separate copy of it;
 * - the fixture's main working tree, HEAD and branch are as before;
 * - the item log has the events of a run whose checks passed.
 */
export function expectGoodRun(workspace: Workspace, before: MainTree, item: ItemRecord): { commit: string; branch: string; events: LoggedEvent[] } {
  expect(item.state, `the item ended ${item.state}: ${item.outcome?.detail ?? ""}`).toBe("done");
  const commit = item.outcome?.commits?.[0];
  expect(commit, "the item has a commit").toBeDefined();
  expect(item.outcome?.commits).toHaveLength(1);
  const { commit: sha } = commit!;
  const branch = commit!.branch ?? "";
  expect(branch, "the commit names its branch").toMatch(/^tokama\//);

  // The branch holds the commit, and the commit holds the fix on top of the seed.
  expect(git(workspace.repo, "rev-parse", `${branch}`)).toBe(sha);
  expect(git(workspace.repo, "rev-parse", `${sha}^`)).toBe(before.head);
  expect(git(workspace.repo, "show", `${sha}:src/total.js`)).toContain("price * quantity");

  // The checks pass on the commit itself: a copy of its files, away from the fixture.
  const copy = join(workspace.root, "commit-copy");
  mkdirSync(copy);
  const archive = spawnSync("git", ["archive", "--format=tar", sha], { cwd: workspace.repo, maxBuffer: 10_000_000 });
  expect(archive.status, String(archive.stderr)).toBe(0);
  const unpacked = spawnSync("tar", ["-x", "-C", copy], { input: archive.stdout });
  expect(unpacked.status, String(unpacked.stderr)).toBe(0);
  const checks = spawnSync(process.execPath, ["--test"], { cwd: copy, encoding: "utf8", env: engineEnv() });
  expect(checks.status, `${checks.stdout}${checks.stderr}`).toBe(0);

  // The main working tree is as it was.
  expect(mainTree(workspace)).toEqual(before);

  const events = readEvents(workspace, item.id);
  const types = events.map((event) => event.type);
  for (const type of ["item_created", "worktree_added", "baseline_recorded", "step_started", "attempt_started", "check_result", "attempt_ended", "step_ended", "item_ended"]) {
    expect(types, `the log has ${type}`).toContain(type);
  }
  expect(events.filter((event) => event.type === "process_started").map((event) => event["role"]), "an agent ran, then a check").toEqual(expect.arrayContaining(["agent", "check"]));
  // A retry is allowed; the last check must have passed, and the item ends last.
  const results = events.filter((event) => event.type === "check_result");
  expect(results.at(-1)).toMatchObject({ command: CHECK_COMMAND, passed: true, exitCode: 0 });
  expect(events.at(-1)).toMatchObject({ type: "item_ended", outcome: "done", commits: [{ repoId: REPO_ID, commit: sha }] });
  return { commit: sha, branch, events };
}

/**
 * The tokens Claude Code's own session transcript of the item's worktree records, as one line;
 * undefined when it cannot be found. The engine stores no usage or cost, so this is the only
 * measure outside the engine process. Read-only.
 */
export function usageLine(itemId: string): string | undefined {
  const projects = join(homedir(), ".claude", "projects");
  const short = itemId.slice(-8);
  try {
    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let found = false;
    for (const name of readdirSync(projects).filter((entry) => entry.endsWith(short))) {
      for (const file of readdirSync(join(projects, name)).filter((entry) => entry.endsWith(".jsonl"))) {
        found = true;
        const seen = new Set<string>();
        for (const line of readFileSync(join(projects, name, file), "utf8").split("\n")) {
          if (line === "") continue;
          const entry = JSON.parse(line) as { message?: { id?: string; usage?: Record<string, number> } };
          const usage = entry.message?.usage;
          // One API message can span several lines; count it once.
          if (usage === undefined || (entry.message?.id !== undefined && seen.has(entry.message.id))) continue;
          if (entry.message?.id !== undefined) seen.add(entry.message.id);
          totals.input += usage["input_tokens"] ?? 0;
          totals.output += usage["output_tokens"] ?? 0;
          totals.cacheRead += usage["cache_read_input_tokens"] ?? 0;
          totals.cacheWrite += usage["cache_creation_input_tokens"] ?? 0;
        }
      }
    }
    return found ? `tokens: ${totals.input} in, ${totals.output} out, ${totals.cacheRead} cache read, ${totals.cacheWrite} cache write` : undefined;
  } catch {
    return undefined;
  }
}
