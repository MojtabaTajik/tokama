// Helpers and Try checks in fake engine mode, through the real client and socket. The engine clock
// is a manual clock: the canned answers move only when the test advances it.
import { connect, type EngineClient } from "@tokama/client";
import { type CheckTrial, type EngineEvent, type HelperRun, HelperRunSchema, manualClock, type ManualClock } from "@tokama/core";
import { afterEach, describe, expect, it } from "vitest";
import { startEngine } from "../engine.js";
import { tempEngineDir, waitFor } from "../testing/helpers.js";
import { SAMPLE_KEEP_MS, SAMPLE_SLOW_MS } from "./helpers.js";

const NOW = 1_780_000_000_000;
const DISCLOSURE = "Sends file names and build files of this folder to Claude Code · haiku.";

let cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

interface Fixture {
  readonly client: EngineClient;
  readonly clock: ManualClock;
  readonly events: EngineEvent[];
}

async function sampleEngine(): Promise<Fixture> {
  const dir = tempEngineDir(cleanups);
  const clock = manualClock(NOW);
  const started = await startEngine({ dir, sample: true, clock });
  if (!started.ok) throw new Error(started.error.message);
  cleanups.push(() => started.value.close());
  const connected = await connect({ dir, startTimeoutMs: 2_000 });
  if (!connected.ok) throw new Error(connected.error.message);
  cleanups.push(() => connected.value.close());
  const events: EngineEvent[] = [];
  void (async () => {
    for await (const event of connected.value.events()) if (event.kind === "event") events.push(event.event);
  })();
  return { client: connected.value, clock, events };
}

const runHelper = (client: EngineClient, folder: string, cloud = true) =>
  client.command({ type: "run_helper", run: { helperId: "suggest-checks", input: { path: `/work/${folder}` } }, ...(cloud && { cloud: "accepted" as const }) });

async function startRun(fixture: Fixture, folder: string): Promise<string> {
  const reply = await runHelper(fixture.client, folder);
  if (!reply.ok) throw new Error(reply.error.message);
  return reply.data.runId;
}

/** The helper_run_updated events of one run, in order. */
const runUpdates = (events: readonly EngineEvent[], runId: string): HelperRun[] =>
  events.flatMap((event) => (event.type === "helper_run_updated" && event.run.runId === runId ? [event.run] : []));

const trialUpdates = (events: readonly EngineEvent[], trialId: string): CheckTrial[] =>
  events.flatMap((event) => (event.type === "check_trial_updated" && event.trial.trialId === trialId ? [event.trial] : []));

/** Moves the clock and waits until the run's updates have reached the client. */
async function advanceRun(fixture: Fixture, runId: string, ms: number, updates: number): Promise<HelperRun[]> {
  fixture.clock.advance(ms);
  await waitFor(() => runUpdates(fixture.events, runId).length >= updates, 5_000, `${updates} updates of ${runId}`);
  return runUpdates(fixture.events, runId);
}

async function advanceTrial(fixture: Fixture, trialId: string, ms: number, updates: number): Promise<CheckTrial[]> {
  fixture.clock.advance(ms);
  await waitFor(() => trialUpdates(fixture.events, trialId).length >= updates, 5_000, `${updates} updates of ${trialId}`);
  return trialUpdates(fixture.events, trialId);
}

async function startTrial(client: EngineClient, checks: string[], setup?: string): Promise<string> {
  const reply = await client.command({ type: "try_checks", path: "/work/orders-api", checks: checks.map((command) => ({ command, minutes: 3 })), ...(setup !== undefined && { setup }) });
  if (!reply.ok) throw new Error(reply.error.message);
  return reply.data.trialId;
}

describe("sample helpers", () => {
  it("lists suggest-checks as available on the built-in cloud helper agent", async () => {
    const { client } = await sampleEngine();
    const reply = await client.query({ type: "helpers" });
    if (!reply.ok) throw new Error(reply.error.message);
    expect(reply.data.helpers).toEqual([
      {
        helperId: "suggest-checks",
        name: "Suggest checks",
        version: 1,
        available: true,
        agent: { agentId: "helper", name: "Helper", cliId: "claude-code", model: "haiku", runsOn: "cloud" },
        sends: ["file names", "build files"],
      },
    ]);
  });

  it("refuses a cloud helper without the cloud OK and says what would be sent", async () => {
    const { client } = await sampleEngine();
    const reply = await runHelper(client, "orders-api", false);
    expect(reply).toEqual({ ok: false, error: { code: "cloud_not_accepted", message: DISCLOSURE } });
  });

  it("replies at once, then moves a run from gathering to asking to done with three checks", async () => {
    const fixture = await sampleEngine();
    const runId = await startRun(fixture, "orders-api");
    // The run is known at once, before any update was sent.
    const early = await fixture.client.query({ type: "helper_run", runId });
    expect(early).toMatchObject({ ok: true, data: { run: { state: "running", phase: "gathering" } } });
    expect(runUpdates(fixture.events, runId)).toEqual([]);

    let updates = await advanceRun(fixture, runId, 0, 1);
    expect(updates.map((run) => run.phase)).toEqual(["gathering"]);
    updates = await advanceRun(fixture, runId, 300, 2);
    expect(updates.map((run) => run.phase)).toEqual(["gathering", "asking"]);
    updates = await advanceRun(fixture, runId, 1_200, 3);
    const last = updates.at(-1)!;
    expect(last.state).toBe("done");
    expect(last.phase).toBeUndefined();
    expect(last.endedAt).toBe(NOW + 1_500);
    expect(last.result).toEqual({
      helperId: "suggest-checks",
      value: {
        checks: [
          { command: "pnpm test", why: "Runs the unit tests in package.json.", minutes: 3 },
          { command: "pnpm lint", why: "Checks code style with the lint script.", minutes: 1 },
          { command: "pnpm typecheck", why: "Finds type errors before review.", minutes: 2 },
        ],
      },
    });
    expect(last.usage).toEqual({ tokens: { input: 6200, output: 180, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.007 });
    // Every update is a valid record, and the query serves the last one.
    for (const run of updates) expect(HelperRunSchema.safeParse(run).success).toBe(true);
    expect(await fixture.client.query({ type: "helper_run", runId })).toEqual({ ok: true, data: { run: last } });
  });

  it("fails a run in a folder named fail with a bad answer", async () => {
    const fixture = await sampleEngine();
    const runId = await startRun(fixture, "fail-api");
    const updates = await advanceRun(fixture, runId, 1_500, 3);
    expect(updates.at(-1)).toMatchObject({ state: "failed", error: { code: "bad_answer" } });
    expect(updates.at(-1)?.result).toBeUndefined();
  });

  it("answers no checks and a note in a folder named empty", async () => {
    const fixture = await sampleEngine();
    const runId = await startRun(fixture, "empty-api");
    const updates = await advanceRun(fixture, runId, 1_200, 3);
    expect(updates.at(-1)).toMatchObject({ state: "done", result: { helperId: "suggest-checks", value: { checks: [], note: "No build files found. Type the checks yourself." } } });
  });

  it("asks again in a folder named retry", async () => {
    const fixture = await sampleEngine();
    const runId = await startRun(fixture, "retry-api");
    let updates = await advanceRun(fixture, runId, 1_000, 3);
    expect(updates.map((run) => run.phase)).toEqual(["gathering", "asking", "retrying"]);
    updates = await advanceRun(fixture, runId, 1_000, 4);
    expect(updates.at(-1)?.state).toBe("done");
  });

  it("keeps a run in a folder named slow asking until 60 s, and cancels it", async () => {
    const fixture = await sampleEngine();
    const runId = await startRun(fixture, "slow-api");
    await advanceRun(fixture, runId, 300, 2);
    fixture.clock.advance(SAMPLE_SLOW_MS - 1_000);
    expect(runUpdates(fixture.events, runId).at(-1)?.phase).toBe("asking");

    expect(await fixture.client.command({ type: "cancel_helper", runId })).toEqual({ ok: true, data: null });
    await waitFor(() => runUpdates(fixture.events, runId).at(-1)?.state === "cancelled", 5_000, "cancelled");
    const cancelled = runUpdates(fixture.events, runId).at(-1)!;
    expect(cancelled.phase).toBeUndefined();
    expect(cancelled.endedAt).toBe(NOW + 300 + SAMPLE_SLOW_MS - 1_000);
    // The cancelled run does not finish later.
    fixture.clock.advance(2 * SAMPLE_SLOW_MS);
    expect(await fixture.client.query({ type: "helper_run", runId })).toMatchObject({ ok: true, data: { run: { state: "cancelled" } } });
    expect(await fixture.client.command({ type: "cancel_helper", runId })).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  });

  it("finishes a slow run after 60 s", async () => {
    const fixture = await sampleEngine();
    const runId = await startRun(fixture, "slow-api");
    const updates = await advanceRun(fixture, runId, 300 + SAMPLE_SLOW_MS, 3);
    expect(updates.at(-1)?.state).toBe("done");
  });

  it("answers not_found for a run or cancel it does not know", async () => {
    const { client } = await sampleEngine();
    const runId = "hrun_0b9f3c1e-6a2d-4f7b-9c1a-2e3d4f5a6b7c";
    expect(await client.query({ type: "helper_run", runId })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await client.command({ type: "cancel_helper", runId })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("refuses a third run while two run, and takes one again when one ends", async () => {
    const fixture = await sampleEngine();
    const first = await startRun(fixture, "slow-one");
    await startRun(fixture, "slow-two");
    expect(await runHelper(fixture.client, "slow-three")).toMatchObject({ ok: false, error: { code: "busy" } });
    await fixture.client.command({ type: "cancel_helper", runId: first });
    expect(await runHelper(fixture.client, "orders-api")).toMatchObject({ ok: true });
  });

  it("forgets an ended run after 10 minutes", async () => {
    const fixture = await sampleEngine();
    const runId = await startRun(fixture, "orders-api");
    await advanceRun(fixture, runId, 1_500, 3);
    fixture.clock.advance(SAMPLE_KEEP_MS - 1);
    expect(await fixture.client.query({ type: "helper_run", runId })).toMatchObject({ ok: true });
    fixture.clock.advance(1);
    expect(await fixture.client.query({ type: "helper_run", runId })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("answers from the folder name alone, so a folder that does not exist is fine, and in plain text", async () => {
    const fixture = await sampleEngine();
    const runId = await startRun(fixture, "orders-api");
    const updates = await advanceRun(fixture, runId, 1_500, 3);
    expect(updates.at(-1)?.state).toBe("done");
    // Canned text is plain: nothing that could render as markup.
    expect(JSON.stringify(updates)).not.toMatch(/[<>]/);
  });

  it("counts the sample helper calls in the usage totals and days, and lists them by helper", async () => {
    const { client } = await sampleEngine();
    const reply = await client.query({ type: "usage", range: 14, scope: "tokama" });
    if (!reply.ok) throw new Error(reply.error.message);
    const report = reply.data;
    expect(report.helpers).toEqual([{ helperId: "suggest-checks", tokens: { input: 37_200, output: 1_080, cacheRead: 0, cacheWrite: 0 }, costUsd: expect.any(Number), calls: 6 }]);
    // The list is part of the totals, and the totals, the days, the models and the token summary agree.
    const sum = (t: { input: number; output: number; cacheRead: number; cacheWrite: number }) => t.input + t.output + t.cacheRead + t.cacheWrite;
    const total = sum(report.totals.tokens);
    expect(report.days.reduce((n, day) => n + (day.tokens ?? 0), 0)).toBe(total);
    expect(report.tokenSummary?.processed).toBe(total);
    expect(report.models?.reduce((n, model) => n + model.tokens, 0)).toBe(total);
    // The workflows list only workflows: the totals are their tokens plus the helpers'.
    expect(total).toBe(report.workflows.reduce((n, workflow) => n + workflow.tokens, 0) + 37_200 + 1_080);
  });
});

describe("sample Try checks", () => {
  it("runs each check in order, fails the lint, and ends done", async () => {
    const fixture = await sampleEngine();
    const trialId = await startTrial(fixture.client, ["pnpm test", "pnpm lint", "pnpm typecheck"]);
    let updates = await advanceTrial(fixture, trialId, 0, 1);
    expect(updates[0]).toMatchObject({ state: "running", commit: "4f9c2ab", checks: [{ state: "waiting" }, { state: "waiting" }, { state: "waiting" }] });
    updates = await advanceTrial(fixture, trialId, 300, 2);
    expect(updates.at(-1)?.checks.map((check) => check.state)).toEqual(["running", "waiting", "waiting"]);
    updates = await advanceTrial(fixture, trialId, 1_200, 4);
    expect(updates.at(-1)?.checks.map((check) => check.state)).toEqual(["passed", "running", "waiting"]);
    updates = await advanceTrial(fixture, trialId, 1_200, 6);
    expect(updates.at(-1)?.checks[1]).toEqual({
      command: "pnpm lint",
      state: "failed",
      durationMs: 1_200,
      exitCode: 1,
      outputTail: "src/orders.ts\n  12:5  error  'total' is never reassigned. Use 'const' instead  prefer-const\n\n✖ 1 problem (1 error, 0 warnings)",
    });
    updates = await advanceTrial(fixture, trialId, 1_200, 7);
    const last = updates.at(-1)!;
    expect(last).toMatchObject({ state: "done", endedAt: NOW + 300 + 3 * 1_200 });
    expect(last.checks[0]).toMatchObject({ state: "passed", exitCode: 0, durationMs: 1_200, outputTail: "Test Files  12 passed (12)\n     Tests  148 passed (148)\n  Duration  41.20s" });
    expect(last.checks[2]?.state).toBe("passed");
    expect(await fixture.client.query({ type: "check_trial", trialId })).toEqual({ ok: true, data: { trial: last } });
  });

  it("shows the setup command it was given on the trial, and has none without one", async () => {
    const fixture = await sampleEngine();
    const withSetup = await startTrial(fixture.client, ["pnpm test"], "pnpm install");
    expect(await fixture.client.query({ type: "check_trial", trialId: withSetup })).toMatchObject({ ok: true, data: { trial: { setup: "pnpm install" } } });
    await advanceTrial(fixture, withSetup, 300 + 1_200, 3);
    expect(trialUpdates(fixture.events, withSetup).every((trial) => trial.setup === "pnpm install")).toBe(true);
    const without = await startTrial(fixture.client, ["pnpm test"]);
    const trial = await fixture.client.query({ type: "check_trial", trialId: without });
    expect(trial.ok && trial.data.trial.setup).toBeUndefined();
  });

  it("refuses a second trial while one runs, and takes one after it ends", async () => {
    const fixture = await sampleEngine();
    const trialId = await startTrial(fixture.client, ["pnpm test"]);
    const second = await fixture.client.command({ type: "try_checks", path: "/work/orders-api", checks: [{ command: "pnpm test" }] });
    expect(second).toEqual({ ok: false, error: { code: "busy", message: "Checks are already being tried. Wait for them to end, or cancel them." } });
    await advanceTrial(fixture, trialId, 300 + 1_200, 3);
    expect(await fixture.client.command({ type: "try_checks", path: "/work/orders-api", checks: [{ command: "pnpm test" }] })).toMatchObject({ ok: true });
  });

  it("cancels a trial: the running and waiting checks are skipped", async () => {
    const fixture = await sampleEngine();
    const trialId = await startTrial(fixture.client, ["pnpm test", "pnpm slow-e2e", "pnpm typecheck"]);
    await advanceTrial(fixture, trialId, 300 + 1_200 + 5_000, 4);
    expect(trialUpdates(fixture.events, trialId).at(-1)?.checks.map((check) => check.state)).toEqual(["passed", "running", "waiting"]);

    expect(await fixture.client.command({ type: "cancel_check_trial", trialId })).toEqual({ ok: true, data: null });
    await waitFor(() => trialUpdates(fixture.events, trialId).at(-1)?.state === "cancelled", 5_000, "cancelled trial");
    expect(trialUpdates(fixture.events, trialId).at(-1)?.checks.map((check) => check.state)).toEqual(["passed", "skipped", "skipped"]);
    expect(await fixture.client.command({ type: "cancel_check_trial", trialId })).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  });

  it("answers not_found for a trial it does not know, and forgets an ended one after 10 minutes", async () => {
    const fixture = await sampleEngine();
    const unknown = "trial_0b9f3c1e-6a2d-4f7b-9c1a-2e3d4f5a6b7c";
    expect(await fixture.client.query({ type: "check_trial", trialId: unknown })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await fixture.client.command({ type: "cancel_check_trial", trialId: unknown })).toMatchObject({ ok: false, error: { code: "not_found" } });
    const trialId = await startTrial(fixture.client, ["pnpm test"]);
    await advanceTrial(fixture, trialId, 300 + 1_200, 3);
    fixture.clock.advance(SAMPLE_KEEP_MS);
    expect(await fixture.client.query({ type: "check_trial", trialId })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});
