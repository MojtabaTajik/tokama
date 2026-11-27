// Helper runs in a real engine, through the real client and socket: the commands and queries, the
// events, the helper log, `call.json`, usage, the stop path and the restart cleanup. The home is a
// temp folder, so the owner's Tokama home is never touched, and no AI runs: a scripted runtime
// answers, or a runner that records the argv of the real Claude Code adapter.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type EngineClient } from "@tokama/client";
import {
  API_VERSION,
  type AgentCallEvent,
  type AgentCallRequest,
  type AgentRuntime,
  type EngineEvent,
  type HelperDefinition,
  type HelperRun,
  loadHostId,
  type Clock,
  manualClock,
  ok,
  systemClock,
  type ProcessRunner,
  type ProcessTable,
  type RunRequest,
  type UsageReport,
} from "@tokama/core";
import { afterEach, describe, expect, it } from "vitest";
import { startEngine } from "../engine.js";
import { rawConnect, tempEngineDir, waitFor } from "../testing/helpers.js";
import type { HealthChecks } from "./health.js";

const NOW = Date.UTC(2026, 10, 27, 9);
const NO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const TOKENS = { input: 1200, output: 80, cacheRead: 0, cacheWrite: 0 };
const NAMES = "package.json\nsrc/orders.ts\n";
const BUILDS = '{ "name": "orders-api", "scripts": { "test": "vitest run" } }';
const GOOD = { checks: [{ command: "pnpm test", why: "Runs the unit tests.", minutes: 3 }] };
const DISCLOSURE = "Sends file names and build files of this folder to Claude Code · haiku.";
const RUN_ID = "hrun_0b9f3c1e-6a2d-4f7b-9c1a-2e3d4f5a6b7c";
const TRIAL_ID = "trial_1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

const healthy: HealthChecks = async () => ({ git: { ok: true, version: "git version 2.54.0" }, clis: [{ cliId: "claude-code", installed: true, loggedIn: true }] });
const loggedOut: HealthChecks = async () => ({ git: { ok: true, version: "git version 2.54.0" }, clis: [{ cliId: "claude-code", installed: true, loggedIn: false }] });

const suggestChecks: HelperDefinition = {
  id: "suggest-checks",
  version: 3,
  name: "Suggest checks",
  inputs: ["repo-file-names", "repo-build-files"],
  maxTimeMs: 90_000,
  agentId: "helper" as HelperDefinition["agentId"],
  instructions: "Propose the commands that prove a change to this repository is correct.",
  example: { checks: [{ command: "pnpm test", why: "Runs the unit tests.", minutes: 5 }] },
};
const helpers = { definitions: [suggestChecks], gatherers: { "suggest-checks": async () => ok({ "repo-file-names": NAMES, "repo-build-files": BUILDS }) } } as const;

let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

const whenStopped = (signal: AbortSignal) => new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true })));

/** What the agent does on each call, in order (the last entry repeats). */
type Behavior = "answers" | "hangs" | { readonly says: string };
function scripted(script: readonly Behavior[]): AgentRuntime & { readonly requests: AgentCallRequest[] } {
  const requests: AgentCallRequest[] = [];
  return {
    requests,
    async *launch(request, signal) {
      const behavior = script[Math.min(requests.length, script.length - 1)]!;
      requests.push(request);
      yield { type: "started", pid: 4242 } satisfies AgentCallEvent;
      yield { type: "turn" };
      if (behavior === "hangs") {
        await whenStopped(signal);
        yield { type: "end", outcome: "aborted", usage: NO_TOKENS };
        return;
      }
      yield { type: "text", text: behavior === "answers" ? JSON.stringify(GOOD) : behavior.says };
      yield { type: "end", outcome: "completed", usage: TOKENS, costUsd: 0.004 };
    },
  };
}

const table = (alive: { pid: number; startedAt: number }[] = []): ProcessTable & { readonly signals: [number, string][] } => {
  const signals: [number, string][] = [];
  return {
    signals,
    list: async () => alive.filter((proc) => !signals.some(([pgid]) => pgid === proc.pid)).map((proc) => ({ ...proc, ppid: 1, pgid: proc.pid })),
    bootTime: () => Date.UTC(2026, 10, 1),
    signalGroup: (pgid, signal) => void signals.push([pgid, signal]),
  };
};

interface Fixture {
  readonly client: EngineClient;
  /** The engine's clock: a manual one unless the test asks for the system's. */
  readonly clock: Clock;
  readonly events: EngineEvent[];
  readonly home: string;
  readonly root: string;
  readonly socketPath: string;
  readonly tokenPath: string;
  readonly stop: () => Promise<void>;
}

async function engine(
  options: { runtime?: AgentRuntime; helpers?: typeof helpers; checks?: HealthChecks; processTable?: ProcessTable; runner?: ProcessRunner; clock?: Clock; prepare?: (home: string, clock: Clock) => void } = {},
): Promise<Fixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tk-helpers-")));
  const home = join(root, "home");
  mkdirSync(home);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const clock = options.clock ?? manualClock(NOW);
  options.prepare?.(home, clock);
  const dir = tempEngineDir(cleanups);
  const started = await startEngine({
    dir,
    home,
    clock,
    processTable: options.processTable ?? table(),
    checks: options.checks ?? healthy,
    recoveryGraceMs: 0,
    planSources: {},
    ...(options.runtime !== undefined && { runtime: () => options.runtime }),
    ...(options.helpers !== undefined && { helpers: options.helpers }),
    ...(options.runner !== undefined && { runner: options.runner }),
  });
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
  return { client: connected.value, clock, events, home, root, socketPath: started.value.endpoint.socketPath, tokenPath: started.value.endpoint.tokenPath, stop };
}

const runHelper = (client: EngineClient, cloud = true) =>
  client.command({ type: "run_helper", run: { helperId: "suggest-checks", input: { path: "/work/orders-api" } }, ...(cloud && { cloud: "accepted" as const }) });

async function startRun(fixture: Fixture): Promise<string> {
  const reply = await runHelper(fixture.client);
  if (!reply.ok) throw new Error(reply.error.message);
  return reply.data.runId;
}

const updates = (events: readonly EngineEvent[], runId: string): HelperRun[] => events.flatMap((event) => (event.type === "helper_run_updated" && event.run.runId === runId ? [event.run] : []));

/** Lets the first update of a run go out, then waits for the run to end. */
async function ended(fixture: Fixture, runId: string): Promise<HelperRun> {
  if ("advance" in fixture.clock && typeof fixture.clock.advance === "function") fixture.clock.advance(0);
  await waitFor(() => updates(fixture.events, runId).some((run) => run.state !== "running"), 5_000, `the end of ${runId}`);
  return updates(fixture.events, runId).at(-1)!;
}

const usage = async (client: EngineClient): Promise<UsageReport> => {
  const reply = await client.query({ type: "usage" });
  if (!reply.ok) throw new Error(reply.error.message);
  return reply.data;
};

const files = (folder: string): string[] => (existsSync(folder) ? readdirSync(folder, { recursive: true }).map(String) : []);
const everythingIn = (folder: string): string => files(folder).flatMap((name) => (statSync(join(folder, name)).isFile() ? [readFileSync(join(folder, name), "utf8")] : [])).join("\n");
/** Every line of every monthly log file, oldest file first. */
const logLines = (home: string): Record<string, unknown>[] =>
  files(join(home, "helper-runs"))
    .filter((name) => /^events-.*\.jsonl$/.test(name))
    .sort()
    .flatMap((name) => readFileSync(join(home, "helper-runs", name), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>));

describe("a real engine with no helpers built in", () => {
  it("lists none and refuses to run one, and does not know any run", async () => {
    const { client } = await engine();
    expect(await client.query({ type: "helpers" })).toMatchObject({ ok: true, data: { helpers: [] } });
    expect(await runHelper(client)).toMatchObject({ ok: false, error: { code: "helper_unavailable", message: "This helper is not in this engine yet." } });
    expect(await client.command({ type: "cancel_helper", runId: RUN_ID as never })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await client.query({ type: "helper_run", runId: RUN_ID as never })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("still answers Try checks with not_implemented", async () => {
    const { client } = await engine();
    const notImplemented = { ok: false, error: { code: "not_implemented", message: "Try checks is not in this engine yet." } };
    expect(await client.command({ type: "try_checks", path: "/work/orders-api", checks: [{ command: "pnpm test" }] })).toMatchObject(notImplemented);
    expect(await client.command({ type: "cancel_check_trial", trialId: TRIAL_ID as never })).toMatchObject(notImplemented);
    expect(await client.query({ type: "check_trial", trialId: TRIAL_ID as never })).toMatchObject(notImplemented);
  });

  it("lists no helper calls in its usage report", async () => {
    const { client } = await engine();
    expect((await usage(client)).week?.helpers).toEqual([]);
  });

  it("makes no folder for helpers until one runs", async () => {
    const { home } = await engine();
    expect(files(home).filter((name) => name.startsWith("helper"))).toEqual([]);
  });
});

describe("the helpers query", () => {
  it("lists a helper with the built-in Helper agent and what it sends", async () => {
    const { client } = await engine({ helpers });
    expect(await client.query({ type: "helpers" })).toMatchObject({
      ok: true,
      data: { helpers: [{ helperId: "suggest-checks", name: "Suggest checks", version: 3, available: true, agent: { agentId: "helper", name: "Helper", cliId: "claude-code", model: "haiku", runsOn: "cloud" }, sends: ["file names", "build files"] }] },
    });
  });

  it("says why a helper cannot run, with no agent, when no AI CLI is ready", async () => {
    const { client } = await engine({ helpers, checks: loggedOut });
    const reply = await client.query({ type: "helpers" });
    if (!reply.ok) throw new Error(reply.error.message);
    expect(reply.data.helpers[0]).toMatchObject({ available: false, problem: "No AI CLI is ready. Set up an AI CLI: install Claude Code and log in, then try again." });
    expect(reply.data.helpers[0]).not.toHaveProperty("agent");
    expect(await runHelper(client)).toMatchObject({ ok: false, error: { code: "helper_unavailable" } });
  });

  it("names a personal agent whose CLI is logged out, with the CLI's words, and never falls back", async () => {
    const { client } = await engine({
      helpers,
      checks: loggedOut,
      prepare: (home) => {
        mkdirSync(join(home, "agents"));
        writeFileSync(join(home, "agents", "helper.md"), "---\nformat: 1\nname: My helper\nruns_on: claude-code\nmodel: sonnet\ntools: read-only\n---\n");
      },
    });
    const reply = await client.query({ type: "helpers" });
    if (!reply.ok) throw new Error(reply.error.message);
    expect(reply.data.helpers[0]).toMatchObject({ available: false, problem: "Claude Code is installed but not logged in.", agent: { name: "My helper", model: "sonnet" } });
  });
});

describe("run_helper", () => {
  it("refuses a cloud agent without the person's OK, saying what would be sent where", async () => {
    const runtime = scripted(["answers"]);
    const { client } = await engine({ runtime, helpers });
    expect(await runHelper(client, false)).toMatchObject({ ok: false, error: { code: "cloud_not_accepted", message: DISCLOSURE } });
    expect(runtime.requests).toHaveLength(0);
  });

  it("replies with the run id first, then sends the phases and the answer as events", async () => {
    const runtime = scripted(["answers"]);
    const fixture = await engine({ runtime, helpers });
    const runId = await startRun(fixture);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(updates(fixture.events, runId)).toEqual([]);

    const run = await ended(fixture, runId);
    expect(run).toMatchObject({ runId, helperId: "suggest-checks", helperVersion: 3, state: "done", result: { helperId: "suggest-checks", value: GOOD }, agent: { agentId: "helper", cliId: "claude-code", model: "haiku" }, usage: { tokens: TOKENS, costUsd: 0.004 } });
    expect(run.phase).toBeUndefined();
    expect(await fixture.client.query({ type: "helper_run", runId: runId as never })).toMatchObject({ ok: true, data: { run: { runId, state: "done" } } });
    await waitFor(() => fixture.events.some((event) => event.type === "usage_changed"), 5_000, "usage_changed");
  });

  it("sends the asking phase while the agent works, then the end, and the retrying phase after a bad answer", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls: string[] = [];
    const runtime: AgentRuntime = {
      async *launch() {
        calls.push("call");
        yield { type: "started", pid: 4242 };
        yield { type: "turn" };
        if (calls.length === 1) await gate;
        yield { type: "text", text: calls.length === 1 ? "no json" : JSON.stringify(GOOD) };
        yield { type: "end", outcome: "completed", usage: TOKENS };
      },
    };
    const fixture = await engine({ runtime, helpers });
    const runId = await startRun(fixture);
    await waitFor(() => calls.length === 1, 5_000, "the first call");
    expect(updates(fixture.events, runId)).toEqual([]);
    if ("advance" in fixture.clock && typeof fixture.clock.advance === "function") fixture.clock.advance(0);
    await waitFor(() => updates(fixture.events, runId).length === 1, 5_000, "the first update");
    expect(updates(fixture.events, runId)[0]).toMatchObject({ state: "running", phase: "asking" });
    release();
    await waitFor(() => updates(fixture.events, runId).some((run) => run.state === "done"), 5_000, "the end");
    expect(updates(fixture.events, runId).map((run) => run.phase ?? run.state)).toEqual(["asking", "retrying", "done"]);
  });

  it("asks the agent with read-only limits in the helper folder, whatever an agent file allows", async () => {
    const runtime = scripted(["answers"]);
    const fixture = await engine({
      runtime,
      helpers,
      prepare: (home) => {
        mkdirSync(join(home, "agents"));
        writeFileSync(join(home, "agents", "helper.md"), "---\nformat: 1\nname: My helper\nruns_on: claude-code\nmodel: sonnet\ntools: edit\ncommands: [\"pnpm test:*\"]\nweb: true\n---\nBe brief.\n");
      },
    });
    await ended(fixture, await startRun(fixture));
    const request = runtime.requests[0]!;
    expect(request).toMatchObject({ model: "sonnet", cwd: join(fixture.home, "helper-scratch"), limits: { edit: false, commands: [], web: false }, timeoutMs: 90_000 });
    expect(request.sandbox).toBeUndefined();
  });

  it("fails a run with bad_answer after two bad answers, and records both calls as usage", async () => {
    const runtime = scripted([{ says: "no json" }]);
    const fixture = await engine({ runtime, helpers });
    const run = await ended(fixture, await startRun(fixture));
    expect(run).toMatchObject({ state: "failed", error: { code: "bad_answer", message: "The helper's answer was not valid twice. Try again." }, usage: { tokens: { input: 2400, output: 160, cacheRead: 0, cacheWrite: 0 } } });
    expect(runtime.requests).toHaveLength(2);
    const helpersBlock = (await usage(fixture.client)).helpers;
    expect(helpersBlock).toEqual([{ helperId: "suggest-checks", tokens: { input: 2400, output: 160, cacheRead: 0, cacheWrite: 0 }, costUsd: expect.any(Number), calls: 2 }]);
  });

  it("answers a third run at once with busy while two run", async () => {
    const fixture = await engine({ runtime: scripted(["hangs"]), helpers });
    await startRun(fixture);
    await startRun(fixture);
    expect(await runHelper(fixture.client)).toMatchObject({ ok: false, error: { code: "busy" } });
  });

  it("cleans a CLI's error text of escape sequences and the Tokama home", async () => {
    const fixture = await engine({
      helpers,
      runtime: {
        async *launch() {
          yield { type: "end", outcome: "failed", usage: NO_TOKENS, error: `\u001b[31mfailed\u001b[0m in ${fixture.home}/agents`, errorKind: "auth" };
        },
      },
    });
    const run = await ended(fixture, await startRun(fixture));
    expect(run).toMatchObject({ state: "failed", error: { code: "auth", message: "failed in ~/.tokama/agents" } });
  });
});

describe("cancel_helper", () => {
  it("cancels a running helper, and refuses a run that ended or is not known", async () => {
    const fixture = await engine({ runtime: scripted(["hangs"]), helpers });
    const runId = await startRun(fixture);
    await waitFor(() => files(fixture.home).includes("helper-scratch"), 5_000, "the call to start");
    expect(await fixture.client.command({ type: "cancel_helper", runId: runId as never })).toMatchObject({ ok: true, data: null });
    expect(await ended(fixture, runId)).toMatchObject({ state: "cancelled" });
    expect(await fixture.client.command({ type: "cancel_helper", runId: runId as never })).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(await fixture.client.command({ type: "cancel_helper", runId: RUN_ID as never })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("what a run leaves behind", () => {
  it("writes the helper log and call.json with no path, input text or answer, in private files", async () => {
    const fixture = await engine({ runtime: scripted(["answers"]), helpers });
    const runId = await startRun(fixture);
    await ended(fixture, runId);
    const lines = logLines(fixture.home);
    expect(lines.map((line) => line["type"])).toEqual(["helper_run_started", "process_started", "usage_recorded", "helper_run_ended"]);
    expect(lines[0]).toMatchObject({ format: 1, runId, helperId: "suggest-checks", version: 3, agentId: "helper", cliId: "claude-code", model: "haiku" });
    expect(lines[1]).toMatchObject({ pid: 4242, bootTime: Date.UTC(2026, 10, 1) });
    expect(lines[2]).toMatchObject({ usage: { stepId: "suggest-checks", attempt: 1, agentId: "helper", tokens: TOKENS } });
    expect(lines[3]).toMatchObject({ state: "done" });

    const kept = everythingIn(join(fixture.home, "helper-runs"));
    for (const secret of [fixture.root, fixture.home, "package.json", "orders.ts", "vitest run", "pnpm test", "Propose the commands", "/work/orders-api"]) expect(kept).not.toContain(secret);

    const record = JSON.parse(readFileSync(join(fixture.home, "helper-runs", runId, "call.json"), "utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({ runId, state: "done", helperId: "suggest-checks", sentToCloud: true, target: { agentId: "helper", cliId: "claude-code", model: "haiku" } });
    expect(record["inputs"]).toEqual([
      { name: "repo-file-names", bytes: Buffer.byteLength(NAMES) },
      { name: "repo-build-files", bytes: Buffer.byteLength(BUILDS) },
    ]);
    expect(statSync(join(fixture.home, "helper-runs", runId, "call.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(fixture.home, "helper-runs", runId)).mode & 0o777).toBe(0o700);
    expect(statSync(join(fixture.home, "helper-runs")).mode & 0o777).toBe(0o700);
    expect(statSync(join(fixture.home, "helper-runs", "events-2026-11.jsonl")).mode & 0o777).toBe(0o600);
  });

  it("counts its calls in the usage report's totals and helpers block, not in a workflow or an item", async () => {
    const fixture = await engine({ runtime: scripted(["answers"]), helpers });
    await ended(fixture, await startRun(fixture));
    const report = await usage(fixture.client);
    expect(report.helpers).toEqual([{ helperId: "suggest-checks", tokens: TOKENS, costUsd: expect.any(Number), calls: 1 }]);
    expect(report.totals.calls).toBe(1);
    expect(report.workflows).toEqual([]);
    expect(report.items).toEqual([]);
  });

  it("keeps call.json for the newest 20 runs, and nothing older than 7 days", async () => {
    const id = (at: number, n: number) => `hrun_${at.toString(16).padStart(12, "0").replace(/^(.{8})(.{4})$/, "$1-$2")}-7000-8000-${n.toString().padStart(12, "0")}`;
    const fresh = Array.from({ length: 22 }, (_, n) => id(NOW - 1_000 * (n + 1), n));
    const old = id(NOW - 8 * 24 * 60 * 60_000, 99);
    const fixture = await engine({
      prepare: (home) => {
        for (const name of [...fresh, old]) {
          mkdirSync(join(home, "helper-runs", name), { recursive: true });
          writeFileSync(join(home, "helper-runs", name, "call.json"), "{}\n");
        }
        mkdirSync(join(home, "helper-runs", "notes"));
      },
    });
    await waitFor(() => files(join(fixture.home, "helper-runs")).filter((name) => name.endsWith("call.json")).length === 20, 5_000, "the prune");
    expect(readdirSync(join(fixture.home, "helper-runs")).filter((name) => name.startsWith("hrun_")).sort()).toEqual(fresh.slice(0, 20).sort());
    // Not a run's folder: left alone.
    expect(existsSync(join(fixture.home, "helper-runs", "notes"))).toBe(true);
  });
});

describe("call.json age", () => {
  it("drops a record older than 7 days and keeps one of 6 days, with few records", async () => {
    const id = (at: number, n: number) => `hrun_${at.toString(16).padStart(12, "0").replace(/^(.{8})(.{4})$/, "$1-$2")}-7000-8000-${n.toString().padStart(12, "0")}`;
    const day = 24 * 60 * 60_000;
    const six = id(NOW - 6 * day, 1);
    const eight = id(NOW - 8 * day, 2);
    const fixture = await engine({
      prepare: (home) => {
        for (const name of [six, eight]) {
          mkdirSync(join(home, "helper-runs", name), { recursive: true });
          writeFileSync(join(home, "helper-runs", name, "call.json"), "{}\n");
        }
      },
    });
    await waitFor(() => !existsSync(join(fixture.home, "helper-runs", eight)), 5_000, "the old record to go");
    expect(existsSync(join(fixture.home, "helper-runs", six))).toBe(true);
  });
});

describe("usage from an earlier log", () => {
  const usageLine = (hostId: string, runId: string, stepId: string, endedAt: number) =>
    JSON.stringify({
      format: 1,
      hostId,
      at: new Date(endedAt).toISOString(),
      runId,
      type: "usage_recorded",
      usage: { callId: "call_0190a000-0000-7000-8000-000000000001", stepId, attempt: 1, agentId: "helper", cliId: "claude-code", model: "haiku", outcome: "completed", startedAt: endedAt - 1_000, endedAt, tokens: TOKENS },
    });

  it("counts the helper calls of the last log files, and drops a row whose helper id is not one", async () => {
    const fixture = await engine({
      prepare: (home, clock) => {
        const hostId = loadHostId(home, clock);
        if (!hostId.ok) throw new Error(hostId.error);
        mkdirSync(join(home, "helper-runs"));
        const other = "host_0190a000-0000-7000-8000-0000000000aa";
        writeFileSync(
          join(home, "helper-runs", "events-2026-11.jsonl"),
          [usageLine(hostId.value, RUN_ID, "suggest-checks", NOW - 3_600_000), usageLine(other, RUN_ID, "suggest-checks", NOW - 7_200_000), usageLine(hostId.value, RUN_ID, "../../etc/passwd", NOW - 60_000), "not json", ""].join("\n"),
        );
      },
    });
    // The log is read in the background right after the start.
    let block: UsageReport["helpers"];
    for (const deadline = Date.now() + 5_000; block === undefined && Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 50))) {
      block = (await usage(fixture.client)).helpers;
    }
    expect(block).toMatchObject([{ helperId: "suggest-checks", tokens: { input: 2400, output: 160, cacheRead: 0, cacheWrite: 0 }, calls: 2 }]);
  });
});

describe("the stop path", () => {
  it("is refused with a count while a helper runs, and goes through once it is cancelled", async () => {
    const fixture = await engine({ runtime: scripted(["hangs"]), helpers });
    const runId = await startRun(fixture);
    await waitFor(() => files(fixture.home).includes("helper-scratch"), 5_000, "the call to start");
    const token = readFileSync(fixture.tokenPath, "utf8");
    const ask = async () => {
      const raw = await rawConnect(fixture.socketPath);
      cleanups.push(() => raw.destroy());
      raw.send({ kind: "shutdown", apiVersion: API_VERSION, token, ifIdle: true });
      return raw.next();
    };
    expect(await ask()).toMatchObject({ kind: "shutdown_refused", runningItems: 1 });
    expect(await fixture.client.command({ type: "cancel_helper", runId: runId as never })).toMatchObject({ ok: true });
    await ended(fixture, runId);
    expect(await ask()).toMatchObject({ kind: "shutdown_accepted" });
  });

  it("stops a running helper and writes its end when the engine shuts down", async () => {
    const fixture = await engine({ runtime: scripted(["hangs"]), helpers });
    await startRun(fixture);
    await waitFor(() => files(fixture.home).includes("helper-scratch"), 5_000, "the call to start");
    await fixture.stop();
    const types = logLines(fixture.home).map((line) => `${String(line["type"])}${line["state"] === undefined ? "" : `:${String(line["state"])}`}`);
    expect(types).toEqual(["helper_run_started", "process_started", "usage_recorded", "helper_run_ended:cancelled"]);
  });
});

describe("a restart", () => {
  const started = (hostId: string, runId: string) => ({ format: 1, hostId, at: new Date(NOW).toISOString(), runId, type: "helper_run_started", helperId: "suggest-checks", version: 3, agentId: "helper", cliId: "claude-code", model: "haiku" });
  const processLine = (hostId: string, runId: string, pid: number) => ({ format: 1, hostId, at: new Date(NOW).toISOString(), runId, type: "process_started", pid, startedAt: NOW - 60_000, bootTime: Date.UTC(2026, 10, 1) });

  it("stops the process of a run that never ended, and ends it in the log", async () => {
    const processTable = table([{ pid: 5151, startedAt: NOW - 60_000 }]);
    const fixture = await engine({
      processTable,
      // The stop waits a grace time on the clock, so this engine's clock must run.
      clock: systemClock,
      prepare: (home, clock) => {
        const hostId = loadHostId(home, clock);
        if (!hostId.ok) throw new Error(hostId.error);
        mkdirSync(join(home, "helper-runs"));
        writeFileSync(join(home, "helper-runs", "events-2026-11.jsonl"), [started(hostId.value, RUN_ID), processLine(hostId.value, RUN_ID, 5151)].map((line) => JSON.stringify(line)).join("\n") + "\n");
      },
    });
    await waitFor(() => logLines(fixture.home).some((line) => line["type"] === "helper_run_ended"), 5_000, "the end line");
    expect(processTable.signals[0]).toEqual([5151, "SIGTERM"]);
    expect(logLines(fixture.home).at(-1)).toMatchObject({ type: "helper_run_ended", runId: RUN_ID, state: "cancelled", errorCode: "crash" });
  });

  it("leaves a run of another machine alone, and a run that already ended", async () => {
    const processTable = table([{ pid: 5151, startedAt: NOW - 60_000 }, { pid: 5252, startedAt: NOW - 60_000 }]);
    const ended = "hrun_0b9f3c1e-6a2d-4f7b-9c1a-2e3d4f5a6b7d";
    const fixture = await engine({
      processTable,
      clock: systemClock,
      prepare: (home, clock) => {
        const hostId = loadHostId(home, clock);
        if (!hostId.ok) throw new Error(hostId.error);
        mkdirSync(join(home, "helper-runs"));
        const lines = [
          // A run of this machine that did not end: proves the log was read before the checks below.
          processLine(hostId.value, "hrun_0b9f3c1e-6a2d-4f7b-9c1a-2e3d4f5a6b7e", 5353),
          processLine("host_0190a000-0000-7000-8000-0000000000aa", RUN_ID, 5151),
          processLine(hostId.value, ended, 5252),
          { format: 1, hostId: hostId.value, at: new Date(NOW).toISOString(), runId: ended, type: "helper_run_ended", state: "done" },
        ];
        writeFileSync(join(home, "helper-runs", "events-2026-11.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
      },
    });
    // Its own leftover run (a process that is gone) is ended once the log is read; only then are the other checks meaningful.
    await waitFor(() => logLines(fixture.home).some((line) => line["runId"] === "hrun_0b9f3c1e-6a2d-4f7b-9c1a-2e3d4f5a6b7e" && line["type"] === "helper_run_ended"), 5_000, "the leftover run's end");
    expect(processTable.signals).toEqual([]);
    expect(logLines(fixture.home)).toHaveLength(5);
  });
});

describe("the real Claude Code adapter", () => {
  it("is asked for read-only tools in the helper folder: no shell, no settings file, the Tokama home closed", async () => {
    const calls: RunRequest[] = [];
    const stream = [
      { type: "system", subtype: "init", cwd: "/x", session_id: "s", tools: [], model: "haiku" },
      { type: "assistant", message: { id: "m1", content: [{ type: "text", text: JSON.stringify(GOOD) }] }, session_id: "s" },
      { type: "result", subtype: "success", is_error: false, result: "done", session_id: "s", usage: { input_tokens: 10, output_tokens: 5 } },
    ].map((line) => JSON.stringify(line));
    const runner: ProcessRunner = {
      async run(request) {
        calls.push(request);
        request.onSpawn?.(4242);
        for (const line of stream) request.stdout?.onLine?.(line);
        return { kind: "finished", pid: 4242, exitCode: 0, signal: null, timedOut: false, aborted: false, startedAt: 0, endedAt: 1, durationMs: 1 };
      },
    };
    const fixture = await engine({ runner, helpers });
    expect(await ended(fixture, await startRun(fixture))).toMatchObject({ state: "done" });
    expect(calls).toHaveLength(1);
    const { command } = calls[0]!;
    if (!("argv" in command)) throw new Error("the CLI is started without a shell");
    const argv: readonly string[] = command.argv;
    expect(calls[0]!.cwd).toBe(join(fixture.home, "helper-scratch"));
    expect(argv).toContain("--tools=Read,Glob,Grep");
    expect(argv).toContain("--restricted");
    expect(argv).toContain("--safe-mode");
    expect(argv).toContain("--permission-mode=dontAsk");
    expect(argv).toContain("--model=haiku");
    expect(argv.some((word) => word.includes("Bash"))).toBe(false);
    expect(argv.some((word) => word.startsWith("--settings"))).toBe(false);
    expect(argv).not.toContain("--allowedTools");
    const denied = argv.slice(argv.indexOf("--disallowedTools") + 1);
    expect(denied).toEqual(expect.arrayContaining([`Read(/${fixture.home}/**)`, `Edit(/${fixture.home}/**)`, "WebFetch", "WebSearch"]));
    expect(existsSync(join(fixture.home, "helper-scratch"))).toBe(true);
    expect(readdirSync(join(fixture.home, "helper-scratch"))).toEqual([]);
  });
});
