import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ManualClock, manualClock } from "../../kernel/clock/index.js";
import { READ_ONLY } from "../../kernel/ports/index.js";
import { err, ok } from "../../kernel/result/index.js";
import type { AgentCallEvent, AgentCallUsage, AiCliId, HelperRunPhase, HelperRunRequest } from "../../kernel/schemas/index.js";
import { loadAgents } from "../config/index.js";
import type { HelperDefinition } from "../helpers/index.js";
import { HELPER_LOCAL_ONLY, HELPER_NO_CLI } from "./helper-agent.js";
import { cleanCliText, createHelperRunner, type HelperGatherer, type HelperRunnerDeps, type HelperRunHooks, type PreparedHelperRun } from "./helper-runner.js";
import { crashes, FAKE_PID, fakeRuntime, hangs, type Behavior, type FakeRuntime } from "./testing/fake-runtime.js";
import { GOOD_ANSWER, testSuggestChecks } from "./testing/suggest-checks.js";

const TOKENS = { input: 1200, output: 80, cacheRead: 0, cacheWrite: 0 };
const REQUEST: HelperRunRequest = { helperId: "suggest-checks", input: { path: "/work/orders-api" } as never };
const NAMES = "package.json\nsrc/index.ts\n";
const BUILDS = '{ "scripts": { "test": "vitest run" } }';

const completed = (): AgentCallEvent => ({ type: "end", outcome: "completed", usage: TOKENS, costUsd: 0.004 });
/** One turn, one reply, done: what a helper does. */
const replies = (text: string): Behavior =>
  async function* () {
    yield { type: "turn" };
    yield { type: "text", text };
    yield completed();
  };
const answers = () => replies(JSON.stringify(GOOD_ANSWER));
const whenStopped = (signal: AbortSignal) => new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true })));
/** Asks for a tool after `turns` turns: past the cap. */
const toolAfter = (turns: number): Behavior =>
  async function* ({ signal }) {
    for (let i = 0; i < turns; i++) yield { type: "turn" };
    yield { type: "tool_call", id: "read-1", name: "Read", kind: "other", input: { file_path: "x" } };
    await whenStopped(signal);
    yield { type: "end", outcome: "aborted", usage: TOKENS };
  };

let home: string;
let scratch: string;
let clock: ManualClock;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "tk-helper-runner-")));
  scratch = join(home, "helper-scratch");
  clock = manualClock(Date.UTC(2026, 10, 27, 9));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

interface Setup {
  script?: readonly Behavior[];
  definitions?: readonly HelperDefinition[];
  gather?: HelperGatherer;
  cliStatus?: HelperRunnerDeps["cliStatus"];
  localOnly?: boolean;
  noRuntime?: boolean;
  personal?: string;
}

function setUp(setup: Setup = {}) {
  if (setup.personal !== undefined) {
    mkdirSync(join(home, "agents"), { recursive: true });
    writeFileSync(join(home, "agents", "helper.md"), setup.personal);
  }
  const runtime: FakeRuntime = fakeRuntime(setup.script ?? [answers()]);
  const gathered: unknown[] = [];
  const gather: HelperGatherer =
    setup.gather ??
    (async (input) => {
      gathered.push(input);
      return ok({ "repo-file-names": NAMES, "repo-build-files": BUILDS });
    });
  const runner = createHelperRunner({
    clock,
    definitions: setup.definitions ?? [testSuggestChecks],
    gatherers: { "suggest-checks": gather },
    agents: () => loadAgents({ tokamaHome: home }),
    cliStatus: setup.cliStatus ?? (async () => ({ ready: true })),
    cliName: (cliId: AiCliId) => (cliId === "claude-code" ? "Claude Code" : cliId),
    runtime: () => (setup.noRuntime === true ? undefined : runtime),
    localOnly: () => setup.localOnly === true,
    scratchDir: scratch,
    folders: [[home, "~/.tokama"]],
  });
  return { runner, runtime, gathered };
}

/** The hooks of a run, and what they were told. */
const hooksFor = (): HelperRunHooks & { phases: HelperRunPhase[]; pids: number[]; usage: AgentCallUsage[] } => {
  const phases: HelperRunPhase[] = [];
  const pids: number[] = [];
  const usage: AgentCallUsage[] = [];
  return { phases, pids, usage, onPhase: (phase) => void phases.push(phase), onProcess: (pid) => void pids.push(pid), onUsage: (call) => void usage.push(call) };
};

async function prepared(runner: ReturnType<typeof setUp>["runner"]): Promise<PreparedHelperRun> {
  const result = await runner.prepare(REQUEST, "accepted");
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
async function run(setup: Setup = {}, signal: AbortSignal = new AbortController().signal) {
  const world = setUp(setup);
  const hooks = hooksFor();
  const outcome = await world.runner.run(await prepared(world.runner), hooks, signal);
  return { ...world, hooks, outcome };
}

describe("a helper run", () => {
  it("gathers, asks once and returns the valid answer, with the usage of the call", async () => {
    const { outcome, hooks, runtime, gathered } = await run();
    expect(outcome).toMatchObject({ state: "done", result: GOOD_ANSWER, usage: { tokens: TOKENS, costUsd: 0.004 } });
    expect(gathered).toEqual([REQUEST.input]);
    expect(runtime.calls).toHaveLength(1);
    expect(hooks.phases).toEqual(["asking"]);
    expect(hooks.pids).toEqual([FAKE_PID]);
    expect(hooks.usage).toHaveLength(1);
    expect(hooks.usage[0]).toMatchObject({ stepId: "suggest-checks", attempt: 1, agentId: "helper", cliId: "claude-code", model: "haiku", outcome: "completed", tokens: TOKENS });
  });

  it("asks with exactly the request a read-only helper needs: Tokama's folder, read-only limits, the helper's time, no sandbox", async () => {
    const { runtime } = await run();
    const { request } = runtime.calls[0]!;
    expect(Object.keys(request).sort()).toEqual(["cwd", "limits", "model", "plain", "prompt", "role", "timeoutMs"]);
    // The answer must depend on the prompt alone, not on the person's own instruction files or hooks.
    expect(request.plain).toBe(true);
    expect(request.model).toBe("haiku");
    expect(request.cwd).toBe(scratch);
    expect(request.limits).toEqual(READ_ONLY);
    expect(request.sandbox).toBeUndefined();
    expect(request.timeoutMs).toBe(90_000);
    expect(request.prompt).toContain(NAMES);
    expect(request.prompt).toContain(BUILDS);
  });

  it("shows the agent the answer's shape with every rule the engine checks: required keys, no other keys, whole minutes from 1 to 120, at most 4 checks", async () => {
    const { runtime } = await run();
    const prompt = runtime.calls[0]!.request.prompt;
    const shape = JSON.parse(prompt.slice(prompt.indexOf("{\n"), prompt.indexOf("\n}\n\n") + 2)) as Record<string, unknown>;
    expect(JSON.stringify(shape)).toContain('"additionalProperties":false');
    expect(shape).toMatchObject({ type: "object", required: ["checks"], properties: { checks: { type: "array", maxItems: 4, items: { required: ["command", "why", "minutes"], properties: { minutes: { type: "integer", minimum: 1, maximum: 120 }, why: { maxLength: 200 } } } } } });
  });

  it("keeps read-only limits for a personal agent file that allows edits, commands and the web, and uses the file's model", async () => {
    const personal = "---\nformat: 1\nname: My helper\nruns_on: claude-code\nmodel: sonnet\ntools: edit\ncommands: [\"pnpm test:*\"]\nweb: true\n---\nBe brief.\n";
    const { runtime } = await run({ personal });
    const { request } = runtime.calls[0]!;
    expect(request.limits).toEqual({ edit: false, commands: [], web: false });
    expect(request.sandbox).toBeUndefined();
    expect(request.model).toBe("sonnet");
    expect(request.role).toContain("Be brief.");
  });

  it("takes the time of the definition for the call, per try", async () => {
    const { runtime } = await run({ definitions: [{ ...testSuggestChecks, maxTimeMs: 45_000 }] });
    expect(runtime.calls[0]!.request.timeoutMs).toBe(45_000);
  });

  it("records names and sizes, the target and that the prompt went to the cloud, and no input text or answer", async () => {
    const { outcome } = await run();
    expect(outcome.record).toMatchObject({
      helperId: "suggest-checks",
      helperVersion: 3,
      target: { agentId: "helper", cliId: "claude-code", model: "haiku" },
      sentToCloud: true,
      inputs: [
        { name: "repo-file-names", bytes: Buffer.byteLength(NAMES) },
        { name: "repo-build-files", bytes: Buffer.byteLength(BUILDS) },
      ],
    });
    expect(outcome.record.tries).toHaveLength(1);
    expect(outcome.record.tries[0]).toMatchObject({ attempt: 1, end: { outcome: "completed" }, guard: { stop: null } });
    const text = JSON.stringify(outcome.record);
    expect(text).not.toContain("package.json");
    expect(text).not.toContain("vitest run");
    expect(text).not.toContain("pnpm test");
  });

  it("asks a second time after a bad answer, with a note that does not repeat the answer, and records both calls", async () => {
    const bad = JSON.stringify({ checks: [{ command: "SECRET-TEXT", why: "x", minutes: 0 }] });
    const { outcome, hooks, runtime } = await run({ script: [replies(bad), answers()] });
    expect(outcome).toMatchObject({ state: "done", result: GOOD_ANSWER, usage: { tokens: { input: 2400, output: 160, cacheRead: 0, cacheWrite: 0 } } });
    expect(hooks.phases).toEqual(["asking", "retrying"]);
    expect(hooks.usage.map((usage) => usage.attempt)).toEqual([1, 2]);
    expect(runtime.calls).toHaveLength(2);
    expect(runtime.calls[1]!.request.prompt).toContain("checks.0.minutes");
    expect(runtime.calls[1]!.request.prompt).not.toContain("SECRET-TEXT");
    expect(runtime.calls[1]!.request.prompt).not.toBe(runtime.calls[0]!.request.prompt);
    expect(outcome.record.tries.map((entry) => entry.attempt)).toEqual([1, 2]);
  });

  it("fails with bad_answer after two bad answers, and makes no third call", async () => {
    const { outcome, runtime, hooks } = await run({ script: [replies("no json here"), replies("{}")] });
    expect(outcome).toMatchObject({ state: "failed", error: { code: "bad_answer", message: "The helper's answer was not valid twice. Try again." } });
    expect(runtime.calls).toHaveLength(2);
    expect(hooks.usage).toHaveLength(2);
  });

  it("applies the helper's own rule: a command with && is a bad answer", async () => {
    const rule = JSON.stringify({ checks: [{ command: "pnpm lint && pnpm test", why: "Both.", minutes: 2 }] });
    const { runtime } = await run({ script: [replies(rule), answers()] });
    expect(runtime.calls[1]!.request.prompt).toContain("a check holds more than one command.");
  });

  it("is cancelled when the signal fires during the call, and still records the call", async () => {
    const controller = new AbortController();
    const { outcome, hooks } = await run({ script: [hangs(() => controller.abort())] }, controller.signal);
    expect(outcome).toMatchObject({ state: "cancelled" });
    expect(outcome.error).toBeUndefined();
    expect(hooks.usage).toHaveLength(1);
  });

  it("is cancelled when the signal fires before the call", async () => {
    const controller = new AbortController();
    const world = setUp({ gather: async () => (controller.abort(), ok({ "repo-file-names": NAMES, "repo-build-files": BUILDS })) });
    const outcome = await world.runner.run(await prepared(world.runner), hooksFor(), controller.signal);
    expect(outcome.state).toBe("cancelled");
    expect(world.runtime.calls).toHaveLength(0);
  });

  it("is a timeout when the call runs out its time while the agent keeps sending events", async () => {
    const slowly: Behavior = async function* ({ signal }) {
      for (let step = 0; step < 4 && !signal.aborted; step++) {
        clock.advance(30_000);
        yield { type: "turn" };
      }
      await whenStopped(signal);
      yield { type: "end", outcome: "aborted", usage: TOKENS };
    };
    const { outcome, runtime } = await run({ script: [slowly] });
    expect(outcome).toMatchObject({ state: "failed", error: { code: "timeout", message: "The helper took longer than 90 seconds." } });
    expect(runtime.calls).toHaveLength(1);
  });

  it("is a timeout after a minute of silence", async () => {
    const { outcome } = await run({ script: [hangs(() => clock.advance(60_000))] });
    expect(outcome).toMatchObject({ state: "failed", error: { code: "timeout", message: "The helper went silent and was stopped." } });
  });

  it("fails with crash when the agent asks for a tool: it should answer in one turn", async () => {
    const { outcome } = await run({ script: [toolAfter(3)] });
    expect(outcome).toMatchObject({ state: "failed", error: { code: "crash", message: "The helper did not answer in one turn." } });
  });

  it.each(["quota", "rate_limit", "auth", "crash"] as const)("keeps the error kind %s of a failed call", async (kind) => {
    const { outcome } = await run({ script: [crashes(kind, "it did not work")] });
    expect(outcome).toMatchObject({ state: "failed", error: { code: kind, message: "it did not work" } });
  });

  it("cleans a CLI's error text: no escape sequences, no Tokama folder, cut short", async () => {
    const text = `\u001b[31mError\u001b[0m reading ${home}/agents/helper.md\n${"x".repeat(500)}`;
    const { outcome } = await run({ script: [crashes("crash", text)] });
    expect(outcome.error?.message).toContain("Error reading ~/.tokama/agents/helper.md");
    expect(outcome.error?.message).not.toContain(home);
    expect(outcome.error?.message).not.toContain("\u001b");
    expect(outcome.error?.message.length).toBeLessThanOrEqual(300);
    expect(JSON.stringify(outcome.record)).not.toContain(home);
  });

  it("fails with crash when the gatherer fails, throws or leaves an input out", async () => {
    const failing = await run({ gather: async () => err(`could not read ${home}/repo`) });
    expect(failing.outcome).toMatchObject({ state: "failed", error: { code: "crash", message: "could not read ~/.tokama/repo" } });
    const throwing = await run({ gather: async () => Promise.reject(new Error("boom")) });
    expect(throwing.outcome).toMatchObject({ state: "failed", error: { code: "crash", message: expect.stringContaining("boom") } });
    const missing = await run({ gather: async () => ok({ "repo-file-names": NAMES }) });
    expect(missing.outcome).toMatchObject({ state: "failed", error: { code: "crash", message: expect.stringContaining("repo-build-files") } });
    for (const world of [failing, throwing, missing]) expect(world.runtime.calls).toHaveLength(0);
  });

  it("fails with too_large, without a call, when an input is over its cap or the inputs are over 96 KiB together", async () => {
    const big = await run({ gather: async () => ok({ "repo-file-names": "x".repeat(16 * 1024 + 1), "repo-build-files": BUILDS }) });
    expect(big.outcome).toMatchObject({ state: "failed", error: { code: "too_large", message: expect.stringContaining("repo-file-names") } });
    const together = await run({ gather: async () => ok({ "repo-file-names": "x".repeat(16 * 1024), "repo-build-files": "y".repeat(80 * 1024 + 1) }) });
    expect(together.outcome.error?.code).toBe("too_large");
    expect(big.runtime.calls).toHaveLength(0);
    expect(together.runtime.calls).toHaveLength(0);
  });
});

describe("the refusals, before anything is gathered or asked", () => {
  async function refused(setup: Setup, accepted = true) {
    const world = setUp(setup);
    const result = await world.runner.prepare(REQUEST, accepted ? "accepted" : undefined);
    if (result.ok) throw new Error("expected a refusal");
    expect(world.gathered).toEqual([]);
    expect(world.runtime.calls).toEqual([]);
    return result.error;
  }

  it("refuses a helper that is not in the list", async () => {
    expect(await refused({ definitions: [] })).toEqual({ code: "helper_unavailable", message: "This helper is not in this engine yet." });
  });

  it("refuses a helper that has a definition but no gatherer", async () => {
    const runner = createHelperRunner({
      clock,
      definitions: [testSuggestChecks],
      gatherers: {},
      agents: () => loadAgents({ tokamaHome: home }),
      cliStatus: async () => ({ ready: true }),
      cliName: () => "Claude Code",
      runtime: () => fakeRuntime([]),
      localOnly: () => false,
      scratchDir: scratch,
      folders: [],
    });
    const result = await runner.prepare(REQUEST, "accepted");
    expect(result).toEqual({ ok: false, error: { code: "helper_unavailable", message: "This helper is not in this engine yet." } });
  });

  it("refuses a broken agent file with its problem", async () => {
    expect(await refused({ personal: "nonsense" })).toMatchObject({ code: "helper_unavailable", message: expect.stringContaining("The agent helper does not load") });
  });

  it("refuses an ollama agent", async () => {
    const ollama = "---\nformat: 1\nname: Local\nruns_on: ollama\ndriven_by: claude-code\nmodel: qwen3-coder:30b\ntools: read-only\n---\n";
    expect(await refused({ personal: ollama })).toMatchObject({ code: "helper_unavailable", message: expect.stringContaining("ollama") });
  });

  it("refuses a cloud agent in local-only mode", async () => {
    expect(await refused({ localOnly: true })).toEqual({ code: "helper_unavailable", message: HELPER_LOCAL_ONLY });
  });

  it("refuses when this build has no runtime for the CLI, or the CLI is not ready", async () => {
    expect(await refused({ noRuntime: true })).toEqual({ code: "helper_unavailable", message: HELPER_NO_CLI });
    expect(await refused({ cliStatus: async () => ({ ready: false, problem: "Claude Code is installed but not logged in." }) })).toEqual({ code: "helper_unavailable", message: HELPER_NO_CLI });
  });

  it("refuses a personal agent whose CLI is logged out with the CLI's words, and cleans them", async () => {
    const personal = "---\nformat: 1\nname: My helper\nruns_on: claude-code\nmodel: sonnet\ntools: read-only\n---\n";
    const cliStatus = async () => ({ ready: false, problem: `\u001b[1mNot logged in\u001b[0m (see ${home}/login.log)` });
    expect(await refused({ personal, cliStatus })).toEqual({ code: "helper_unavailable", message: "Not logged in (see ~/.tokama/login.log)" });
  });

  it("refuses a cloud agent without the person's OK, saying what would be sent where", async () => {
    expect(await refused({}, false)).toEqual({ code: "cloud_not_accepted", message: "Sends file names and build files of this folder to Claude Code · haiku." });
  });

  it("takes a cloud agent with the OK, and shows the agent it chose", async () => {
    const world = setUp();
    const result = await world.runner.prepare(REQUEST, "accepted");
    expect(result).toMatchObject({ ok: true, value: { agent: { agentId: "helper", name: "Helper", cliId: "claude-code", model: "haiku", runsOn: "cloud" } } });
  });
});

describe("the helpers list", () => {
  it("lists an available helper with its agent and what it sends", async () => {
    expect(await setUp().runner.list()).toEqual([
      {
        helperId: "suggest-checks",
        name: "Suggest checks",
        version: 3,
        available: true,
        agent: { agentId: "helper", name: "Helper", cliId: "claude-code", model: "haiku", runsOn: "cloud" },
        sends: ["file names", "build files"],
      },
    ]);
  });

  it("says why a helper cannot run, and names no agent when none is chosen", async () => {
    const [summary] = await setUp({ cliStatus: async () => ({ ready: false }) }).runner.list();
    expect(summary).toMatchObject({ available: false, problem: HELPER_NO_CLI });
    expect(summary).not.toHaveProperty("agent");
  });

  it("names a personal agent that is not ready, with the problem", async () => {
    const personal = "---\nformat: 1\nname: My helper\nruns_on: claude-code\nmodel: sonnet\ntools: read-only\n---\n";
    const [summary] = await setUp({ personal, cliStatus: async () => ({ ready: false, problem: "Claude Code is installed but not logged in." }) }).runner.list();
    expect(summary).toMatchObject({ available: false, problem: "Claude Code is installed but not logged in.", agent: { name: "My helper", model: "sonnet" } });
  });

  it("is empty when the engine has no helpers", async () => {
    expect(await setUp({ definitions: [] }).runner.list()).toEqual([]);
  });
});

describe("the helper's working folder", () => {
  it("is made when missing, with mode 0700", async () => {
    await run();
    expect(statSync(scratch).isDirectory()).toBe(true);
    expect(statSync(scratch).mode & 0o777).toBe(0o700);
  });

  it("is emptied before the call when something is in it", async () => {
    mkdirSync(join(scratch, "old"), { recursive: true });
    writeFileSync(join(scratch, "old", "notes.txt"), "left over");
    writeFileSync(join(scratch, "stray.txt"), "stray");
    const { outcome } = await run();
    expect(outcome.state).toBe("done");
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("gets its mode back to 0700 when it was loosened", async () => {
    mkdirSync(scratch);
    chmodSync(scratch, 0o755);
    await run();
    expect(statSync(scratch).mode & 0o777).toBe(0o700);
  });

  it("is never followed when it is a link: the run fails and the link's target is untouched", async () => {
    const target = join(home, "elsewhere");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "mine");
    symlinkSync(target, scratch);
    const { outcome, runtime } = await run();
    expect(outcome).toMatchObject({ state: "failed", error: { code: "crash", message: "The helper's working folder is not a plain folder." } });
    expect(runtime.calls).toHaveLength(0);
    expect(readdirSync(target)).toEqual(["keep.txt"]);
  });

  it("fails with its folder written as a name when the folder cannot be read", async () => {
    const world = setUp();
    const ready = await prepared(world.runner);
    chmodSync(home, 0o000);
    try {
      const outcome = await world.runner.run(ready, hooksFor(), new AbortController().signal);
      expect(outcome).toMatchObject({ state: "failed", error: { code: "crash", message: expect.stringContaining("~/.tokama/helper-scratch") } });
      expect(outcome.error?.message).not.toContain(home);
    } finally {
      chmodSync(home, 0o700);
    }
  });

  it("fails when a file is in its place, and leaves the file", async () => {
    writeFileSync(scratch, "a file");
    const { outcome } = await run();
    expect(outcome).toMatchObject({ state: "failed", error: { code: "crash" } });
    expect(existsSync(scratch)).toBe(true);
    expect(statSync(scratch).isFile()).toBe(true);
  });

  it("is not emptied while another helper call is under way", async () => {
    let started = () => {};
    const underWay = new Promise<void>((resolve) => (started = resolve));
    const controller = new AbortController();
    const world = setUp({ script: [hangs(() => started()), answers()] });
    const first = world.runner.run(await prepared(world.runner), hooksFor(), controller.signal);
    await underWay;
    writeFileSync(join(scratch, "other-call.txt"), "in use");
    const second = await world.runner.run(await prepared(world.runner), hooksFor(), new AbortController().signal);
    expect(second.state).toBe("done");
    expect(existsSync(join(scratch, "other-call.txt"))).toBe(true);
    controller.abort();
    expect((await first).state).toBe("cancelled");
    // Alone again, the next call empties it.
    const third = setUp();
    await third.runner.run(await prepared(third.runner), hooksFor(), new AbortController().signal);
    expect(readdirSync(scratch)).toEqual([]);
  });
});

describe("definitions", () => {
  const options = (definitions: readonly HelperDefinition[]) => ({
    clock,
    definitions,
    gatherers: {},
    agents: () => loadAgents({ tokamaHome: home }),
    cliStatus: async () => ({ ready: true }),
    cliName: () => "Claude Code",
    runtime: () => undefined,
    localOnly: () => false,
    scratchDir: scratch,
    folders: [],
  });

  it("refuses to start with a wrong definition or two with one id", () => {
    expect(() => createHelperRunner(options([{ ...testSuggestChecks, maxTimeMs: 10 * 60_000 }]))).toThrow("maxTimeMs");
    expect(() => createHelperRunner(options([testSuggestChecks, testSuggestChecks]))).toThrow("same id");
  });
});

describe("cleanCliText", () => {
  it("removes escape sequences, writes folders as names (the longest first) and cuts", () => {
    expect(cleanCliText("\u001b[31mred\u001b[0m /a/b/c and /a/b", [["/a/b", "B"], ["/a/b/c", "C"]])).toBe("red C and B");
    expect(cleanCliText("x".repeat(400), [])).toHaveLength(300);
  });
});
