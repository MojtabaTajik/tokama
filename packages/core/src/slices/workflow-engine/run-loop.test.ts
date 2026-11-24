import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
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
  TemplateRecordSchema,
  type AgentId,
  type ItemEvent,
  type ItemId,
  type RepoId,
  type StoredItem,
  type TemplateRecord,
} from "../../kernel/schemas/index.js";
import type { Agent, Repo } from "../config/index.js";
import { EVENTS_FILE, ItemStore, openDecisions, readLog } from "../items/index.js";
import { createWorktree } from "../worktrees/index.js";
import { createRunLoop, parseVerdict, type RunLoop, type RunLoopDeps } from "./index.js";
import { after, crashes, edits, editsThenCrashes, editsThenHangs, FAKE_PID, fakeRuntime, hangs, loops, says } from "./testing/fake-runtime.js";

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
    schemaVersion: 1,
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
    guard: { turnCap: 150, repeatLimit: 6, idleMs: 0, timeoutMs: 60_000 },
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
    // The check wrote check-output.txt after the tree was fixed: it is in the worktree, not the commit.
    expect(existsSync(join(worktreeDir(id), "check-output.txt"))).toBe(true);
    expect(await plain(repo.path, "ls-tree", "--name-only", commit!)).not.toContain("check-output.txt");
    // The agent got the item text, its role and the Tokama rules, in the worktree.
    expect(runtime.calls[0]?.request).toMatchObject({ cwd: worktreeDir(id), model: "qwen3-coder", timeoutMs: 60_000 });
    expect(runtime.calls[0]?.request.prompt).toContain("Fix the app");
    expect(runtime.calls[0]?.request.role).toContain("You are builder.");
  });

  it("agent finishes: the step passes when the agent completes; with no checks, Finish commits the worktree", SLOW, async () => {
    const loop = engine(fakeRuntime([edits(FIXED)]));
    const id = await start(loop, template([{ id: "build" }]));
    expect(item(id).state).toBe("done");
    expect(await plain(repo.path, "show", `${item(id).outcome?.commits?.[0]?.commit}:app.txt`)).toBe("fixed");
  });

  it("you approve: waits on plan_approval; Approve passes the step", SLOW, async () => {
    const loop = engine(fakeRuntime([edits(FIXED)]));
    const id = await start(loop, template([{ id: "plan", doneWhen: "you approve" }]));
    expect(item(id).state).toBe("needs_you");
    expect(openDecision(id)).toMatchObject({ kind: "plan_approval", stepId: "plan" });
    await answer(loop, id, "approve");
    expect(story(id).slice(-5)).toEqual(["attempt_ended plan#1 passed", "decision plan_approval plan", "resolved approve", "step_ended plan passed", "item_ended done"]);
  });

  it("you approve: Run again starts another attempt; End: no action needed ends the item early without failing", SLOW, async () => {
    const loop = engine(fakeRuntime([edits(FIXED)]));
    const id = await start(loop, template([{ id: "plan", doneWhen: "you approve", maxAttempts: 2 }]));
    await answer(loop, id, "retry_step");
    expect(item(id).steps[0]?.attempts).toHaveLength(2);
    await answer(loop, id, "no_action_needed");
    expect(item(id)).toMatchObject({ state: "done", outcome: { kind: "no_action_needed" } });
    expect(item(id).outcome?.commits).toBeUndefined();
  });

  it("reviewer approves: changes go back to build with the reviewer's words; build's count continues; approve finishes", SLOW, async () => {
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

  it("back continues the target step's count, and its limit asks", SLOW, async () => {
    // Each build makes the check fail another way, so it is never the same failure twice.
    const verify = { "verify.sh": "exit $(cat code.txt)\n" };
    const builder = fakeRuntime([edits({ ...verify, "code.txt": "4" }), edits({ ...verify, "code.txt": "5" })]);
    const checker = fakeRuntime([says("Ready for the checks.")]);
    const loop = engine(builder, { runtime: (a) => (a.id === "reviewer" ? checker : builder) });
    const tpl = template([
      { id: "build", maxAttempts: 2 },
      { id: "verify", agentId: "reviewer", doneWhen: "checks pass", checks: { commands: ["sh verify.sh"] }, ifFailed: { action: "back", stepId: "build" }, maxAttempts: 5 },
    ]);
    const id = await start(loop, tpl);
    // build#1, verify#1 fails, back: build#2, verify#2 fails, back: build is at its limit of 2.
    expect(item(id).steps.map((s) => s.attempts.length)).toEqual([2, 2]);
    expect(openDecision(id)).toMatchObject({ kind: "after_failure", stepId: "build", detail: expect.stringContaining("limit of 2") });
    await answer(loop, id, "stop");
    expect(item(id).state).toBe("stopped");
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
    const loop = engine(fakeRuntime([hangs(), edits(FIXED)]), { guard: { turnCap: 150, repeatLimit: 6, idleMs: 0, timeoutMs: 300 } });
    const id = await start(loop, template([{ ...BUILD_CHECKED, maxAttempts: 1 }]));
    expect(item(id).steps[0]?.attempts[0]).toMatchObject({ result: "run_failed", failure: "timeout" });
    expect(openDecision(id)?.kind).toBe("run_failure");
    await answer(loop, id, "retry_step");
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
    expect(await loop.stopItem(started.value)).toMatchObject({ ok: false, error: { code: "invalid_state" } });
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
    const loop = engine(fakeRuntime([editsThenHangs(TAMPER_FILES), edits(FIXED)]), { guard: { turnCap: 150, repeatLimit: 6, idleMs: 0, timeoutMs: 300 } });
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
