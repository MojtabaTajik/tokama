// Real mode through the real client and socket: a temp repo, the config files in a temp Tokama
// home, and a scripted agent runtime in place of Claude Code. Start, checks and commit; a
// decision; stop; and a restart while a step runs.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { connect, type EngineClient } from "@tokama/client";
import type { AgentCallRequest, AgentRuntime, CommandInput, ItemRecord, ProcessTable } from "@tokama/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startEngine } from "../engine.js";
import { tempEngineDir } from "../testing/helpers.js";
import type { HealthChecks } from "./health.js";

const SLOW = { timeout: 60_000 };
const NO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const table: ProcessTable = { list: async () => [], bootTime: () => Date.UTC(2026, 10, 1), signalGroup: () => undefined };
const healthy: HealthChecks = async () => ({ git: { ok: true, version: "git version 2.54.0" }, clis: [{ cliId: "claude-code", installed: true, loggedIn: true }] });

let cleanups: (() => unknown)[] = [];
let root: string;
let home: string;
let repoPath: string;

/** What the agent does in a call: write these files, or hang until the call is stopped. */
type Behavior = { readonly writes: Readonly<Record<string, string>> } | "hang";

/** A runtime that plays the script in order (the last entry repeats), and keeps every request. */
function scripted(script: readonly Behavior[]): AgentRuntime & { requests: AgentCallRequest[]; hanging: Promise<void> } {
  const requests: AgentCallRequest[] = [];
  let hung = () => {};
  const hanging = new Promise<void>((resolve) => (hung = resolve));
  return {
    requests,
    hanging,
    async *launch(request, signal) {
      const behavior = script[Math.min(requests.length, script.length - 1)]!;
      requests.push(request);
      yield { type: "started", pid: 4242 };
      if (behavior === "hang") {
        hung();
        await new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true })));
        yield { type: "end", outcome: "aborted", usage: NO_TOKENS };
        return;
      }
      for (const [path, content] of Object.entries(behavior.writes)) {
        mkdirSync(dirname(join(request.cwd, path)), { recursive: true });
        writeFileSync(join(request.cwd, path), content);
      }
      yield { type: "text", text: "Done." };
      yield { type: "end", outcome: "completed", usage: NO_TOKENS };
    },
  };
}

const git = (...args: string[]) => {
  const run = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd: repoPath,
    encoding: "utf8",
    // The fixture repo ignores the user's git config (signing, hooks).
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tk-real-")));
  home = join(root, "home");
  repoPath = join(root, "orders-api");
  mkdirSync(home);
  mkdirSync(repoPath);
  writeFileSync(join(repoPath, "greeting.txt"), "helo world\n");
  writeFileSync(join(repoPath, "check.sh"), "grep -qx 'hello world' greeting.txt\n");
  mkdirSync(join(repoPath, ".tokama", "templates"), { recursive: true });
  // Asks after a failed attempt instead of retrying on its own.
  writeFileSync(
    join(repoPath, ".tokama", "templates", "careful-fix.yaml"),
    `format: 1
name: Careful fix
uses:
  repos: edit
start:
  needs: [text, repo]
steps:
  - id: fix
    name: Fix
    agent: builder
    instructions: Fix the greeting.
    done_when: checks pass
    checks: from-repo
    if_failed: ask
    max_attempts: 1
    data: repo-and-diff
finish: [commit]
`,
  );
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  writeFileSync(join(home, "repos.yaml"), `format: 1\nrepos:\n  - id: orders-api\n    path: ${repoPath}\n    base_branch: main\n    checks: ["sh check.sh"]\n`);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
});

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

async function engine(runtime: AgentRuntime, dir = tempEngineDir(cleanups)) {
  const started = await startEngine({ dir, home, processTable: table, runtime: () => runtime, checks: healthy, recoveryGraceMs: 0 });
  if (!started.ok) throw new Error(started.error.message);
  const connected = await connect({ dir, startTimeoutMs: 2_000 });
  if (!connected.ok) throw new Error(connected.error.message);
  const client = connected.value;
  const stop = async () => {
    client.close();
    await started.value.close();
  };
  cleanups.push(stop);
  return { client, stop };
}

async function start(client: EngineClient, command: Partial<Extract<CommandInput, { type: "start_item" }>> = {}): Promise<string> {
  const reply = await client.command({ type: "start_item", templateId: "builtin/quick-fix", repoIds: ["orders-api"], text: "Fix the greeting typo", ...command });
  if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message}`);
  return reply.data.itemId;
}

async function item(client: EngineClient, itemId: string): Promise<ItemRecord> {
  const reply = await client.query({ type: "item", itemId });
  if (!reply.ok) throw new Error(reply.error.message);
  return reply.data.item;
}

/** Polls the item through the API until `check` passes. */
async function waitItem(client: EngineClient, itemId: string, check: (item: ItemRecord) => boolean, label: string): Promise<ItemRecord> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const current = await item(client, itemId);
    if (check(current)) return current;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}; item: ${JSON.stringify(current)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("real mode", () => {
  it("serves the setup from the config files, with refs, start, checks and health", SLOW, async () => {
    const { client } = await engine(scripted([{ writes: {} }]));
    const reply = await client.query({ type: "setup" });
    if (!reply.ok) throw new Error(reply.error.message);
    expect(reply.data.repos).toEqual([{ id: "orders-api", baseBranch: "main", checks: ["sh check.sh"] }]);
    expect(reply.data.agents).toContainEqual({ id: "builder", name: "Builder", cliId: "claude-code", model: "sonnet", runsOn: "cloud" });
    expect(reply.data.templates.map((t) => t.id)).toEqual(["orders-api/careful-fix", "builtin/quick-fix"]);
    expect(reply.data.templates[1]).toMatchObject({
      kind: "task",
      start: { needs: ["text", "repo"], askBeforeCloud: false },
      steps: [{ name: "Fix", agentId: "builder", data: "repo-and-diff", checks: { from: "repo" } }],
      warnings: [],
    });
    expect(reply.data.health).toEqual({ git: { ok: true, version: "git version 2.54.0" }, clis: [{ cliId: "claude-code", installed: true, loggedIn: true }], config: [] });
  });

  it("runs Quick fix: the agent edits, the repo's checks pass, and Tokama commits on the item branch", SLOW, async () => {
    const runtime = scripted([{ writes: { "greeting.txt": "hello world\n" } }]);
    const { client } = await engine(runtime);
    const id = await start(client);
    const done = await waitItem(client, id, (i) => i.state === "done", "done");
    const commit = done.outcome?.commits?.[0];
    expect(done).toMatchObject({ templateId: "builtin/quick-fix", kind: "task", privacy: "local_and_cloud", title: "Fix the greeting typo", outcome: { kind: "done" } });
    expect(done.steps[0]).toMatchObject({ name: "Fix", state: "passed", detail: "passed on attempt 1", attempts: [{ attempt: 1, result: "passed", checks: [{ command: "sh check.sh", passed: true, exitCode: 0 }] }] });
    expect(commit?.branch).toMatch(/^tokama\//);
    expect(done.cardLine).toBe(`commit ${commit?.commit.slice(0, 7)} · ${commit?.branch}`);
    expect(git("show", `${commit?.commit}:greeting.txt`)).toBe("hello world");
    // The step's role reached the call; the board lists the item.
    expect(runtime.requests[0]?.role).toContain("Builder");
    const board = await client.query({ type: "board" });
    expect(board.ok && board.data.items.map((i) => i.id)).toEqual([id]);
  });

  it("asks after a failed attempt; Retry once more runs the step again and commits", SLOW, async () => {
    const { client } = await engine(scripted([{ writes: { "greeting.txt": "still wrong\n" } }, { writes: { "greeting.txt": "hello world\n" } }]));
    const id = await start(client, { templateId: "orders-api/careful-fix" });
    const asked = await waitItem(client, id, (i) => i.state === "needs_you", "needs_you");
    expect(asked.decision).toMatchObject({ kind: "after_failure", stepIndex: 0, question: expect.stringContaining("failed") });
    expect(asked.steps[0]?.attempts?.[0]).toMatchObject({ result: "failed", checks: [{ command: "sh check.sh", passed: false, exitCode: 1 }] });
    const retry = asked.decision?.choices.find((c) => /retry/i.test(c.id));
    expect(retry).toBeDefined();
    expect(await client.command({ type: "resolve_decision", itemId: id, decisionId: asked.decision!.id, choice: retry!.id })).toEqual({ ok: true, data: null });
    const done = await waitItem(client, id, (i) => i.state === "done", "done");
    expect(done.steps[0]?.attempts?.map((a) => a.result)).toEqual(["failed", "passed"]);
  });

  it("stops a running item and keeps its record", SLOW, async () => {
    const runtime = scripted(["hang"]);
    const { client } = await engine(runtime);
    const id = await start(client);
    await runtime.hanging;
    expect(await client.command({ type: "stop_item", itemId: id })).toEqual({ ok: true, data: null });
    const stopped = await item(client, id);
    expect(stopped).toMatchObject({ state: "stopped", outcome: { kind: "stopped" }, steps: [{ state: "stopped", attempts: [{ result: "stopped" }] }] });
  });

  it("after a restart during a step, the item asks Retry step / Stop, and Retry runs it to a commit", SLOW, async () => {
    const hanging = scripted(["hang"]);
    const first = await engine(hanging);
    const id = await start(first.client);
    await hanging.hanging;
    await first.stop();

    const second = await engine(scripted([{ writes: { "greeting.txt": "hello world\n" } }]));
    const asked = await waitItem(second.client, id, (i) => i.state === "needs_you", "needs_you");
    expect(asked.decision).toMatchObject({ kind: "run_failure", choices: [{ id: "retry_step" }, { id: "stop" }] });
    expect(asked.steps[0]?.attempts?.[0]).toMatchObject({ result: "run_failed", failure: "engine_restart" });
    await second.client.command({ type: "resolve_decision", itemId: id, decisionId: asked.decision!.id, choice: "retry_step" });
    expect((await waitItem(second.client, id, (i) => i.state === "done", "done")).outcome?.commits).toHaveLength(1);
  });

  it("reads repos.yaml again after remove_repo, so a start in that repo is refused at once", SLOW, async () => {
    const { client } = await engine(scripted([{ writes: {} }]));
    expect(await client.command({ type: "remove_repo", repoId: "orders-api" })).toEqual({ ok: true, data: null });
    const setup = await client.query({ type: "setup" });
    expect(setup.ok && setup.data.repos).toEqual([]);
    const reply = await client.command({ type: "start_item", templateId: "builtin/quick-fix", repoIds: ["orders-api"], text: "Fix it" });
    expect(reply).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("refuses what D0 cannot run, with a reason, and starts nothing", SLOW, async () => {
    const { client } = await engine(scripted([{ writes: {} }]));
    const refused = async (command: Partial<Extract<CommandInput, { type: "start_item" }>>) => {
      const reply = await client.command({ type: "start_item", templateId: "builtin/quick-fix", repoIds: ["orders-api"], text: "Fix it", ...command });
      return reply.ok ? "started" : `${reply.error.code}: ${reply.error.message}`;
    };
    expect(await refused({ options: { askBeforeCloud: true } })).toMatch(/^invalid_request: Ask before cloud steps is not available yet/);
    expect(await refused({ repoIds: [] })).toMatch(/^invalid_request: .*needs a repo/);
    expect(await refused({ repoIds: ["orders-api", "orders-api"] })).toMatch(/^invalid_request: .*one repo/);
    expect(await refused({ repoIds: ["billing"] })).toMatch(/^not_found/);
    expect(await refused({ templateId: "builtin/nothing" })).toMatch(/^not_found/);

    // An ollama agent and a broken agent file: the templates still list, with a warning, and refuse to start.
    mkdirSync(join(home, "agents"));
    writeFileSync(join(home, "agents", "builder.md"), "---\nformat: 1\nname: Builder\nruns_on: ollama\ndriven_by: claude-code\nmodel: qwen3-coder\ntools: edit\n---\nYou fix things.\n");
    expect(await refused({})).toMatch(/^invalid_request: Step Fix cannot run: builder runs on ollama/);
    writeFileSync(join(home, "agents", "builder.md"), "---\nformat: 1\nname: Builder\nruns_on: claude-code\nmodel: sonnet\ntools: everything\n---\n");
    expect(await refused({})).toMatch(/^invalid_request: Step Fix cannot run: agents\/builder.md line \d+/);
    const setup = await client.query({ type: "setup" });
    if (!setup.ok) throw new Error(setup.error.message);
    expect(setup.data.templates.find((t) => t.id === "builtin/quick-fix")?.warnings).toEqual([expect.stringMatching(/^Step Fix cannot run: agents\/builder.md/)]);
    expect(setup.data.health.config).toContainEqual({ file: "agents/builder.md", message: expect.stringMatching(/^agents\/builder.md line \d+/) });
    const board = await client.query({ type: "board" });
    expect(board.ok && board.data.items).toEqual([]);
  });
});
