import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { systemClock, type Clock } from "../../kernel/clock/index.js";
import { createGit, type Git } from "../../kernel/git/index.js";
import type { AgentRuntime } from "../../kernel/ports/index.js";
import { createProcessRunner, type ProcessRunner } from "../../kernel/process/index.js";
import type { ProcessTable } from "../../kernel/process/leftover.js";
import {
  HostIdSchema,
  parseTemplateRecord,
  TemplateRecordSchema,
  type AgentId,
  type ItemActivity,
  type ItemEvent,
  type ItemId,
  type RepoId,
  type StoredItem,
  type TemplateRecord,
} from "../../kernel/schemas/index.js";
import type { Agent, Repo } from "../config/index.js";
import { EVENTS_FILE, foldItem, ItemStore, openDecisions, readLog } from "../items/index.js";
import { createWorktree } from "../worktrees/index.js";
import { createRunLoop, parseVerdict, type RunLoop, type RunLoopDeps } from "./index.js";
import { after, type Behavior, crashes, edits, editsThenCrashes, editsThenHangs, FAKE_PID, fakeRuntime, hangs, loops, says } from "./testing/fake-runtime.js";

const SLOW = { timeout: 60_000 };
const HOST = HostIdSchema.parse("host_0190a000-0000-7000-8000-000000000001");
const BOOT = Date.UTC(2026, 10, 1);
const FIXED = { "app.txt": "fixed\n" };
const WRONG = { "app.txt": "still broken\n" };

let root: string;
let tokamaHome: string;
let repo: Repo;
let store: ItemStore;
let git: Git;
let runner: ProcessRunner;
let clockOffset: number;
const clock: Clock = { ...systemClock, now: () => Date.now() + clockOffset };
const table: ProcessTable = { list: async () => [], bootTime: () => BOOT, signalGroup: () => undefined };

/** Plain git for fixtures and assertions, never through the wrapper. */
async function plain(cwd: string, ...args: string[]): Promise<string> {
  const out: string[] = [];
  const result = await runner.run({ command: { argv: ["git", ...args] }, cwd, env: { GIT_CONFIG_NOSYSTEM: "1" }, stdout: { onLine: (line) => out.push(line) } });
  if (result.kind !== "finished" || result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return out.join("\n");
}

const agent = (id: string, edit = true): Agent => ({
  id: id as AgentId,
  name: id,
  cliId: "ollama",
  drivenBy: "claude-code",
  model: "qwen3-coder",
  limits: { edit, commands: [], web: false },
  role: `You are ${id}.`,
  owner: { kind: "builtin" },
});
const AGENTS: Record<string, Agent> = { builder: agent("builder"), reviewer: agent("reviewer", false) };

type StepInput = { id: string } & Record<string, unknown>;
function template(steps: readonly StepInput[], extra: Record<string, unknown> = {}): TemplateRecord {
  return TemplateRecordSchema.parse({
    schemaVersion: 2,
    ref: "orders-api/quick-fix",
    id: "quick-fix",
    source: { kind: "builtin" },
    name: "Quick fix",
    uses: { repos: { picked: "edit", named: [] }, connections: [], commands: [] },
    start: { needs: ["text", "repo"], askBeforeCloud: false, notify: false },
    finish: ["commit"],
    ...extra,
    steps: steps.map((step) => ({
      name: step.id,
      agentId: "builder",
      instructions: { text: `Do the ${step.id} step.` },
      doneWhen: "agent finishes",
      ifFailed: { action: "ask" },
      maxAttempts: 1,
      data: "none",
      sees: [],
      connections: [],
      commands: [],
      ...step,
    })),
  });
}
const BUILD_CHECKED: StepInput = { id: "build", doneWhen: "checks pass", checks: { from: "repo" }, ifFailed: { action: "retry" }, maxAttempts: 3 };

function engine(runtime: AgentRuntime, overrides: Partial<RunLoopDeps> = {}): RunLoop {
  return createRunLoop({
    store,
    git,
    runner,
    clock,
    processes: table,
    repo: (id) => (id === repo.id ? repo : undefined),
    agent: (_repo, id) => AGENTS[id],
    runtime: () => runtime,
    guard: { turnCap: 150, repeatLimit: 6, idleMs: 0, silentMs: 0, toolSilentMs: 0, timeoutMs: 60_000 },
    recoveryGraceMs: 0,
    ...overrides,
  });
}

async function start(loop: RunLoop, tpl: TemplateRecord, text = "Fix the app\nIt is broken."): Promise<ItemId> {
  const started = await loop.startItem({ template: tpl, repoId: repo.id, text });
  if (!started.ok) throw new Error(started.error.message);
  await loop.settled(started.value);
  return started.value;
}

const item = (id: ItemId): StoredItem => store.get(id)!;

function log(id: ItemId): ItemEvent[] {
  const read = readLog(join(tokamaHome, "items", id, EVENTS_FILE));
  if (!read.ok) throw new Error(read.error.message);
  return read.value.events;
}

/** The log as short lines, e.g. `attempt_ended build#1 failed`. */
function story(id: ItemId): string[] {
  return log(id).flatMap((event) => {
    switch (event.type) {
      case "step_started":
      case "step_ended":
        return [`${event.type} ${event.stepId}${event.type === "step_ended" ? ` ${event.result}` : ""}`];
      case "attempt_started":
        return [`attempt ${event.stepId}#${event.attempt}`];
      case "attempt_ended":
        return [`attempt_ended ${event.stepId}#${event.attempt} ${event.result}${event.failure ? ` ${event.failure}` : ""}`];
      case "check_result":
        return [`check ${event.command} ${event.passed ? "passed" : `exit ${event.exitCode}`}`];
      case "decision_opened":
        return [`decision ${event.kind}${event.stepId ? ` ${event.stepId}` : ""}`];
      case "decision_resolved":
        return [`resolved ${event.choice}`];
      case "item_ended":
        return [`item_ended ${event.outcome}`];
      default:
        return [event.type];
    }
  });
}

/** Answers the item's only open decision and waits for the loop. */
async function answer(loop: RunLoop, id: ItemId, choice: string, kind?: string): Promise<void> {
  const open = openDecisions(item(id)).filter((d) => kind === undefined || d.kind === kind);
  expect(open, `open decisions of ${id}`).toHaveLength(1);
  const resolved = await loop.resolveDecision(id, open[0]!.id, choice);
  if (!resolved.ok) throw new Error(resolved.error.message);
  await loop.settled(id);
}

const worktreeDir = (id: ItemId) => join(repo.path, ...item(id).worktrees[0]!.dir.split("/"));
const openDecision = (id: ItemId) => openDecisions(item(id))[0];

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tokama-run-loop-")));
  tokamaHome = join(root, "tokama");
  const home = join(root, "home");
  const path = join(root, "orders-api");
  for (const dir of [tokamaHome, home, path, join(path, "tools")]) mkdirSync(dir, { recursive: true });
  runner = createProcessRunner({ parentEnv: { PATH: process.env["PATH"], HOME: home } });
  git = createGit({ runner });
  clockOffset = 0;
  writeFileSync(join(path, "app.txt"), "broken\n");
  // The check prints where it runs, passes once app.txt says fixed, then writes a file of its own.
  writeFileSync(join(path, "check.sh"), "pwd\ngrep -q fixed app.txt || exit 3\necho ran > check-output.txt\n");
  writeFileSync(join(path, ".gitignore"), "node_modules/\n");
  // Like an installer, setup leaves a file that is already there alone.
  writeFileSync(join(path, "setup.sh"), "mkdir -p node_modules/.bin\n[ -f node_modules/.bin/runner ] || cp tools/runner.sh node_modules/.bin/runner\n");
  writeFileSync(join(path, "tools", "runner.sh"), "grep -q fixed app.txt\n");
  await plain(path, "init", "-q", "-b", "main");
  await plain(path, "config", "user.name", "Test");
  await plain(path, "config", "user.email", "test@example.com");
  await plain(path, "add", "-A");
  await plain(path, "commit", "-q", "-m", "seed");
  repo = { id: "orders-api" as RepoId, path, baseBranch: "main", worktreeFolder: ".tokama/wt", checks: ["sh check.sh"] };
  store = ItemStore.open({ home: tokamaHome, hostId: HOST, clock }).store;
}, SLOW.timeout);

afterEach(() => {
  try {
    // Events may sync later: no event holds a path of this machine, whatever git, a check or the
    // agent printed.
    const items = join(tokamaHome, "items");
    for (const id of existsSync(items) ? readdirSync(items) : []) {
      const events = readFileSync(join(items, id, EVENTS_FILE), "utf8");
      expect(events).not.toContain(root);
      expect(events).not.toContain(root.replace(/^\/private/, ""));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("run loop: done_when", () => {
  it("checks pass: runs the agent, cleans, stages, checks, and commits exactly the staged tree", SLOW, async () => {
    const runtime = fakeRuntime([edits(FIXED)]);
    const loop = engine(runtime);
    const id = await start(loop, template([BUILD_CHECKED]));
    expect(story(id)).toEqual([
      "item_created",
      "worktree_added",
      "baseline_recorded",
      "step_started build",
      "attempt build#1",
      "process_started",
      "usage_recorded",
      "process_started",
      "check sh check.sh passed",
      "attempt_ended build#1 passed",
      "step_ended build passed",
      "item_ended done",
    ]);
    const events = log(id);
    const agentProcess = events.find((e) => e.type === "process_started" && e.role === "agent");
    expect(agentProcess).toMatchObject({ pid: FAKE_PID, pgid: FAKE_PID, bootTime: BOOT });
    expect(events.find((e) => e.type === "process_started" && e.role === "check")).toMatchObject({ pgid: expect.any(Number) });

    // The commit Tokama recorded is the branch tip, with the tree the checks ran on and the base as parent.
    const done = item(id);
    const commit = done.outcome?.commits?.[0]?.commit;
    expect(done.state).toBe("done");
    expect(commit).toBe(await plain(repo.path, "rev-parse", done.worktrees[0]!.branch));
    expect(await plain(repo.path, "rev-parse", `${commit}^{tree}`)).toBe(done.steps[0]?.attempts[0]?.tree);
    expect(await plain(repo.path, "rev-parse", `${commit}^`)).toBe(await plain(repo.path, "rev-parse", "main"));
    expect(await plain(repo.path, "show", `${commit}:app.txt`)).toBe("fixed");
    // The attempt's end says its transcript was saved and how large the file is, so no one has to read it to know.
    expect(done.steps[0]?.attempts[0]).toMatchObject({ transcriptSaved: true, transcriptBytes: statSync(join(tokamaHome, "items", id, "attempts", "build-1", "transcript.txt")).size });
    // The check wrote check-output.txt after the tree was fixed: it is in the worktree, not the commit.
    expect(existsSync(join(worktreeDir(id), "check-output.txt"))).toBe(true);
    expect(await plain(repo.path, "ls-tree", "--name-only", commit!)).not.toContain("check-output.txt");
    // The agent got the item text, its role and the Tokama rules, in the worktree.
    expect(runtime.calls[0]?.request).toMatchObject({ cwd: worktreeDir(id), model: "qwen3-coder", timeoutMs: 60_000 });
    expect(runtime.calls[0]?.request.prompt).toContain("Fix the app");
    expect(runtime.calls[0]?.request.role).toContain("You are builder.");
    // Its commands write only the worktree and reach only the package registries.
    expect(runtime.calls[0]?.request.sandbox).toEqual({
      writableRoot: worktreeDir(id),
      readOnlyRoots: [],
      network: { allow: expect.arrayContaining(["registry.npmjs.org"]), unlisted: "deny" },
    });
  });

  it("reports what the item does now: the agent's actions, then Tokama running each command, and nothing once each ends", SLOW, async () => {
    const seen: Array<ItemActivity | undefined> = [];
    const loop = engine(fakeRuntime([edits(FIXED)]), { onActivity: (_id, activity) => seen.push(activity) });
    const id = await start(loop, template([BUILD_CHECKED], { setup: "sh setup.sh" }));
    const agent = seen.filter((activity) => activity?.by === "agent");
    expect(agent[0]).toMatchObject({ itemId: id, stepIndex: 0, attempt: 1, lastAction: { kind: "think", label: "thinking" }, toolRunning: null });
    expect(agent).toContainEqual(expect.objectContaining({ lastAction: { kind: "edit", label: "editing app.txt" }, toolRunning: { label: "editing app.txt", startedAt: expect.any(Number) } }));
    const tokama = seen.filter((activity) => activity?.by === "tokama");
    expect(tokama.map((activity) => activity?.toolRunning?.label)).toEqual(["running sh setup.sh", "running sh check.sh"]);
    expect(tokama[1]).toMatchObject({ lastAction: { kind: "run", label: "running sh check.sh" } });
    // The agent call, the setup and the check each end with nothing running.
    expect(seen.filter((activity) => activity === undefined)).toHaveLength(3);
    expect(seen.at(-1)).toBeUndefined();
    // Live activity is never written to the item's log.
    expect(log(id).map((event) => event.type)).not.toContain("activity");
  });

  it("agent finishes: the step passes when the agent completes; with no checks, Finish commits the worktree", SLOW, async () => {
    const loop = engine(fakeRuntime([edits(FIXED)]));
    const id = await start(loop, template([{ id: "build" }]));
    expect(item(id).state).toBe("done");
    expect(await plain(repo.path, "show", `${item(id).outcome?.commits?.[0]?.commit}:app.txt`)).toBe("fixed");
  });

  it("records what each call used in the item's log: tokens per model, the CLI's cost, wall time and the last plan windows", SLOW, async () => {
    const spends: Behavior = async function* () {
      yield { type: "rate_limit", status: "allowed", windows: [{ window: "five_hour", usedPercent: 12 }] };
      yield { type: "rate_limit", status: "allowed_warning", windows: [{ window: "five_hour", usedPercent: 81, resetsAt: BOOT + 3_600_000 }] };
      yield { type: "text", text: "Done." };
      const tokens = { input: 10, output: 5, cacheRead: 100, cacheWrite: 2 };
      yield { type: "end", outcome: "completed", usage: tokens, modelUsage: { "qwen3-coder": tokens }, costUsd: 0.12 };
    };
    const loop = engine(fakeRuntime([spends]));
    const id = await start(loop, template([{ id: "build" }]));
    const [call, ...rest] = item(id).calls ?? [];
    expect(rest).toEqual([]);
    expect(call).toMatchObject({
      callId: expect.stringMatching(/^call_/),
      stepId: "build",
      attempt: 1,
      agentId: "builder",
      cliId: "ollama",
      model: "qwen3-coder",
      outcome: "completed",
      tokens: { input: 10, output: 5, cacheRead: 100, cacheWrite: 2 },
      models: { "qwen3-coder": { input: 10, output: 5, cacheRead: 100, cacheWrite: 2 } },
      reportedCostUsd: 0.12,
      plan: { status: "allowed_warning", windows: [{ window: "five_hour", usedPercent: 81, resetsAt: BOOT + 3_600_000 }] },
    });
    expect(call!.endedAt).toBeGreaterThanOrEqual(call!.startedAt);
    // The event is in the log itself, so usage can be read from it.
    const read = readLog(join(tokamaHome, "items", id, EVENTS_FILE));
    if (!read.ok) throw new Error(read.error.message);
    const logged = read.value.events.filter((event: ItemEvent) => event.type === "usage_recorded");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ hostId: HOST, itemId: id });
  });

  it("you approve: waits on plan_approval; Approve passes the step", SLOW, async () => {
    const loop = engine(fakeRuntime([edits(FIXED)]));
    const id = await start(loop, template([{ id: "plan", doneWhen: "you approve" }]));
    expect(item(id).state).toBe("needs_you");
    expect(openDecision(id)).toMatchObject({ kind: "plan_approval", stepId: "plan" });
    await answer(loop, id, "approve");
    expect(story(id).slice(-5)).toEqual(["attempt_ended plan#1 passed", "decision plan_approval plan", "resolved approve", "step_ended plan passed", "item_ended done"]);
  });

  it("step output: serves each attempt's final agent message as text, capped, with no path in its errors", SLOW, async () => {
    const plan = "# Plan\n\n- add a retry\n- test it\n";
    const loop = engine(fakeRuntime([says(plan), says("x".repeat(70_000)), says("unused")]));
    const id = await start(loop, template([{ id: "plan", doneWhen: "you approve", maxAttempts: 3 }]));
    expect(await loop.stepOutput(id, 0)).toEqual({ ok: true, value: { attempt: 1, text: plan, truncated: false } });
    await answer(loop, id, "request_changes");
    // The latest attempt by default, any attempt by number; the text stops at the cap.
    const latest = await loop.stepOutput(id, 0);
    expect(latest.ok && { attempt: latest.value.attempt, length: latest.value.text.length, truncated: latest.value.truncated }).toEqual({ attempt: 2, length: 64 * 1024, truncated: true });
    expect(await loop.stepOutput(id, 0, 1)).toMatchObject({ ok: true, value: { attempt: 1, text: plan } });
    expect(await loop.stepOutput(id, 0, 1)).not.toHaveProperty("value.tail");
    expect(await loop.stepOutput(id, 0, 3)).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await loop.stepOutput(id, 1)).toMatchObject({ ok: false, error: { code: "not_found" } });

    const attempts = join(tokamaHome, "items", id, "attempts");
    // A 200 KiB output: the head stops at the cap, the tail holds its last lines, verdict included.
    const long = `**Must change**\n1. \`a.ts:3\` add a test.\n\n${"filler line\n".repeat(200 * 100)}VERDICT: changes\n`;
    writeFileSync(join(attempts, "plan-2", "agent.txt"), long);
    const cut = await loop.stepOutput(id, 0, 2);
    if (!cut.ok) throw new Error(cut.error.message);
    expect({ length: cut.value.text.length, truncated: cut.value.truncated }).toEqual({ length: 64 * 1024, truncated: true });
    expect(cut.value.text.startsWith("**Must change**")).toBe(true);
    expect(cut.value.tail?.endsWith("filler line\nVERDICT: changes")).toBe(true);
    expect(cut.value.tail!.length).toBeLessThanOrEqual(16 * 1024);

    unlinkSync(join(attempts, "plan-1", "agent.txt"));
    expect(await loop.stepOutput(id, 0, 1)).toEqual({ ok: false, error: { code: "not_found", message: "Attempt 1 has no saved output." } });
    writeFileSync(join(attempts, "plan-2", "agent.txt"), Buffer.from([0x61, 0x00, 0xff, 0xfe]));
    const binary = await loop.stepOutput(id, 0, 2);
    expect(binary).toEqual({ ok: false, error: { code: "invalid_state", message: "The output of attempt 2 is not text." } });
  });

  it("you approve: Request changes starts another attempt; End: no action needed ends the item early without failing", SLOW, async () => {
    const loop = engine(fakeRuntime([edits(FIXED)]));
    const id = await start(loop, template([{ id: "plan", doneWhen: "you approve", maxAttempts: 2 }]));
    await answer(loop, id, "request_changes");
    expect(item(id).steps[0]?.attempts).toHaveLength(2);
    await answer(loop, id, "no_action_needed");
    expect(item(id)).toMatchObject({ state: "done", outcome: { kind: "no_action_needed" } });
    expect(item(id).outcome?.commits).toBeUndefined();
  });

  it("you approve: the question carries the staged tree; Approve commits exactly that tree", SLOW, async () => {
    const loop = engine(fakeRuntime([edits({ ...FIXED, "notes.txt": "new\n" })]));
    const id = await start(loop, template([{ id: "change", doneWhen: "you approve", maxAttempts: 3 }]));
    const asked = openDecision(id)!;
    expect(asked).toMatchObject({ kind: "plan_approval", stepId: "change", tree: expect.stringMatching(/^[0-9a-f]{40,64}$/) });
    expect(asked.choices.map((c) => c.id)).toEqual(["approve", "request_changes", "no_action_needed", "stop"]);

    const diff = await loop.decisionDiff(id, asked.id);
    if (!diff.ok) throw new Error(diff.error.message);
    expect(diff.value.worktree).toEqual({ repoId: "orders-api", dir: item(id).worktrees[0]!.dir, branch: item(id).worktrees[0]!.branch, baseCommit: item(id).worktrees[0]!.baseCommit });
    // The question says what Approve does: this last step commits.
    expect(asked).toMatchObject({ detail: "builder changed 2 files in a worktree of orders-api. Nothing is committed until you approve. Request changes sends your note to builder for another run." });
    expect(asked.choices[0]?.label).toBe("Approve and commit");
    expect(asked.change).toEqual({ files: 2 });
    expect(diff.value.files.map((f) => [f.path, f.status, f.added, f.removed])).toEqual([
      ["app.txt", "modified", 1, 1],
      ["notes.txt", "added", 1, 0],
    ]);
    expect(diff.value.files[0]?.hunks[0]?.lines).toEqual(["-broken", "+fixed"]);

    await answer(loop, id, "approve");
    const commit = item(id).outcome?.commits?.[0]?.commit;
    expect(item(id).state).toBe("done");
    expect(await plain(repo.path, "rev-parse", `${commit}^{tree}`)).toBe(asked.tree);
    // The question is answered: its diff is no longer served.
    expect(await loop.decisionDiff(id, asked.id)).toMatchObject({ ok: false, error: { code: "stale_decision" } });
  });

  it("you approve: Request changes runs the step again with your note; the attempt limit applies as usual", SLOW, async () => {
    const runtime = fakeRuntime([edits(WRONG), edits(FIXED)]);
    const loop = engine(runtime);
    const id = await start(loop, template([{ id: "change", doneWhen: "you approve", maxAttempts: 2 }]));
    const first = openDecision(id)!;
    expect(await loop.resolveDecision(id, first.id, "approve", "a note")).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    const resolved = await loop.resolveDecision(id, first.id, "request_changes", "  Say fixed, not still broken.  ");
    if (!resolved.ok) throw new Error(resolved.error.message);
    await loop.settled(id);
    expect(item(id).decisions[0]?.resolved).toMatchObject({ choice: "request_changes", note: "Say fixed, not still broken." });
    expect(runtime.calls[1]?.request.prompt).toContain("You asked for changes:\nSay fixed, not still broken.");
    expect(runtime.calls[0]?.request.prompt).not.toContain("You asked for changes");

    // The second answer is at the limit of 2: the limit question comes, not a third attempt.
    await answer(loop, id, "request_changes", "plan_approval");
    expect(openDecision(id)).toMatchObject({ kind: "after_failure", detail: expect.stringContaining("limit of 2") });
    expect(item(id).steps[0]?.attempts).toHaveLength(2);
  });

  it("you approve: a step that changed nothing records no tree, so a later step's changes are committed", SLOW, async () => {
    const loop = engine(fakeRuntime([says("A plan."), edits(FIXED)]));
    const id = await start(loop, template([{ id: "plan", doneWhen: "you approve" }, { id: "build" }]));
    const asked = openDecision(id)!;
    const diff = await loop.decisionDiff(id, asked.id);
    expect(diff).toMatchObject({ ok: true, value: { files: [], moreFiles: 0, cut: false } });
    // A plan approval: it records that no file changed, keeps the tree it approves, and names the step that starts.
    expect(asked.change).toEqual({ files: 0 });
    expect(asked.tree).toBe(await plain(repo.path, "rev-parse", "main^{tree}"));
    expect(asked.detail).toMatch(/^builder finished step .+\. .+ starts after you approve\.$/);
    expect(asked.detail).not.toContain("changed 0 files");
    expect(item(id).steps[0]?.attempts[0]?.tree).toBeUndefined();
    await answer(loop, id, "approve");
    expect(item(id).state).toBe("done");
    expect(await plain(repo.path, "show", `${item(id).outcome?.commits?.[0]?.commit}:app.txt`)).toBe("fixed");
  });

  it("you approve: a tree that differs from the base is a change with files even when the file list is empty", SLOW, async () => {
    const empty = { ...git, diffFiles: async () => ({ ok: true as const, value: [] }) };
    const loop = engine(fakeRuntime([edits(FIXED)]), { git: empty });
    const id = await start(loop, template([{ id: "change", doneWhen: "you approve", maxAttempts: 3 }]));
    const asked = openDecision(id)!;
    expect(asked.tree).not.toBe(await plain(repo.path, "rev-parse", "main^{tree}"));
    expect(asked.change).toEqual({ files: 1 });
    expect(asked.detail).toContain("Nothing is committed until you approve");
    expect(asked.detail).not.toContain("changed 0 files");
    expect(asked.choices[0]?.label).toBe("Approve and commit");
  });

  it("you approve: a change reverted after Request changes is not committed; the item ends with nothing to commit", SLOW, async () => {
    const loop = engine(fakeRuntime([edits(FIXED), edits({ "app.txt": "broken\n" })]));
    const id = await start(loop, template([{ id: "change", doneWhen: "you approve", maxAttempts: 3 }]));
    await answer(loop, id, "request_changes");
    const asked = openDecision(id)!;
    expect(await loop.decisionDiff(id, asked.id)).toMatchObject({ ok: true, value: { files: [] } });
    await answer(loop, id, "approve");
    expect(item(id)).toMatchObject({ state: "done", outcome: { kind: "done", detail: "The item made no changes, so there is nothing to commit." } });
    expect(item(id).outcome?.commits).toBeUndefined();
  });

  it("you approve: a step that changed nothing, then files planted before Approve: Finish asks, and commits only the approved (empty) change", SLOW, async () => {
    const loop = engine(fakeRuntime([says("Nothing to change.")]));
    const id = await start(loop, template([{ id: "change", doneWhen: "you approve", maxAttempts: 3 }]));
    const asked = openDecision(id)!;
    expect(asked.tree).toBe(await plain(repo.path, "rev-parse", "main^{tree}"));
    expect(await loop.decisionDiff(id, asked.id)).toMatchObject({ ok: true, value: { files: [] } });
    writeFileSync(join(worktreeDir(id), "app.txt"), "planted after approval question\n");
    writeFileSync(join(worktreeDir(id), "evil.js"), "require('child_process')\n");
    await answer(loop, id, "approve");
    expect(openDecision(id)).toMatchObject({ kind: "tamper", detail: expect.stringContaining("changed after you approved it") });
    expect(openDecision(id)?.detail).toContain("evil.js");
    await answer(loop, id, "commit_checked_tree");
    expect(item(id)).toMatchObject({ state: "done", outcome: { detail: "The item made no changes, so there is nothing to commit." } });
    expect(item(id).outcome?.commits).toBeUndefined();
  });

  it("you approve: a step that wrote a file, then a step with no checks: Finish commits both steps' work", SLOW, async () => {
    const loop = engine(fakeRuntime([edits({ "PLAN.md": "plan\n" }), edits(FIXED)]));
    const id = await start(loop, template([{ id: "plan", doneWhen: "you approve" }, { id: "build" }]));
    await answer(loop, id, "approve");
    const commit = item(id).outcome?.commits?.[0]?.commit;
    expect(item(id).state).toBe("done");
    expect(await plain(repo.path, "show", `${commit}:PLAN.md`)).toBe("plan");
    expect(await plain(repo.path, "show", `${commit}:app.txt`)).toBe("fixed");
  });

  it("you approve: a file changed after the approval is not committed unless you say so", SLOW, async () => {
    const loop = engine(fakeRuntime([edits(FIXED)]));
    const id = await start(loop, template([{ id: "change", doneWhen: "you approve" }]));
    const approvedTree = openDecision(id)!.tree;
    writeFileSync(join(worktreeDir(id), "app.txt"), "edited by hand\n");
    await answer(loop, id, "approve");
    expect(openDecision(id)).toMatchObject({ kind: "tamper", detail: expect.stringContaining("changed after you approved it"), choices: [{ id: "commit_checked_tree", label: "Commit the approved tree" }, { id: "stop" }] });
    await answer(loop, id, "commit_checked_tree");
    expect(await plain(repo.path, "rev-parse", `${item(id).outcome?.commits?.[0]?.commit}^{tree}`)).toBe(approvedTree);
  });

  it("you approve: a package file change asks about it before the approval", SLOW, async () => {
    const loop = engine(fakeRuntime([edits({ ...FIXED, "package.json": "{}\n" })]));
    const id = await start(loop, template([{ id: "change", doneWhen: "you approve" }]));
    expect(openDecision(id)).toMatchObject({ kind: "tamper", stepId: "change" });
    await answer(loop, id, "approve", "tamper");
    expect(openDecision(id)).toMatchObject({ kind: "plan_approval", stepId: "change" });
  });

  it("reviewer approves: changes go back to build with the reviewer's words; build's attempt numbers continue; approve finishes", SLOW, async () => {
    const builder = fakeRuntime([edits(FIXED), edits({ "app.txt": "fixed\nwith a test\n" })]);
    const reviewer = fakeRuntime([says("Add a test.\nVERDICT: changes"), says("Looks good.\n\nVERDICT: approve")]);
    const loop = engine(builder, { runtime: (a) => (a.id === "reviewer" ? reviewer : builder) });
    const tpl = template([
      { id: "build", maxAttempts: 2 },
      { id: "review", agentId: "reviewer", doneWhen: "reviewer approves", ifChangesRequested: { action: "back", stepId: "build" }, maxAttempts: 2 },
    ]);
    const id = await start(loop, tpl);
    expect(story(id).filter((line) => line.startsWith("attempt") || line.startsWith("step") || line.startsWith("item_ended"))).toEqual([
      "step_started build",
      "attempt build#1",
      "attempt_ended build#1 passed",
      "step_ended build passed",
      "step_started review",
      "attempt review#1",
      "attempt_ended review#1 failed",
      "step_ended review failed",
      "step_started build",
      "attempt build#2",
      "attempt_ended build#2 passed",
      "step_ended build passed",
      "step_started review",
      "attempt review#2",
      "attempt_ended review#2 passed",
      "step_ended review passed",
      "item_ended done",
    ]);
    // The reviewer sees the raw diff, gets the verdict rule, and cannot edit.
    expect(reviewer.calls[0]?.request.prompt).toContain("+fixed");
    expect(reviewer.calls[0]?.request.prompt).toContain("VERDICT: approve");
    expect(reviewer.calls[0]?.request.limits?.edit).toBe(false);
    // The builder's second session gets the reviewer's words, in their own block.
    expect(builder.calls[1]?.request.prompt).toContain('name="feedback from review"');
    expect(builder.calls[1]?.request.prompt).toContain("Add a test.");
    expect(builder.calls[1]?.request.prompt).not.toContain("last check output");
  });

  it("review asks for changes, the build fixes them, and the review runs again (max_attempts 1) and passes; the log replays to the same counters", SLOW, async () => {
    const builder = fakeRuntime([says("Plan: fix app.txt."), edits(WRONG), edits(FIXED)]);
    const reviewer = fakeRuntime([says("A layout shift remains.\nVERDICT: changes"), says("Fixed.\nVERDICT: approve")]);
    const loop = engine(builder, { runtime: (a) => (a.id === "reviewer" ? reviewer : builder) });
    const tpl = template([
      { id: "plan", doneWhen: "you approve" },
      { ...BUILD_CHECKED, checks: { commands: ["grep -q fixed app.txt"] }, maxAttempts: 1, ifFailed: { action: "ask" } },
      { id: "review", agentId: "reviewer", doneWhen: "reviewer approves", ifChangesRequested: { action: "back", stepId: "build" }, maxAttempts: 1 },
    ]);
    const id = await start(loop, tpl);
    await answer(loop, id, "approve");
    // build#1 fails its check: the default if_failed asks; Retry step.
    await answer(loop, id, "retry_step");
    expect(story(id).filter((line) => /^(step_|attempt |attempt_ended|decision|item_ended)/.test(line))).toEqual([
      "step_started plan",
      "attempt plan#1",
      "attempt_ended plan#1 passed",
      "decision plan_approval plan",
      "step_ended plan passed",
      "step_started build",
      "attempt build#1",
      "attempt_ended build#1 failed",
      "decision after_failure build",
      "attempt build#2",
      "attempt_ended build#2 passed",
      "step_ended build passed",
      "step_started review",
      "attempt review#1",
      "attempt_ended review#1 failed",
      "step_ended review failed",
      "step_started build",
      "attempt build#3",
      "attempt_ended build#3 passed",
      "step_ended build passed",
      "step_started review",
      "attempt review#2",
      "attempt_ended review#2 passed",
      "step_ended review passed",
      "item_ended done",
    ]);
    expect(reviewer.calls[1]?.request.prompt).toContain("+fixed");
    // The same counters from the log alone, and after a restart.
    const replayed = foldItem(log(id));
    if (!replayed.ok) throw new Error(replayed.error.message);
    expect(replayed.value).toEqual(item(id));
    expect(ItemStore.open({ home: tokamaHome, hostId: HOST, clock }).store.get(id)).toEqual(item(id));
    expect(item(id).steps.map((s) => [s.id, s.attempts.length, s.roundStart, s.sentBack])).toEqual([
      ["plan", 1, undefined, undefined],
      ["build", 3, 2, undefined],
      ["review", 2, 1, 1],
    ]);
  });

  it("reviewer approves: a reply without a strict verdict line is a run failure, not counted", SLOW, async () => {
    const reviewer = fakeRuntime([says("I approve this change."), says("VERDICT: approve")]);
    const builder = fakeRuntime([edits(FIXED)]);
    const loop = engine(builder, { runtime: (a) => (a.id === "reviewer" ? reviewer : builder) });
    const id = await start(loop, template([{ id: "build" }, { id: "review", agentId: "reviewer", doneWhen: "reviewer approves" }]));
    expect(openDecision(id)).toMatchObject({ kind: "run_failure", stepId: "review" });
    expect(item(id).steps[1]?.attempts[0]).toMatchObject({ result: "run_failed", failure: "crash" });
    await answer(loop, id, "retry_step");
    expect(item(id).state).toBe("done");
    expect(parseVerdict("verdict: approve")).toBeUndefined();
    expect(parseVerdict("VERDICT: approve\nThanks")).toBeUndefined();
    expect(parseVerdict("ok\nVERDICT: changes  \n\n")).toBe("changes");
  });
});

describe("run loop: the template snapshot of an item", () => {
  it("runs an item whose snapshot is a stored version 1 record", SLOW, async () => {
    const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "kernel", "schemas", "testing", "fixtures", "template-snapshot-v1.json"), "utf8")) as { record: unknown };
    const parsed = parseTemplateRecord(fixture.record);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
    const loop = engine(fakeRuntime([says("A plan.")]), { agent: (_repo, id) => AGENTS[id] ?? agent(id) });
    const id = await start(loop, parsed.value);
    expect(item(id).state).toBe("needs_you");
    expect(openDecision(id)).toMatchObject({ kind: "plan_approval", stepId: "plan" });
  });

  it("waits with Retry step / Stop for an item whose snapshot a newer Tokama wrote, and does not end it", SLOW, async () => {
    const newer = { ...template([BUILD_CHECKED]), schemaVersion: 99 } as unknown as TemplateRecord;
    const id = await start(engine(fakeRuntime([edits(FIXED)])), newer);
    expect(item(id).state).toBe("needs_you");
    expect(item(id).outcome).toBeUndefined();
    expect(openDecision(id)).toMatchObject({
      kind: "run_failure",
      detail: "This item was started by a newer Tokama (template record version 99). Update Tokama to open it.",
    });
    expect(openDecision(id)?.choices.map((c) => c.id)).toEqual(["retry_step", "stop"]);
  });
});

describe("run loop: counters", () => {
  it("retry adds an attempt with the last check output; it passes on the second attempt", SLOW, async () => {
    const runtime = fakeRuntime([edits(WRONG), edits(FIXED)]);
    const loop = engine(runtime);
    const id = await start(loop, template([BUILD_CHECKED]));
    expect(story(id).filter((line) => line.startsWith("attempt") || line.startsWith("check"))).toEqual([
      "attempt build#1",
      "check sh check.sh exit 3",
      "attempt_ended build#1 failed",
      "attempt build#2",
      "check sh check.sh passed",
      "attempt_ended build#2 passed",
    ]);
    expect(item(id).state).toBe("done");
    expect(runtime.calls[1]?.request.prompt).toContain("$ sh check.sh (exit 3)");
    // The event says what failed in Tokama's words; the output stays in the item's files.
    expect(item(id).steps[0]?.attempts[0]?.detail).toBe("`sh check.sh` exited 3.");
    expect(readFileSync(join(tokamaHome, "items", id, "attempts", "build-1", "check-1.log"), "utf8")).toBe(`${worktreeDir(id)}\n`);
    expect(JSON.parse(readFileSync(join(tokamaHome, "items", id, "attempts", "build-1", "call.json"), "utf8"))).toMatchObject({
      prompt: { stepId: "build", agentId: "builder", cloud: false },
      end: { outcome: "completed" },
      guard: { stop: null },
    });
  });

  it("the same failure twice stops early and asks; then the limit asks; Retry once more grants one attempt", SLOW, async () => {
    const loop = engine(fakeRuntime([edits(WRONG), edits(WRONG), edits(WRONG), edits(FIXED)]));
    const id = await start(loop, template([BUILD_CHECKED]));
    expect(item(id).steps[0]?.attempts).toHaveLength(2);
    expect(openDecision(id)).toMatchObject({ kind: "after_failure", detail: expect.stringContaining("twice in a row") });
    await answer(loop, id, "retry_step");
    // Attempt 3 of 3 failed: the limit.
    expect(item(id).steps[0]?.attempts).toHaveLength(3);
    expect(openDecision(id)).toMatchObject({ kind: "after_failure", detail: expect.stringContaining("limit of 3") });
    expect(openDecision(id)?.choices.map((c) => c.id)).toEqual(["one_more_attempt", "no_action_needed", "stop"]);
    await answer(loop, id, "one_more_attempt");
    expect(item(id).steps[0]?.attempts.map((a) => a.result)).toEqual(["failed", "failed", "failed", "passed"]);
    expect(item(id).state).toBe("done");
  });

  it("back starts a new round with fresh attempts; after 3 round trips it asks; Run one more round goes back once more", SLOW, async () => {
    // Each build makes the check fail another way, so it is never the same failure twice; the fifth passes.
    const verify = (code: number) => edits({ "verify.sh": "exit $(cat code.txt)\n", "code.txt": `${code}` });
    const builder = fakeRuntime([verify(4), verify(5), verify(6), verify(7), verify(0)]);
    const checker = fakeRuntime([says("Ready for the checks.")]);
    const loop = engine(builder, { runtime: (a) => (a.id === "reviewer" ? checker : builder) });
    const tpl = template([
      { id: "build", maxAttempts: 1 },
      { id: "verify", agentId: "reviewer", doneWhen: "checks pass", checks: { commands: ["sh verify.sh"] }, ifFailed: { action: "back", stepId: "build" }, maxAttempts: 1 },
    ]);
    const id = await start(loop, tpl);
    // Four rounds of build#n, verify#n: three round trips, then the question instead of a fourth.
    expect(item(id).steps.map((s) => s.attempts.length)).toEqual([4, 4]);
    expect(item(id).steps[1]).toMatchObject({ sentBack: 3, roundStart: 3 });
    const asked = openDecision(id);
    expect(asked).toMatchObject({ kind: "after_failure", stepId: "verify", detail: "verify sent the work back to build 3 times. Run one more round, or end the item." });
    expect(asked?.choices.map((c) => c.id)).toEqual(["one_more_round", "no_action_needed", "stop"]);
    await answer(loop, id, "one_more_round");
    expect(story(id).filter((line) => /^(step_|attempt |attempt_ended|resolved)/.test(line)).slice(-10)).toEqual([
      "resolved one_more_round",
      "step_ended verify failed",
      "step_started build",
      "attempt build#5",
      "attempt_ended build#5 passed",
      "step_ended build passed",
      "step_started verify",
      "attempt verify#5",
      "attempt_ended verify#5 passed",
      "step_ended verify passed",
    ]);
    expect(item(id).state).toBe("done");
  });

  it("the same failure twice asks before a send-back, also with max_attempts 1", SLOW, async () => {
    const builder = fakeRuntime([edits({ "verify.sh": "exit 4\n" })]);
    const checker = fakeRuntime([says("Ready.")]);
    const loop = engine(builder, { runtime: (a) => (a.id === "reviewer" ? checker : builder) });
    const tpl = template([
      { id: "build" },
      { id: "verify", agentId: "reviewer", doneWhen: "checks pass", checks: { commands: ["sh verify.sh"] }, ifFailed: { action: "back", stepId: "build" } },
    ]);
    const id = await start(loop, tpl);
    expect(item(id).steps.map((s) => s.attempts.length)).toEqual([2, 2]);
    expect(openDecision(id)).toMatchObject({ kind: "after_failure", stepId: "verify", detail: expect.stringContaining("twice in a row") });
  });

  it("back to the same step is a retry: no new round, so max_attempts limits it", SLOW, async () => {
    const verify = (code: number) => edits({ "verify.sh": "exit $(cat code.txt)\n", "code.txt": `${code}` });
    const loop = engine(fakeRuntime([verify(4), verify(5), verify(6)]));
    const id = await start(loop, template([{ id: "fix", doneWhen: "checks pass", checks: { commands: ["sh verify.sh"] }, ifFailed: { action: "back", stepId: "fix" }, maxAttempts: 2 }]));
    expect(item(id).steps[0]?.attempts).toHaveLength(2);
    expect(item(id).steps[0]).not.toHaveProperty("roundStart");
    expect(openDecision(id)).toMatchObject({ kind: "after_failure", detail: "Step fix reached its limit of 2 attempts." });
  });

  it("at the round-trip cap, End: no action needed ends the item", SLOW, async () => {
    const builder = fakeRuntime([edits(FIXED)]);
    const reviewer = fakeRuntime([says("Not yet.\nVERDICT: changes")]);
    const loop = engine(builder, { runtime: (a) => (a.id === "reviewer" ? reviewer : builder) });
    const tpl = template([
      { id: "build", name: "Build" },
      { id: "review", name: "Review", agentId: "reviewer", doneWhen: "reviewer approves", ifChangesRequested: { action: "back", stepId: "build" } },
    ]);
    const id = await start(loop, tpl);
    expect(openDecision(id)).toMatchObject({ stepId: "review", detail: expect.stringContaining("Review sent the work back to Build 3 times.") });
    expect(reviewer.calls).toHaveLength(4);
    await answer(loop, id, "no_action_needed");
    expect(item(id).outcome?.kind).toBe("no_action_needed");
  });

  it("retries within one round still respect max_attempts", SLOW, async () => {
    // Round 1: build#1 fails, the retry build#2 passes, review asks for changes. Round 2: build#3 and build#4 fail.
    const builder = fakeRuntime([edits(WRONG), edits(FIXED), edits(WRONG), edits(WRONG)]);
    const reviewer = fakeRuntime([says("Add a test.\nVERDICT: changes")]);
    const loop = engine(builder, { runtime: (a) => (a.id === "reviewer" ? reviewer : builder) });
    const tpl = template([
      { ...BUILD_CHECKED, checks: { commands: ["grep -q fixed app.txt"] }, maxAttempts: 2 },
      { id: "review", agentId: "reviewer", doneWhen: "reviewer approves", ifChangesRequested: { action: "back", stepId: "build" } },
    ]);
    const id = await start(loop, tpl);
    expect(item(id).steps[0]?.attempts.map((a) => a.result)).toEqual(["failed", "passed", "failed", "failed"]);
    expect(openDecision(id)).toMatchObject({ kind: "after_failure", stepId: "build", detail: "Step build reached its limit of 2 attempts." });
  });

  it("a run failure asks Retry step / Stop and does not count", SLOW, async () => {
    const loop = engine(fakeRuntime([crashes("quota", "You've hit your limit"), edits(FIXED)]));
    const id = await start(loop, template([{ ...BUILD_CHECKED, maxAttempts: 1 }]));
    expect(openDecision(id)).toMatchObject({ kind: "run_failure", stepId: "build", detail: "You've hit your limit" });
    expect(item(id).steps[0]?.attempts[0]).toMatchObject({ result: "run_failed", failure: "quota" });
    await answer(loop, id, "retry_step");
    // max_attempts is 1, and the second attempt still ran: the run failure did not count.
    expect(item(id).steps[0]?.attempts.map((a) => a.result)).toEqual(["run_failed", "passed"]);
    expect(item(id).state).toBe("done");
  });

  it("a guard timeout is a run failure: it asks and does not count", SLOW, async () => {
    const loop = engine(fakeRuntime([hangs(), edits(FIXED)]), { guard: { turnCap: 150, repeatLimit: 6, idleMs: 0, silentMs: 0, toolSilentMs: 0, timeoutMs: 300 } });
    const id = await start(loop, template([{ ...BUILD_CHECKED, maxAttempts: 1 }]));
    expect(item(id).steps[0]?.attempts[0]).toMatchObject({ result: "run_failed", failure: "timeout" });
    expect(openDecision(id)).toMatchObject({ kind: "run_failure", detail: "The agent call ran for 1 m (the limit)." });
    await answer(loop, id, "retry_step");
    expect(item(id).state).toBe("done");
  });

  it("a silent agent is a run failure: it is stopped, asks Retry step / Stop and does not count", SLOW, async () => {
    const loop = engine(fakeRuntime([hangs(), edits(FIXED)]), { guard: { turnCap: 150, repeatLimit: 6, idleMs: 0, silentMs: 300, toolSilentMs: 0, timeoutMs: 60_000 } });
    // An "agent finishes" step: without the run failure, the stopped call would pass it.
    const id = await start(loop, template([{ id: "build", agentId: "builder", doneWhen: "agent finishes", maxAttempts: 1 }]));
    expect(item(id).steps[0]?.attempts[0]).toMatchObject({ result: "run_failed", failure: "silent" });
    const asked = openDecision(id);
    expect(asked).toMatchObject({ kind: "run_failure", stepId: "build", detail: `${AGENTS["builder"]!.name} was silent for 1 m.` });
    expect(asked?.choices.map((c) => c.label)).toEqual(["Retry step", "Stop"]);
    await answer(loop, id, "retry_step");
    // max_attempts is 1, and the second attempt still ran: the silence did not count.
    expect(item(id).steps[0]?.attempts.map((a) => a.result)).toEqual(["run_failed", "passed"]);
    expect(item(id).state).toBe("done");
  });

  it("an agent frozen inside a tool call is a run failure: it is stopped, asks Retry step / Stop and does not count", SLOW, async () => {
    const loop = engine(fakeRuntime([hangs(undefined, true), edits(FIXED)]), { guard: { turnCap: 150, repeatLimit: 6, idleMs: 0, silentMs: 0, toolSilentMs: 300, timeoutMs: 60_000 } });
    const id = await start(loop, template([{ id: "build", agentId: "builder", doneWhen: "agent finishes", maxAttempts: 1 }]));
    expect(item(id).steps[0]?.attempts[0]).toMatchObject({ result: "run_failed", failure: "tool_silent" });
    const asked = openDecision(id);
    expect(asked).toMatchObject({ kind: "run_failure", stepId: "build", detail: `${AGENTS["builder"]!.name}'s command ran for 1 m with no output.` });
    expect(asked?.choices.map((c) => c.label)).toEqual(["Retry step", "Stop"]);
    await answer(loop, id, "retry_step");
    expect(item(id).steps[0]?.attempts.map((a) => a.result)).toEqual(["run_failed", "passed"]);
    expect(item(id).state).toBe("done");
  });

  it("a loop-guard stop ends the call, and done_when decides", SLOW, async () => {
    const loop = engine(fakeRuntime([loops(FIXED)]));
    const id = await start(loop, template([BUILD_CHECKED]));
    expect(item(id).steps[0]?.attempts[0]?.result).toBe("passed");
    expect(item(id).state).toBe("done");
  });

  it("if_failed: ask opens after_failure at once; if_failed: stop fails the item", SLOW, async () => {
    const asks = await start(engine(fakeRuntime([edits(WRONG)])), template([{ ...BUILD_CHECKED, ifFailed: { action: "ask" } }]));
    expect(openDecision(asks)).toMatchObject({ kind: "after_failure", detail: expect.stringContaining("failed") });
    const stops = await start(engine(fakeRuntime([edits(WRONG)])), template([{ ...BUILD_CHECKED, ifFailed: { action: "stop" } }]));
    expect(item(stops)).toMatchObject({ state: "failed", outcome: { kind: "failed" } });
  });

  it("the time budget asks when used up; Continue grants another budget", SLOW, async () => {
    // The first session takes 90 s of a 1-minute budget.
    const loop = engine(fakeRuntime([after(() => (clockOffset += 90_000), edits(WRONG)), edits(FIXED)]));
    const id = await start(loop, template([BUILD_CHECKED], { budget: { timeMinutes: 1 } }));
    expect(openDecision(id)).toMatchObject({ kind: "budget", stepId: "build" });
    expect(item(id).steps[0]?.attempts).toHaveLength(1);
    // Waiting for the engineer does not use the budget.
    clockOffset += 3_600_000;
    await answer(loop, id, "continue");
    expect(item(id).state).toBe("done");
  });
});

describe("run loop: start, safety and control", () => {
  it("asks before starting when a step runs the repo's checks and the repo lists none", SLOW, async () => {
    repo = { ...repo, checks: [] };
    const loop = engine(fakeRuntime([edits(FIXED)]));
    const id = await start(loop, template([BUILD_CHECKED]));
    expect(item(id).worktrees).toEqual([]);
    expect(openDecision(id)).toMatchObject({ kind: "run_failure", choices: [{ id: "retry_step", label: "Check again" }, { id: "stop" }] });
    expect(openDecision(id)?.stepId).toBeUndefined();
    repo = { ...repo, checks: ["sh check.sh"] };
    await answer(loop, id, "retry_step");
    expect(item(id).state).toBe("done");
  });

  it("writes a worktree error with the machine's folders replaced", SLOW, async () => {
    // A file where the worktree folder must go: the error names the full path.
    mkdirSync(join(repo.path, ".tokama"));
    writeFileSync(join(repo.path, ".tokama", "wt"), "");
    const id = await start(engine(fakeRuntime([edits(FIXED)])), template([BUILD_CHECKED]));
    expect(openDecision(id)).toMatchObject({ kind: "run_failure", detail: expect.stringContaining("<repo orders-api>/.tokama/wt") });
  });

  it("removes ignored files and runs setup again before the checks, so a swapped tool in node_modules never runs", SLOW, async () => {
    repo = { ...repo, checks: ["sh node_modules/.bin/runner"] };
    // The agent leaves app.txt broken and replaces the installed runner with `exit 0`.
    const loop = engine(fakeRuntime([edits({ "node_modules/.bin/runner": "exit 0\n" })]));
    const id = await start(loop, template([{ ...BUILD_CHECKED, ifFailed: { action: "ask" } }], { setup: "sh setup.sh" }));
    expect(story(id)).toContain("check sh node_modules/.bin/runner exit 1");
    expect(readFileSync(join(worktreeDir(id), "node_modules", ".bin", "runner"), "utf8")).toBe("grep -q fixed app.txt\n");
  });

  it("tamper: a package file change asks with the paths; Approve runs the checks and finishes", SLOW, async () => {
    const loop = engine(fakeRuntime([edits({ ...FIXED, "package.json": "{}\n" })]));
    const id = await start(loop, template([BUILD_CHECKED]));
    expect(openDecision(id)).toMatchObject({
      kind: "tamper",
      stepId: "build",
      detail: expect.stringContaining("added package.json (package)"),
      covers: [{ path: "package.json", mode: "100644", blob: expect.stringMatching(/^[0-9a-f]{40}$/) }],
    });
    // The attempt waits open; no check ran yet.
    expect(item(id).steps[0]?.attempts[0]?.endedAt).toBeUndefined();
    expect(item(id).steps[0]?.attempts[0]?.checks).toEqual([]);
    await answer(loop, id, "approve");
    expect(item(id).state).toBe("done");
    expect(await plain(repo.path, "show", `${item(id).outcome?.commits?.[0]?.commit}:package.json`)).toBe("{}");
  });

  it("tamper: the time the question waits does not use the budget", SLOW, async () => {
    const loop = engine(fakeRuntime([edits({ ...WRONG, "package.json": "{}\n" }), edits(FIXED)]));
    const id = await start(loop, template([BUILD_CHECKED], { budget: { timeMinutes: 1 } }));
    expect(openDecision(id)?.kind).toBe("tamper");
    clockOffset += 3_600_000;
    await answer(loop, id, "approve");
    // The checks failed on attempt 1; attempt 2 ran instead of a budget question.
    expect(item(id).decisions.map((d) => d.kind)).toEqual(["tamper"]);
    expect(item(id).state).toBe("done");
  });

  it("tamper: Stop on the question ends the item as stopped", SLOW, async () => {
    const loop = engine(fakeRuntime([edits({ ...FIXED, "vitest.config.ts": "export default {};\n" })]));
    const id = await start(loop, template([BUILD_CHECKED]));
    await answer(loop, id, "stop");
    expect(item(id)).toMatchObject({ state: "stopped", steps: [{ attempts: [{ result: "stopped" }] }] });
  });

  it("tamper: a .gitattributes change always stops the item, without running the checks", SLOW, async () => {
    const loop = engine(fakeRuntime([edits({ ...FIXED, ".gitattributes": "*.txt filter=x\n" })]));
    const id = await start(loop, template([BUILD_CHECKED]));
    expect(item(id)).toMatchObject({ state: "failed", outcome: { detail: expect.stringContaining("worktree:.gitattributes (git)") } });
    expect(item(id).steps[0]?.attempts[0]?.checks).toEqual([]);
    expect(openDecisions(item(id))).toEqual([]);
  });

  it("stop mid-step kills the call, records the attempt as stopped, and keeps the worktree", SLOW, async () => {
    let running!: () => void;
    const underWay = new Promise<void>((resolve) => (running = resolve));
    const loop = engine(fakeRuntime([hangs(() => running())]));
    const started = await loop.startItem({ template: template([BUILD_CHECKED]), repoId: repo.id, text: "Fix it" });
    if (!started.ok) throw new Error(started.error.message);
    await underWay;
    expect((await loop.stopItem(started.value)).ok).toBe(true);
    const stopped = item(started.value);
    expect(stopped).toMatchObject({ state: "stopped", outcome: { kind: "stopped" } });
    expect(stopped.steps[0]?.attempts[0]).toMatchObject({ result: "stopped" });
    expect(existsSync(worktreeDir(started.value))).toBe(true);
    // The stopped call's usage is still recorded, after the item ended, and the log still folds.
    await loop.settled(started.value);
    expect(item(started.value).calls).toEqual([expect.objectContaining({ stepId: "build", outcome: "aborted" })]);
    expect(ItemStore.open({ home: tokamaHome, hostId: HOST, clock }).store.get(started.value)?.calls).toHaveLength(1);
    expect(await loop.stopItem(started.value)).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  });

  it("a step whose agent file is broken asks Retry step / Stop with that file's problem", SLOW, async () => {
    const loop = engine(fakeRuntime([edits(FIXED)]), { agent: () => ({ problem: "agents/builder.md line 3: tools must be read-only or edit" }) });
    const id = await start(loop, template([BUILD_CHECKED]));
    expect(openDecision(id)).toMatchObject({ kind: "run_failure", detail: expect.stringContaining("agents/builder.md line 3: tools must be") });
    expect(item(id).steps[0]?.attempts[0]).toMatchObject({ result: "run_failed", failure: "crash" });
  });

  it("close stops a running call without recording it, refuses commands, and a new loop asks Retry step / Stop", SLOW, async () => {
    let running!: () => void;
    const underWay = new Promise<void>((resolve) => (running = resolve));
    const first = engine(fakeRuntime([hangs(() => running())]));
    const started = await first.startItem({ template: template([BUILD_CHECKED]), repoId: repo.id, text: "Fix it" });
    if (!started.ok) throw new Error(started.error.message);
    await underWay;
    await first.close();
    expect(item(started.value).steps[0]?.attempts[0]?.endedAt).toBeUndefined();
    expect(item(started.value).outcome).toBeUndefined();
    expect(await first.stopItem(started.value)).toMatchObject({ ok: false, error: { code: "invalid_state" } });

    store = ItemStore.open({ home: tokamaHome, hostId: HOST, clock }).store;
    const second = engine(fakeRuntime([edits(FIXED)]));
    await second.ready;
    expect(openDecision(started.value)?.kind).toBe("run_failure");
    await answer(second, started.value, "retry_step");
    expect(item(started.value).state).toBe("done");
  });

  it("refuses stale decisions and unknown choices", SLOW, async () => {
    const loop = engine(fakeRuntime([edits(FIXED)]));
    const id = await start(loop, template([{ id: "plan", doneWhen: "you approve" }]));
    const open = openDecision(id)!;
    expect(await loop.resolveDecision(id, open.id, "maybe")).toMatchObject({ ok: false, error: { code: "invalid_choice" } });
    await answer(loop, id, "approve");
    expect(await loop.resolveDecision(id, open.id, "approve")).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  });
});

describe("run loop: restart", () => {
  it("after a restart during a tamper question, the run failure wins and Retry step runs the step again", SLOW, async () => {
    const first = engine(fakeRuntime([edits({ ...FIXED, "package.json": "{}\n" })]));
    const id = await start(first, template([BUILD_CHECKED]));
    expect(openDecision(id)?.kind).toBe("tamper");

    // A new engine on the same log: recovery ends the open attempt and asks Retry step / Stop.
    store = ItemStore.open({ home: tokamaHome, hostId: HOST, clock }).store;
    const second = engine(fakeRuntime([edits(FIXED)]));
    const tamper = openDecisions(store.get(id)!).find((d) => d.kind === "tamper")!;
    // Held until recovery is done, then answered.
    expect((await second.resolveDecision(id, tamper.id, "approve")).ok).toBe(true);
    await second.settled(id);
    expect(openDecision(id)?.kind).toBe("run_failure");
    await answer(second, id, "retry_step");
    expect(item(id).steps[0]?.attempts.map((a) => [a.result, a.failure])).toEqual([
      ["run_failed", "engine_restart"],
      ["passed", undefined],
    ]);
    expect(item(id).state).toBe("done");
  });

  it("picks up an item that was starting when the engine stopped", SLOW, async () => {
    const created = store.create({ template: template([BUILD_CHECKED]), title: "Fix it", text: "Fix it", repoIds: [repo.id] });
    if (!created.ok) throw new Error(created.error.message);
    const loop = engine(fakeRuntime([edits(FIXED)]));
    await loop.ready;
    await loop.settled(created.value.id);
    expect(item(created.value.id).state).toBe("done");
  });
});

describe("run loop: protection", () => {
  const TAMPER_FILES = { "package.json": '{"scripts":{"test":"exit 0"}}\n', ".tokama/templates/evil.yaml": "x\n", ".gitattributes": "*.txt -diff\n" };
  const commitOf = (id: ItemId) => item(id).outcome?.commits?.[0]?.commit;

  it("a call that times out after changing Tokama's files stops the item; nothing is committed", SLOW, async () => {
    const loop = engine(fakeRuntime([editsThenHangs(TAMPER_FILES), edits(FIXED)]), { guard: { turnCap: 150, repeatLimit: 6, idleMs: 0, silentMs: 0, toolSilentMs: 0, timeoutMs: 300 } });
    const id = await start(loop, template([BUILD_CHECKED]));
    expect(item(id)).toMatchObject({ state: "failed", outcome: { detail: expect.stringContaining("worktree:.tokama/templates/evil.yaml (tokama)") } });
    expect(commitOf(id)).toBeUndefined();
  });

  it("a call that crashes after changing package.json: Retry step asks about it before any check runs", SLOW, async () => {
    const loop = engine(fakeRuntime([editsThenCrashes({ "package.json": "{}\n" }), edits(FIXED)]));
    const id = await start(loop, template([BUILD_CHECKED]));
    await answer(loop, id, "retry_step", "run_failure");
    expect(openDecision(id)).toMatchObject({ kind: "tamper", covers: [{ path: "package.json" }] });
    expect(item(id).steps[0]?.attempts[1]?.checks).toEqual([]);
  });

  it("a check that writes Tokama's files stops the item, even when it fails and the step would retry", SLOW, async () => {
    const evilCheck = "mkdir -p .tokama/templates; echo x > .tokama/templates/evil.yaml; echo '{}' > package.json; exit 3\n";
    const runtime = fakeRuntime([edits({ "check.sh": evilCheck }), edits(FIXED)]);
    const id = await start(engine(runtime), template([BUILD_CHECKED]));
    expect(item(id)).toMatchObject({ state: "failed", outcome: { detail: expect.stringContaining(".tokama/templates/evil.yaml") } });
    expect(runtime.calls).toHaveLength(1);
    // Stopped right after the checks, in the same attempt: no retry started.
    expect(item(id).steps[0]?.attempts).toHaveLength(1);
    expect(commitOf(id)).toBeUndefined();
  });

  it("files the setup command writes are judged in the staged tree before the checks", SLOW, async () => {
    const setup = `${readFileSync(join(repo.path, "setup.sh"), "utf8")}echo 'export default {}' > vitest.config.ts; echo '{}' > package.json\n`;
    const id = await start(engine(fakeRuntime([edits({ ...FIXED, "setup.sh": setup })])), template([BUILD_CHECKED], { setup: "sh setup.sh" }));
    expect(openDecision(id)?.kind).toBe("tamper");
    expect(openDecision(id)?.covers?.map((c) => c.path).sort()).toEqual(["package.json", "vitest.config.ts"]);
    expect(item(id).steps[0]?.attempts[0]?.checks).toEqual([]);
  });

  it("an approval covers exactly the content it showed; a later change to the same path asks again", SLOW, async () => {
    const loop = engine(fakeRuntime([edits({ ...WRONG, "package.json": "{}\n" }), edits({ ...FIXED, "package.json": '{"a":1}\n' })]));
    const id = await start(loop, template([BUILD_CHECKED]));
    await answer(loop, id, "approve");
    // Attempt 1 ran its checks and failed; attempt 2 changed package.json again.
    expect(item(id).steps[0]?.attempts).toHaveLength(2);
    expect(openDecision(id)).toMatchObject({ kind: "tamper", covers: [{ path: "package.json" }] });
    await answer(loop, id, "approve");
    expect(item(id).state).toBe("done");
  });

  it("a change to the main repo's git config during the item stops it", SLOW, async () => {
    const loop = engine(fakeRuntime([after(() => appendFileSync(join(repo.path, ".git", "config"), "[core]\n\thooksPath = hooks\n"), edits(FIXED))]));
    const id = await start(loop, template([BUILD_CHECKED]));
    expect(item(id)).toMatchObject({ state: "failed", outcome: { detail: expect.stringContaining("modified git:config (git)") } });
  });

  describe("the baseline is taken after setup, and git config counts by its keys", () => {
    const sharedConfig = () => join(repo.path, ".git", "config");
    /** Like husky's `prepare`: setup points git at the repo's hooks folder. */
    const huskySetup = async () => {
      appendFileSync(join(repo.path, "setup.sh"), "git config core.hooksPath .husky/_\n");
      await plain(repo.path, "add", "-A");
      await plain(repo.path, "commit", "-q", "-m", "husky");
    };

    it("a setup command that sets core.hooksPath does not stop the item, at Start or before the checks", SLOW, async () => {
      await huskySetup();
      const id = await start(engine(fakeRuntime([edits(FIXED)])), template([BUILD_CHECKED], { setup: "sh setup.sh" }));
      expect(item(id).state).toBe("done");
      expect(await plain(repo.path, "config", "core.hooksPath")).toBe(".husky/_");
      expect(story(id).slice(0, 4)).toEqual(["item_created", "worktree_added", "baseline_recorded", "step_started build"]);
    });

    it("a setup that fails takes no baseline; Retry runs setup again and takes it once", SLOW, async () => {
      // Sets core.hooksPath, then fails the first time only (the marker is outside the worktree).
      const marker = join(root, "setup-ran");
      appendFileSync(join(repo.path, "setup.sh"), `git config core.hooksPath .husky/_\n[ -f '${marker}' ] || { touch '${marker}'; exit 1; }\n`);
      await plain(repo.path, "add", "-A");
      await plain(repo.path, "commit", "-q", "-m", "flaky setup");
      const loop = engine(fakeRuntime([edits(FIXED)]));
      const id = await start(loop, template([BUILD_CHECKED], { setup: "sh setup.sh" }));
      expect(openDecision(id)?.kind).toBe("run_failure");
      expect(item(id).worktrees[0]?.protectedDigest).toBeUndefined();
      await answer(loop, id, "retry_step");
      expect(item(id).state).toBe("done");
      expect(story(id).filter((line) => line === "baseline_recorded")).toHaveLength(1);
    });

    it("a `git push -u` in the main checkout during a step does not stop the item", SLOW, async () => {
      const pushU = () =>
        appendFileSync(
          sharedConfig(),
          '[remote "origin"]\n\turl = https://example.invalid/orders-api.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n',
        );
      const id = await start(engine(fakeRuntime([after(pushU, edits(FIXED))])), template([BUILD_CHECKED]));
      expect(item(id).state).toBe("done");
    });

    it("a real `git push -u` and `git remote set-url` to an https or ssh URL in the main checkout during a step do not stop the item", SLOW, async () => {
      // The https URL reaches a local bare repo through a rewrite set before the baseline.
      await plain(root, "init", "-q", "--bare", join(root, "origin.git"));
      await plain(repo.path, "config", `url.${root}/.insteadOf`, "https://example.invalid/");
      await plain(repo.path, "remote", "add", "origin", "https://example.invalid/origin.git");
      const push = async () => {
        await plain(repo.path, "push", "-q", "-u", "origin", "main");
        await plain(repo.path, "remote", "set-url", "origin", "https://example.invalid/orders-api.git");
        await plain(repo.path, "remote", "set-url", "origin", "ssh://git@example.invalid/orders-api.git");
        await plain(repo.path, "remote", "set-url", "--push", "origin", "git@example.invalid:orders-api.git");
      };
      const id = await start(engine(fakeRuntime([after(push, edits(FIXED))])), template([BUILD_CHECKED]));
      expect(item(id).state).toBe("done");
    });

    it.each([
      ["a local path", "/srv/evil.git"],
      ["a transport helper", "ext::sh -c touch% pwned"],
      ["a file:// URL", "file:///srv/evil.git"],
    ])("an agent setting the remote url to %s stops the item", SLOW, async (_kind, url) => {
      await plain(repo.path, "remote", "add", "origin", "https://example.invalid/orders-api.git");
      const setUrl = () => plain(repo.path, "remote", "set-url", "origin", url);
      const id = await start(engine(fakeRuntime([after(setUrl, edits(FIXED))])), template([BUILD_CHECKED]));
      expect(item(id)).toMatchObject({ state: "failed", outcome: { detail: expect.stringContaining("modified git:config (git)") } });
      expect(commitOf(id)).toBeUndefined();
    });

    it("an agent setting remote.origin.uploadpack stops the item", SLOW, async () => {
      await plain(repo.path, "remote", "add", "origin", "https://example.invalid/orders-api.git");
      const uploadpack = () => plain(repo.path, "config", "remote.origin.uploadpack", "touch pwned");
      const id = await start(engine(fakeRuntime([after(uploadpack, edits(FIXED))])), template([BUILD_CHECKED]));
      expect(item(id)).toMatchObject({ state: "failed", outcome: { detail: expect.stringContaining("modified git:config (git)") } });
      expect(commitOf(id)).toBeUndefined();
    });

    it("an agent editing a file the git config includes stops the item", SLOW, async () => {
      const included = join(root, "shared.config");
      writeFileSync(included, "[core]\n\tpager = less\n");
      appendFileSync(sharedConfig(), `[include]\n\tpath = ${included}\n`);
      const id = await start(engine(fakeRuntime([after(() => appendFileSync(included, "\tfsmonitor = touch pwned\n"), edits(FIXED))])), template([BUILD_CHECKED]));
      expect(item(id)).toMatchObject({ state: "failed", outcome: { detail: expect.stringContaining("modified git:config (git)") } });
      expect(commitOf(id)).toBeUndefined();
    });

    it("an included file that goes missing fails closed", SLOW, async () => {
      const included = join(root, "shared.config");
      writeFileSync(included, "[core]\n\tpager = less\n");
      appendFileSync(sharedConfig(), `[include]\n\tpath = ${included}\n`);
      const id = await start(engine(fakeRuntime([after(() => unlinkSync(included), edits(FIXED))])), template([BUILD_CHECKED]));
      expect(item(id)).toMatchObject({ state: "failed", outcome: { detail: expect.stringContaining("could not be read") } });
      expect(commitOf(id)).toBeUndefined();
    });

    it.each([
      ["core.hooksPath", "[core]\n\thooksPath = elsewhere\n"],
      ["core.fsmonitor", "[core]\n\tfsmonitor = touch pwned\n"],
      ["filter.x.clean", '[filter "x"]\n\tclean = touch pwned\n'],
      ["include.path", "[include]\n\tpath = ../evil.config\n"],
    ])("an agent setting %s after setup stops the item", SLOW, async (_key, content) => {
      await huskySetup();
      // The file the include names exists: a missing one fails closed (its own test).
      writeFileSync(join(repo.path, "evil.config"), "[core]\n\tpager = less\n");
      const loop = engine(fakeRuntime([after(() => appendFileSync(sharedConfig(), content), edits(FIXED))]));
      const id = await start(loop, template([BUILD_CHECKED], { setup: "sh setup.sh" }));
      expect(item(id)).toMatchObject({ state: "failed", outcome: { detail: expect.stringContaining("modified git:config (git)") } });
      expect(commitOf(id)).toBeUndefined();
    });

    it("a hooks file change still stops the item", SLOW, async () => {
      const hook = () => writeFileSync(join(repo.path, ".git", "hooks", "pre-commit"), "#!/bin/sh\ntouch pwned\n");
      const id = await start(engine(fakeRuntime([after(hook, edits(FIXED))])), template([BUILD_CHECKED]));
      expect(item(id)).toMatchObject({ state: "failed", outcome: { detail: expect.stringContaining("added git:hooks/pre-commit (git)") } });
    });

    it("after a restart, the recorded baseline is used, never a new one", SLOW, async () => {
      await huskySetup();
      const id = await start(engine(fakeRuntime([edits(FIXED)])), template([{ id: "plan", doneWhen: "you approve" }], { setup: "sh setup.sh" }));
      expect(openDecision(id)?.kind).toBe("plan_approval");
      const digest = item(id).worktrees[0]!.protectedDigest;
      appendFileSync(sharedConfig(), "[core]\n\tfsmonitor = touch pwned\n");

      store = ItemStore.open({ home: tokamaHome, hostId: HOST, clock }).store;
      const second = engine(fakeRuntime([]));
      await second.ready;
      await answer(second, id, "approve");
      expect(item(id)).toMatchObject({ state: "failed", outcome: { detail: expect.stringContaining("modified git:config (git)") } });
      expect(item(id).worktrees[0]!.protectedDigest).toBe(digest);
      expect(story(id).filter((line) => line === "baseline_recorded")).toHaveLength(1);
    });
  });

  it("the reviewer reviews the checked tree; a check that rewrote the worktree asks first; Finish commits that tree", SLOW, async () => {
    const original = readFileSync(join(repo.path, "check.sh"), "utf8");
    // The check passes, then rewrites app.txt and itself after the tree was fixed.
    const evilCheck = `grep -q fixed app.txt || exit 3\nprintf 'fixed\\n' > app.txt\nprintf '%s' '${original}' > check.sh\n`;
    const builder = fakeRuntime([edits({ "app.txt": "fixed\nMALICIOUS_MARKER\n", "check.sh": evilCheck })]);
    const reviewer = fakeRuntime([says("Looks good.\nVERDICT: approve")]);
    const loop = engine(builder, { runtime: (a) => (a.id === "reviewer" ? reviewer : builder) });
    const id = await start(loop, template([BUILD_CHECKED, { id: "review", agentId: "reviewer", doneWhen: "reviewer approves" }]));
    expect(openDecision(id)).toMatchObject({ kind: "tamper", stepId: "review", tree: expect.any(String), detail: expect.stringContaining("app.txt") });
    expect(reviewer.calls).toHaveLength(0);
    await answer(loop, id, "use_recorded_tree");
    expect(reviewer.calls[0]?.request.prompt).toContain("MALICIOUS_MARKER");
    const [build, review] = item(id).steps.map((s) => s.attempts.at(-1)?.tree);
    expect(review).toBe(build);
    expect(await plain(repo.path, "rev-parse", `${commitOf(id)}^{tree}`)).toBe(review);
  });

  it("Finish asks before committing a tree the reviewer did not approve", SLOW, async () => {
    const builder = fakeRuntime([edits(FIXED), edits({ "app.txt": "fixed\npolished\n" })]);
    const reviewer = fakeRuntime([says("VERDICT: approve")]);
    const loop = engine(builder, { runtime: (a) => (a.id === "reviewer" ? reviewer : builder) });
    const id = await start(loop, template([{ id: "build" }, { id: "review", agentId: "reviewer", doneWhen: "reviewer approves" }, { ...BUILD_CHECKED, id: "polish" }]));
    expect(openDecision(id)).toMatchObject({ kind: "tamper", detail: expect.stringContaining("not the one the reviewer approved") });
    await answer(loop, id, "commit_anyway");
    expect(await plain(repo.path, "show", `${commitOf(id)}:app.txt`)).toBe("fixed\npolished");
  });

  it("Finish asks before leaving out changes a step made after the checks, and commits only the checked tree", SLOW, async () => {
    const loop = engine(fakeRuntime([edits(FIXED), edits({ "app.txt": "fixed\nunchecked\n" })]));
    const id = await start(loop, template([BUILD_CHECKED, { id: "polish" }]));
    expect(openDecision(id)).toMatchObject({ kind: "tamper", detail: expect.stringContaining("app.txt") });
    await answer(loop, id, "commit_checked_tree");
    expect(await plain(repo.path, "show", `${commitOf(id)}:app.txt`)).toBe("fixed");
  });

  it("refuses a reviewer that uses the same agent as the step it reviews", SLOW, async () => {
    const id = await start(engine(fakeRuntime([edits(FIXED), says("VERDICT: approve")])), template([{ id: "build" }, { id: "review", doneWhen: "reviewer approves" }]));
    expect(openDecision(id)).toMatchObject({ kind: "run_failure", stepId: "review", detail: expect.stringContaining("same agent") });
  });

  it("refuses a reviewer's words for a cloud builder when the reviewer sees connection results", SLOW, async () => {
    const cloud: Agent = { ...agent("cloud-builder"), cliId: "claude-code", model: "haiku" };
    const agents: Record<string, Agent> = { ...AGENTS, "cloud-builder": cloud, logs: agent("logs", false) };
    const builder = fakeRuntime([edits(FIXED)]);
    const reviewer = fakeRuntime([says("Log line: CUSTOMER_SECRET_123\nVERDICT: changes")]);
    const logs = fakeRuntime([says("Found CUSTOMER_SECRET_123 in the logs.")]);
    const loop = engine(builder, { agent: (_r, id) => agents[id], runtime: (a) => (a.id === "reviewer" ? reviewer : a.id === "logs" ? logs : builder) });
    const uses = [{ connectionId: "northwind-logs", access: "read" }];
    const tpl = template(
      [
        { id: "logs", agentId: "logs", connections: uses },
        { id: "build", agentId: "cloud-builder", data: "repo-and-diff", maxAttempts: 2 },
        { id: "review", agentId: "reviewer", sees: ["logs"], doneWhen: "reviewer approves", ifChangesRequested: { action: "back", stepId: "build" }, maxAttempts: 2 },
      ],
      { uses: { repos: { picked: "edit", named: [] }, connections: uses, commands: [] } },
    );
    const id = await start(loop, tpl);
    expect(openDecision(id)).toMatchObject({ kind: "run_failure", stepId: "build", detail: expect.stringContaining("results from connections") });
    expect(builder.calls).toHaveLength(1);
  });
});

describe("run loop: review fixes", () => {
  it("with the defaults (max 1, if_failed ask), Retry step at the limit grants the attempt", SLOW, async () => {
    const loop = engine(fakeRuntime([edits(WRONG), edits(FIXED)]));
    const id = await start(loop, template([{ ...BUILD_CHECKED, ifFailed: { action: "ask" }, maxAttempts: 1 }]));
    await answer(loop, id, "retry_step");
    expect(item(id).steps[0]?.attempts.map((a) => a.result)).toEqual(["failed", "passed"]);
    expect(item(id).state).toBe("done");
  });

  it("the same failure twice asks before if_failed sends the item back", SLOW, async () => {
    const builder = fakeRuntime([edits(WRONG)]);
    const checker = fakeRuntime([says("Ready.")]);
    const loop = engine(builder, { runtime: (a) => (a.id === "reviewer" ? checker : builder) });
    const tpl = template([
      { id: "build", maxAttempts: 5 },
      { id: "verify", agentId: "reviewer", doneWhen: "checks pass", checks: { commands: ["sh check.sh"] }, ifFailed: { action: "back", stepId: "build" }, maxAttempts: 5 },
    ]);
    const id = await start(loop, tpl);
    expect(item(id).steps.map((s) => s.attempts.length)).toEqual([2, 2]);
    expect(openDecision(id)).toMatchObject({ kind: "after_failure", stepId: "verify", detail: expect.stringContaining("twice in a row") });
  });

  it("a step's final reply reaches the steps that see it as {{ <step>.summary }}", SLOW, async () => {
    const runtime = fakeRuntime([says("Use a lookup table."), edits(FIXED)]);
    const tpl = template([{ id: "plan" }, { ...BUILD_CHECKED, sees: ["plan"], instructions: { text: "Build it as planned: {{ plan.summary }}" } }]);
    const id = await start(engine(runtime), tpl);
    expect(runtime.calls[1]?.request.prompt).toContain("Use a lookup table.");
    expect(item(id).state).toBe("done");
  });

  it("reuses the worktree a crashed start made but did not record", SLOW, async () => {
    const created = store.create({ template: template([BUILD_CHECKED]), title: "Fix it", text: "Fix it", repoIds: [repo.id] });
    if (!created.ok) throw new Error(created.error.message);
    const made = await createWorktree(git, repo, created.value.id);
    if (!made.ok) throw new Error(made.error.message);
    const loop = engine(fakeRuntime([edits(FIXED)]));
    await loop.settled(created.value.id);
    expect(item(created.value.id)).toMatchObject({ state: "done", worktrees: [{ dir: made.value.folder, baseCommit: made.value.baseCommit }] });
  });

  it("records the commit a crashed Finish made but did not record", SLOW, async () => {
    const loop = engine(fakeRuntime([edits(FIXED)]));
    const id = await start(loop, template([{ id: "plan", doneWhen: "you approve" }]));
    // The crash window: Tokama's commit is on the branch, and the log does not have it.
    const wt = worktreeDir(id);
    await plain(wt, "add", "-A");
    const tree = await plain(wt, "write-tree");
    const base = item(id).worktrees[0]!.baseCommit!;
    const commit = await plain(wt, "commit-tree", tree, "-p", base, "-m", "tokama: Fix the app");
    await plain(wt, "update-ref", `refs/heads/${item(id).worktrees[0]!.branch}`, commit, base);
    await answer(loop, id, "approve");
    expect(item(id)).toMatchObject({ state: "done", outcome: { commits: [{ commit }] } });
  });

  for (const order of [["run_failure", "tamper"], ["tamper", "run_failure"]] as const) {
    it(`a tamper question and a run failure across two restarts, answered ${order.join(" then ")}, do not get stuck`, SLOW, async () => {
      const id = await start(engine(fakeRuntime([edits({ ...FIXED, "package.json": "{}\n" })])), template([BUILD_CHECKED]));
      expect(openDecision(id)?.kind).toBe("tamper");
      const restart = async () => {
        store = ItemStore.open({ home: tokamaHome, hostId: HOST, clock }).store;
        const loop = engine(fakeRuntime([edits(FIXED)]));
        await loop.ready;
        return loop;
      };
      const choiceFor = { run_failure: "retry_step", tamper: "approve" } as const;
      let loop = await restart();
      await answer(loop, id, choiceFor[order[0]], order[0]);
      loop = await restart();
      await answer(loop, id, choiceFor[order[1]], order[1]);
      expect(item(id).state).toBe("done");
    });
  }
});

describe("run loop: item diff", () => {
  const shown = (files: readonly { path: string; status: string; added: number | null; removed: number | null }[]) => files.map((f) => [f.path, f.status, f.added, f.removed]);

  it("a done item not merged: its commit against the base commit; files left in the worktree after Done are not in it", SLOW, async () => {
    const loop = engine(fakeRuntime([edits(FIXED)]));
    const id = await start(loop, template([{ id: "build" }]));
    expect(item(id)).toMatchObject({ state: "done", outcome: { kind: "done" } });
    expect(await loop.itemDiff(id)).toMatchObject({ ok: true, value: { kind: "worktree", files: [{ path: "app.txt", status: "modified", hunks: [{ lines: ["-broken", "+fixed"] }] }] } });

    writeFileSync(join(worktreeDir(id), "later.txt"), "left after Done\n");
    const diff = await loop.itemDiff(id);
    if (!diff.ok || diff.value.kind !== "worktree") throw new Error(JSON.stringify(diff));
    expect(shown(diff.value.files)).toEqual([["app.txt", "modified", 1, 1]]);
    const { dir, branch, baseCommit } = item(id).worktrees[0]!;
    expect(diff.value.worktree).toEqual({ repoId: "orders-api", dir, branch, baseCommit });
    expect(await plain(worktreeDir(id), "status", "--porcelain")).toBe("?? later.txt");
    // A query records nothing.
    const events = log(id).length;
    await loop.itemDiff(id);
    expect(log(id)).toHaveLength(events);
  });

  it("a done item whose worktree folder is gone still shows its commit; a repo that does not read is an error, not a gone commit", SLOW, async () => {
    const loop = engine(fakeRuntime([edits(FIXED)]));
    const id = await start(loop, template([{ id: "build" }]));
    rmSync(worktreeDir(id), { recursive: true, force: true });
    const diff = await loop.itemDiff(id);
    if (!diff.ok || diff.value.kind !== "worktree") throw new Error(JSON.stringify(diff));
    expect(shown(diff.value.files)).toEqual([["app.txt", "modified", 1, 1]]);

    rmSync(join(repo.path, ".git"), { recursive: true, force: true });
    const broken = await loop.itemDiff(id);
    expect(broken).toMatchObject({ ok: false, error: { code: "invalid_state", message: expect.stringContaining("Cannot read repo orders-api") } });
    expect(JSON.stringify(broken)).not.toContain(root);
  });

  it("a merged item: the merged commit against the base branch before it; a merge commit against its first parent", SLOW, async () => {
    const loop = engine(fakeRuntime([edits(FIXED), edits({ "notes.txt": "new\n" })]));
    const fastForward = await start(loop, template([{ id: "build" }]));
    expect((await loop.finishItem(fastForward, "merge")).ok).toBe(true);
    await loop.settled(fastForward);
    const merged = item(fastForward).finish?.merged;
    expect(merged).toMatchObject({ baseBranch: "main" });
    const diff = await loop.itemDiff(fastForward);
    if (!diff.ok || diff.value.kind !== "merged") throw new Error(JSON.stringify(diff));
    expect(diff.value).toMatchObject({ repoId: "orders-api", baseBranch: "main", commit: merged!.commit, parent: item(fastForward).worktrees[0]!.baseCommit });
    expect(shown(diff.value.files)).toEqual([["app.txt", "modified", 1, 1]]);

    // main moves on before the second item merges: Merge makes a merge commit.
    const second = await start(loop, template([{ id: "build" }]));
    writeFileSync(join(repo.path, "other.txt"), "on main\n");
    await plain(repo.path, "add", "other.txt");
    await plain(repo.path, "commit", "-q", "-m", "other work");
    const before = await plain(repo.path, "rev-parse", "main");
    expect((await loop.finishItem(second, "merge")).ok).toBe(true);
    await loop.settled(second);
    const viaMerge = await loop.itemDiff(second);
    if (!viaMerge.ok || viaMerge.value.kind !== "merged") throw new Error(JSON.stringify(viaMerge));
    expect(viaMerge.value.parent).toBe(before);
    expect(shown(viaMerge.value.files)).toEqual([["notes.txt", "added", 1, 0]]);
  });

  it("an item merged by hand before Merge was clicked shows its own commit, not the tip of the base branch", SLOW, async () => {
    const loop = engine(fakeRuntime([edits(FIXED)]));
    const id = await start(loop, template([{ id: "build" }]));
    const { branch, baseCommit } = item(id).worktrees[0]!;
    const own = await plain(repo.path, "rev-parse", branch!);
    await plain(repo.path, "merge", "-q", "--ff-only", branch!);
    writeFileSync(join(repo.path, "later.txt"), "unrelated\n");
    await plain(repo.path, "add", "later.txt");
    await plain(repo.path, "commit", "-q", "-m", "unrelated work");
    expect((await loop.finishItem(id, "merge")).ok).toBe(true);
    await loop.settled(id);
    expect(item(id).finish?.merged?.commit).not.toBe(own);
    const diff = await loop.itemDiff(id);
    if (!diff.ok || diff.value.kind !== "merged") throw new Error(JSON.stringify(diff));
    expect(diff.value).toMatchObject({ commit: own, parent: baseCommit });
    expect(shown(diff.value.files)).toEqual([["app.txt", "modified", 1, 1]]);
  });

  it("a merged commit that is no longer in the repo is gone, not an error; a repo that does not read is an error", SLOW, async () => {
    const loop = engine(fakeRuntime([edits(FIXED)]));
    const id = await start(loop, template([{ id: "build" }]));
    expect((await loop.finishItem(id, "merge")).ok).toBe(true);
    await loop.settled(id);
    const commit = item(id).finish!.merged!.commit;
    await plain(repo.path, "reset", "-q", "--hard", item(id).worktrees[0]!.baseCommit!);
    await plain(repo.path, "reflog", "expire", "--expire=now", "--all");
    await plain(repo.path, "gc", "-q", "--prune=now");
    expect(await loop.itemDiff(id)).toEqual({ ok: true, value: { kind: "gone", repoId: "orders-api", commit } });

    rmSync(join(repo.path, ".git"), { recursive: true, force: true });
    const broken = await loop.itemDiff(id);
    expect(broken).toMatchObject({ ok: false, error: { code: "invalid_state", message: expect.stringContaining("Cannot read repo orders-api") } });
    expect(JSON.stringify(broken)).not.toContain(root);
  });

  it("a discarded item, an item that never ran and one that has not ended", SLOW, async () => {
    const loop = engine(fakeRuntime([edits(FIXED)]));
    const id = await start(loop, template([{ id: "build" }]));
    expect((await loop.finishItem(id, "discard")).ok).toBe(true);
    await loop.settled(id);
    expect(await loop.itemDiff(id)).toEqual({ ok: true, value: { kind: "none" } });
    expect(await loop.itemDiff("item_00000000-0000-4000-8000-000000000000" as ItemId)).toMatchObject({ ok: false, error: { code: "not_found" } });

    let running!: () => void;
    const underWay = new Promise<void>((resolve) => (running = resolve));
    const hanging = engine(fakeRuntime([hangs(() => running())]));
    const started = await hanging.startItem({ template: template([BUILD_CHECKED]), repoId: repo.id, text: "Fix it" });
    if (!started.ok) throw new Error(started.error.message);
    await underWay;
    expect(await hanging.itemDiff(started.value)).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    await hanging.stopItem(started.value);
    await hanging.settled(started.value);
  });

  it("a stopped item with its worktree left: what is in the worktree now; refused once the files that steer git there changed", SLOW, async () => {
    let running!: () => void;
    const underWay = new Promise<void>((resolve) => (running = resolve));
    const loop = engine(fakeRuntime([hangs(() => running())]));
    const started = await loop.startItem({ template: template([BUILD_CHECKED]), repoId: repo.id, text: "Fix it" });
    if (!started.ok) throw new Error(started.error.message);
    const id = started.value;
    await underWay;
    await loop.stopItem(id);
    await loop.settled(id);
    expect(item(id).state).toBe("stopped");
    expect(await loop.itemDiff(id)).toMatchObject({ ok: true, value: { kind: "worktree", files: [] } });

    writeFileSync(join(worktreeDir(id), "app.txt"), "half fixed\n");
    writeFileSync(join(worktreeDir(id), "draft.txt"), "draft\n");
    const diff = await loop.itemDiff(id);
    if (!diff.ok || diff.value.kind !== "worktree") throw new Error(JSON.stringify(diff));
    expect(shown(diff.value.files)).toEqual([
      ["app.txt", "modified", 1, 1],
      ["draft.txt", "added", 1, 0],
    ]);
    expect(await plain(worktreeDir(id), "diff", "--cached", "--name-only")).toBe("");

    writeFileSync(join(worktreeDir(id), ".gitattributes"), "*.txt filter=x\n");
    expect(await loop.itemDiff(id)).toMatchObject({ ok: false, error: { code: "invalid_state", message: expect.stringContaining("so Tokama does not read it") } });

    rmSync(worktreeDir(id), { recursive: true, force: true });
    expect(await loop.itemDiff(id)).toEqual({ ok: true, value: { kind: "none" } });
  });
});

describe("run loop: what the step's agent says", () => {
  const said = (id: ItemId, step = 0, attempt = 0) => item(id).steps[step]?.attempts[attempt]?.said;
  /** The `said` of every `attempt_ended` event in the log, by step and attempt. */
  const logged = (id: ItemId) => log(id).flatMap((event) => (event.type === "attempt_ended" ? [[`${event.stepId}#${event.attempt}`, event.result, event.said?.headline] as const] : []));
  const bigReply = (block: string) => `${Array.from({ length: 450 }, (_, i) => `w${i}`).join(" ")}\n${block}`;

  it("every agent step's prompt asks for the headline block; a step that changes files records its headline and points", SLOW, async () => {
    const runtime = fakeRuntime([edits(FIXED, "I fixed it.\n\nHEADLINE: Fixed app.txt.\nPOINT: Not run on Windows.")]);
    const id = await start(engine(runtime), template([{ id: "build" }]));
    expect(runtime.calls[0]?.request.prompt).toContain("HEADLINE: <one line, at most 140 characters");
    expect(runtime.calls[0]?.request.prompt).not.toContain("VERDICT");
    expect(said(id)).toEqual({ source: "headline", headline: "Fixed app.txt.", points: ["Not run on Windows."], morePoints: 0, bodyBytes: "I fixed it.".length });
  });

  it("a reply without the block shows its first lines; nothing fails or retries", SLOW, async () => {
    const runtime = fakeRuntime([edits(FIXED, "Fixed app.txt.\nIt now says fixed.\nMore.")]);
    const id = await start(engine(runtime), template([{ id: "build" }]));
    expect(item(id).state).toBe("done");
    expect(runtime.calls).toHaveLength(1);
    expect(said(id)).toMatchObject({ source: "first_lines", headline: "Fixed app.txt.", points: ["It now says fixed.", "More."] });
  });

  it("an empty reply records no headline", SLOW, async () => {
    const id = await start(engine(fakeRuntime([edits(FIXED, "")])), template([{ id: "build" }]));
    expect(item(id).state).toBe("done");
    expect(said(id)).toBeUndefined();
  });

  it("a run failure records none", SLOW, async () => {
    const id = await start(engine(fakeRuntime([crashes("quota", "You've hit your limit")])), template([{ id: "build" }]));
    expect(logged(id)).toEqual([["build#1", "run_failed", undefined]]);
  });

  it("must-read: a step you approve that changed nothing; not one that changed files", SLOW, async () => {
    const plan = fakeRuntime([says("A plan.\nHEADLINE: Use a lookup table.")]);
    const first = await start(engine(plan), template([{ id: "plan", doneWhen: "you approve" }]));
    expect(said(first)).toMatchObject({ headline: "Use a lookup table.", readMinutes: 1 });

    const changed = fakeRuntime([edits(FIXED, "Done.\nHEADLINE: Fixed app.txt.")]);
    const second = await start(engine(changed), template([{ id: "plan", doneWhen: "you approve" }]));
    expect(said(second)).not.toHaveProperty("readMinutes");
  });

  it("must-read: the last step of a template that ends with findings or a document", SLOW, async () => {
    const loop = engine(fakeRuntime([says("Looked.\nHEADLINE: The index is missing."), says("The write-up.\nHEADLINE: Cause found.")]));
    const id = await start(loop, template([{ id: "scope" }, { id: "report" }], { finish: ["findings"], uses: { repos: { picked: "read", named: [] }, connections: [], commands: [] } }));
    expect(said(id, 0)).not.toHaveProperty("readMinutes");
    expect(said(id, 1)).toMatchObject({ headline: "Cause found.", readMinutes: 1 });
  });

  it("must-read: the agent's own flag counts only for a reply of 150 words or more", SLOW, async () => {
    const small = await start(engine(fakeRuntime([edits(FIXED, "Done.\nHEADLINE: Fixed it.\nREAD: yes")])), template([{ id: "build" }]));
    expect(said(small)).not.toHaveProperty("readMinutes");
    const big = await start(engine(fakeRuntime([edits(FIXED, bigReply("HEADLINE: A design.\nREAD: yes"))])), template([{ id: "build" }]));
    expect(said(big)).toMatchObject({ headline: "A design.", readMinutes: 3 });
  });

  it("checks pass: a passed attempt and a failed one each record what the agent said", SLOW, async () => {
    const loop = engine(fakeRuntime([edits(WRONG, "Tried.\nHEADLINE: First try."), edits(FIXED, "Again.\nHEADLINE: Second try.")]));
    const id = await start(loop, template([BUILD_CHECKED]));
    expect(logged(id)).toEqual([
      ["build#1", "failed", "First try."],
      ["build#2", "passed", "Second try."],
    ]);
  });

  it("a reviewer's prompt has the headline rule above the verdict rule; its attempts record the headline for both verdicts, written above or below the verdict", SLOW, async () => {
    const builder = fakeRuntime([edits(FIXED, "Built.\nHEADLINE: Built it."), edits({ "app.txt": "fixed\nwith a test\n" }, "Built.\nHEADLINE: Added a test.")]);
    const reviewer = fakeRuntime([says("Add a test.\nHEADLINE: One test is missing.\nPOINT: app.txt\nVERDICT: changes"), says("Looks good.\n\nVERDICT: approve\nHEADLINE: Ready to merge.")]);
    const loop = engine(builder, { runtime: (a) => (a.id === "reviewer" ? reviewer : builder) });
    const tpl = template([
      { id: "build", maxAttempts: 2 },
      { id: "review", agentId: "reviewer", doneWhen: "reviewer approves", ifChangesRequested: { action: "back", stepId: "build" }, maxAttempts: 2 },
    ]);
    const id = await start(loop, tpl);
    expect(item(id).state).toBe("done");
    const prompt = reviewer.calls[0]!.request.prompt;
    expect(prompt.indexOf("HEADLINE: <one line")).toBeGreaterThan(-1);
    expect(prompt.indexOf("HEADLINE: <one line")).toBeLessThan(prompt.indexOf("VERDICT: approve"));
    expect(builder.calls[0]?.request.prompt).not.toContain("VERDICT");
    expect(logged(id)).toEqual([
      ["build#1", "passed", "Built it."],
      ["review#1", "failed", "One test is missing."],
      ["build#2", "passed", "Added a test."],
      ["review#2", "passed", "Ready to merge."],
    ]);
  });

  it("a step that carries on after a tamper question reads the reply from its file: the attempt still records the headline", SLOW, async () => {
    const loop = engine(fakeRuntime([edits({ ...FIXED, "package.json": "{}\n" }, "Done.\nHEADLINE: Fixed app.txt.")]));
    const id = await start(loop, template([BUILD_CHECKED]));
    expect(openDecision(id)?.kind).toBe("tamper");
    await answer(loop, id, "approve");
    expect(logged(id)).toEqual([["build#1", "passed", "Fixed app.txt."]]);
  });

});

describe("run loop: a template that reads its repo and commits nothing", () => {
  const READ = { uses: { repos: { picked: "read", named: [] }, connections: [], commands: [] }, finish: ["findings"] };
  const ask = () => template([{ id: "answer" }], READ);
  const mainTip = () => plain(repo.path, "rev-parse", "main");
  const said = (id: ItemId) => item(id).steps[0]?.attempts[0]?.said;

  it("takes the edit tools from the agent whatever its agent file says", SLOW, async () => {
    expect(AGENTS["builder"]?.limits.edit).toBe(true);
    const runtime = fakeRuntime([says("It rounds down.\nHEADLINE: It rounds down.")]);
    await start(engine(runtime), ask());
    expect(runtime.calls[0]?.request.limits?.edit).toBe(false);
  });

  it("a template that edits keeps the edit tools of the agent", SLOW, async () => {
    const runtime = fakeRuntime([edits(FIXED)]);
    await start(engine(runtime), template([{ id: "build" }]));
    expect(runtime.calls[0]?.request.limits?.edit).toBe(true);
  });

  it("ends done with the answer, no commit, and removes the worktree it did not need", SLOW, async () => {
    const before = await mainTip();
    const id = await start(engine(fakeRuntime([says("Rounding is in total.ts.\nHEADLINE: Totals round down.\nPOINT: total.ts:12")])), ask());
    const done = item(id);
    expect(done.state).toBe("done");
    expect(done.outcome).toMatchObject({ kind: "done", detail: "Nothing changed: the output is the result." });
    expect(done.outcome?.commits).toBeUndefined();
    expect(said(id)).toMatchObject({ headline: "Totals round down.", points: ["total.ts:12"], readMinutes: 1 });
    expect(story(id).slice(-3)).toEqual(["item_ended done", "finish_started", "discarded"]);
    expect(done.finish?.worktreeRemoved).toBe(true);
    expect(existsSync(worktreeDir(id))).toBe(false);
    expect(await plain(repo.path, "branch", "--list", done.worktrees[0]!.branch)).toBe("");
    expect(await mainTip()).toBe(before);
  });

  it("a cause outside the repo is a complete answer, not a failure", SLOW, async () => {
    const reply = "The text is not cut here.\nHEADLINE: The text already arrives cut from billing-api.\nPOINT: nothing in this repo shortens it";
    const id = await start(engine(fakeRuntime([says(reply)])), ask());
    expect(item(id).state).toBe("done");
    expect(item(id).outcome?.kind).toBe("done");
    expect(said(id)).toMatchObject({ headline: "The text already arrives cut from billing-api." });
    expect(story(id)).not.toContain("decision_opened");
  });

  it("a file the agent wrote anyway is never committed, and the worktree stays", SLOW, async () => {
    const before = await mainTip();
    const id = await start(engine(fakeRuntime([edits({ "notes.txt": "wrote\n" }, "Done.\nHEADLINE: Wrote a note.")])), ask());
    const done = item(id);
    expect(done.state).toBe("done");
    expect(done.outcome).toMatchObject({ kind: "done", detail: "1 file changed in the worktree; this template commits nothing." });
    expect(done.outcome?.commits).toBeUndefined();
    expect(story(id)).not.toContain("finish_started");
    expect(existsSync(join(worktreeDir(id), "notes.txt"))).toBe(true);
    expect(await plain(repo.path, "rev-parse", done.worktrees[0]!.branch)).toBe(before);
  });

  it("follows the picked repo: a template that names another repo with edit access gets no edit tools and commits nothing", SLOW, async () => {
    const named = template([{ id: "build" }], { uses: { repos: { picked: "read", named: [{ repoId: "billing-api", access: "edit" }] }, connections: [], commands: [] }, finish: ["commit"] });
    const runtime = fakeRuntime([edits(FIXED)]);
    const before = await mainTip();
    const id = await start(engine(runtime), named);
    expect(runtime.calls[0]?.request.limits?.edit).toBe(false);
    expect(item(id).outcome).toMatchObject({ kind: "done", detail: "1 file changed in the worktree; this template commits nothing." });
    expect(item(id).outcome?.commits).toBeUndefined();
    expect(await plain(repo.path, "rev-parse", item(id).worktrees[0]!.branch)).toBe(before);
  });

  it("an agent that commits on the item branch stops the item; the worktree and the branch stay", SLOW, async () => {
    const commits: Behavior = async function* ({ request }) {
      writeFileSync(join(request.cwd, "notes.txt"), "committed by the agent\n");
      await plain(request.cwd, "add", "-A");
      await plain(request.cwd, "commit", "-q", "-m", "agent commit");
      yield* says("Done.\nHEADLINE: Committed.")({ request, signal: new AbortController().signal });
    };
    const id = await start(engine(fakeRuntime([commits])), ask());
    expect(item(id).state).toBe("failed");
    expect(item(id).outcome?.detail).toContain("moved off its base commit");
    expect(story(id)).not.toContain("finish_started");
    expect(existsSync(worktreeDir(id))).toBe(true);
    expect(await plain(repo.path, "branch", "--list", item(id).worktrees[0]!.branch)).not.toBe("");
  });

  it("a template that may edit still commits, whatever its finish words", SLOW, async () => {
    const id = await start(engine(fakeRuntime([edits(FIXED)])), template([{ id: "build" }], { finish: ["findings"] }));
    expect(item(id).outcome?.commits).toHaveLength(1);
  });

  it("the prompt carries the headline rule", SLOW, async () => {
    const runtime = fakeRuntime([says("Yes.\nHEADLINE: Yes.")]);
    await start(engine(runtime), ask());
    expect(runtime.calls[0]?.request.prompt).toContain("HEADLINE: <one line");
  });
});

describe("run loop: a step you approve says no change is needed", () => {
  const PLAN_BUILD = () => template([{ id: "plan", doneWhen: "you approve", maxAttempts: 3 }, { id: "build" }]);
  const ANSWER = "The answer.\nHEADLINE: About half a day of work.\nPOINT: 4 files would change\nNO_CHANGE: yes";
  const mainTip = () => plain(repo.path, "rev-parse", "main");
  /** The loop that holds the item is the one that answers it. */
  let current: RunLoop;
  const started = async (runtime: AgentRuntime, tpl = PLAN_BUILD()): Promise<ItemId> => {
    current = engine(runtime);
    return start(current, tpl);
  };

  it("only a step you approve with a step after it is asked for the line", SLOW, async () => {
    const runtime = fakeRuntime([says(ANSWER)]);
    await started(runtime);
    expect(runtime.calls[0]?.request.prompt).toContain("NO_CHANGE: yes");
    const last = fakeRuntime([says(ANSWER)]);
    await started(last, template([{ id: "plan", doneWhen: "you approve" }]));
    expect(last.calls[0]?.request.prompt).not.toContain("NO_CHANGE");
    const first = fakeRuntime([edits(FIXED)]);
    await started(first, template([{ id: "build" }, { id: "plan", doneWhen: "you approve" }]));
    expect(first.calls[0]?.request.prompt).not.toContain("NO_CHANGE");
    const reviewed = fakeRuntime([says("Fine.\nHEADLINE: ok\nVERDICT: approve")]);
    await started(reviewed, template([{ id: "build" }, { id: "review", agentId: "reviewer", doneWhen: "reviewer approves", ifChangesRequested: { action: "ask" } }]));
    expect(reviewed.calls.every((call) => !call.request.prompt.includes("NO_CHANGE"))).toBe(true);
  });

  it("with the line and no changed file, the card proposes finishing: no Approve, the attempt records it", SLOW, async () => {
    const id = await started(fakeRuntime([says(ANSWER)]));
    const asked = openDecision(id)!;
    expect(asked).toMatchObject({ kind: "plan_approval", stepId: "plan", proposes: "no_change", change: { files: 0 } });
    expect(asked.choices.map((c) => c.id)).toEqual(["no_action_needed", "request_changes", "stop"]);
    expect(item(id).steps[0]?.attempts[0]?.said).toMatchObject({ headline: "About half a day of work.", points: ["4 files would change"], noChange: true, readMinutes: 1 });
    expect(item(id).state).toBe("needs_you");
  });

  it("Finish ends the item with its answer and removes the worktree it did not need", SLOW, async () => {
    const before = await mainTip();
    const id = await started(fakeRuntime([says(ANSWER)]));
    await answer(current, id, "no_action_needed");
    const ended = item(id);
    expect(ended).toMatchObject({ state: "done", outcome: { kind: "no_action_needed", detail: "No change needed: the answer is the result." } });
    expect(ended.outcome?.commits).toBeUndefined();
    expect(story(id).slice(-3)).toEqual(["item_ended no_action_needed", "finish_started", "discarded"]);
    expect(ended.finish?.worktreeRemoved).toBe(true);
    expect(existsSync(worktreeDir(id))).toBe(false);
    expect(await plain(repo.path, "branch", "--list", ended.worktrees[0]!.branch)).toBe("");
    expect(await mainTip()).toBe(before);
  });

  it("keeps the worktree when files appeared in it while the card waited", SLOW, async () => {
    const id = await started(fakeRuntime([says(ANSWER)]));
    writeFileSync(join(worktreeDir(id), "notes.txt"), "mine\n");
    await answer(current, id, "no_action_needed");
    expect(item(id).outcome?.kind).toBe("no_action_needed");
    expect(item(id).finish).toBeUndefined();
    expect(existsSync(join(worktreeDir(id), "notes.txt"))).toBe(true);
    expect(story(id)).not.toContain("finish_started");
    // There is no commit to merge or push, whatever the outcome.
    expect(await current.finishItem(id, "merge")).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  });

  it("ignores the line when the step changed a file: the usual question comes", SLOW, async () => {
    const id = await started(fakeRuntime([edits(FIXED, ANSWER)]));
    const asked = openDecision(id)!;
    expect(asked.proposes).toBeUndefined();
    expect(asked.choices.map((c) => c.id)).toEqual(["approve", "request_changes", "no_action_needed", "stop"]);
    expect(item(id).steps[0]?.attempts[0]?.said).not.toHaveProperty("noChange");
  });

  it("ignores a line that is not an exact yes, sits above the headline, or comes with no headline", SLOW, async () => {
    for (const reply of ["Text.\nHEADLINE: A.\nNO_CHANGE: no", "Text.\nHEADLINE: A.\nNO_CHANGE: yes, but build it", "NO_CHANGE: yes\nHEADLINE: A.", "Just text.\nNO_CHANGE: yes"]) {
      const id = await started(fakeRuntime([says(reply)]));
      expect(openDecision(id)?.proposes, reply).toBeUndefined();
    }
  });

  it("reads the line in any letter case and inside list or bold marks", SLOW, async () => {
    const id = await started(fakeRuntime([says("Text.\nHEADLINE: A.\n- **no_change**: YES")]));
    expect(openDecision(id)?.proposes).toBe("no_change");
  });

  it("Build anyway needs a note, runs the step again without the rule, and then asks the usual question", SLOW, async () => {
    const runtime = fakeRuntime([says(ANSWER)]);
    const id = await started(runtime);
    const first = openDecision(id)!;
    expect(await current.resolveDecision(id, first.id, "request_changes")).toMatchObject({ ok: false, error: { code: "invalid_request", message: expect.stringContaining("needs a note") } });
    expect(await current.resolveDecision(id, first.id, "request_changes", "   ")).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(openDecision(id)?.id).toBe(first.id);

    const resolved = await current.resolveDecision(id, first.id, "request_changes", "Yes, add it. CSV only.");
    if (!resolved.ok) throw new Error(resolved.error.message);
    await current.settled(id);
    expect(runtime.calls).toHaveLength(2);
    expect(runtime.calls[1]?.request.prompt).toContain("You asked for changes:\nYes, add it. CSV only.");
    expect(runtime.calls[1]?.request.prompt).not.toContain("NO_CHANGE");
    // The agent says the line again; it was not asked for, so the usual question comes.
    const again = openDecision(id)!;
    expect(again).toMatchObject({ kind: "plan_approval", stepId: "plan" });
    expect(again.proposes).toBeUndefined();
    expect(again.choices.map((c) => c.id)).toEqual(["approve", "request_changes", "no_action_needed", "stop"]);
    expect(item(id).steps[0]?.attempts[1]?.said).not.toHaveProperty("noChange");
    // A normal change request on the new plan does not bring the rule back.
    await answer(current, id, "request_changes", "plan_approval");
    expect(runtime.calls[2]?.request.prompt).not.toContain("NO_CHANGE");
  });

  it("the quiet End: no action needed of an ordinary plan question ends as before and keeps its worktree", SLOW, async () => {
    const id = await started(fakeRuntime([edits(FIXED)]));
    await answer(current, id, "no_action_needed");
    expect(item(id).outcome).toMatchObject({ kind: "no_action_needed", detail: "Ended: no action needed." });
    expect(item(id).finish).toBeUndefined();
    expect(existsSync(worktreeDir(id))).toBe(true);
  });
});
