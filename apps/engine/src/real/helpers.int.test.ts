// The real engine knows the helper and Try checks messages but has no runner yet: it answers each
// with `not_implemented`. The home is a temp folder, so the owner's Tokama home is never touched.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type EngineClient } from "@tokama/client";
import type { ProcessTable } from "@tokama/core";
import { afterEach, describe, expect, it } from "vitest";
import { startEngine } from "../engine.js";
import { tempEngineDir } from "../testing/helpers.js";
import type { HealthChecks } from "./health.js";

const table: ProcessTable = { list: async () => [], bootTime: () => Date.UTC(2026, 10, 1), signalGroup: () => undefined };
const healthy: HealthChecks = async () => ({ git: { ok: true, version: "git version 2.54.0" }, clis: [{ cliId: "claude-code", installed: true, loggedIn: true }] });

const RUN_ID = "hrun_0b9f3c1e-6a2d-4f7b-9c1a-2e3d4f5a6b7c";
const TRIAL_ID = "trial_1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

let cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

async function realEngine(): Promise<EngineClient> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tk-real-")));
  const home = join(root, "home");
  mkdirSync(home);
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const dir = tempEngineDir(cleanups);
  const started = await startEngine({ dir, home, processTable: table, checks: healthy, recoveryGraceMs: 0, planSources: {} });
  if (!started.ok) throw new Error(started.error.message);
  cleanups.push(() => started.value.close());
  const connected = await connect({ dir, startTimeoutMs: 2_000 });
  if (!connected.ok) throw new Error(connected.error.message);
  cleanups.push(() => connected.value.close());
  return connected.value;
}

describe("real engine, helpers and Try checks", () => {
  it("answers every new command with not_implemented", async () => {
    const client = await realEngine();
    const notImplemented = { ok: false, error: { code: "not_implemented" } };
    expect(await client.command({ type: "run_helper", run: { helperId: "suggest-checks", input: { path: "/work/orders-api" } }, cloud: "accepted" })).toMatchObject(notImplemented);
    expect(await client.command({ type: "cancel_helper", runId: RUN_ID })).toMatchObject(notImplemented);
    expect(await client.command({ type: "try_checks", path: "/work/orders-api", checks: [{ command: "pnpm test" }] })).toMatchObject(notImplemented);
    expect(await client.command({ type: "cancel_check_trial", trialId: TRIAL_ID })).toMatchObject(notImplemented);
  });

  it("answers every new query with not_implemented", async () => {
    const client = await realEngine();
    const notImplemented = { ok: false, error: { code: "not_implemented" } };
    expect(await client.query({ type: "helpers" })).toMatchObject(notImplemented);
    expect(await client.query({ type: "helper_run", runId: RUN_ID })).toMatchObject(notImplemented);
    expect(await client.query({ type: "check_trial", trialId: TRIAL_ID })).toMatchObject(notImplemented);
  });

  it("leaves its usage report without a helpers block", async () => {
    const client = await realEngine();
    const reply = await client.query({ type: "usage", range: 14 });
    expect(reply.ok).toBe(true);
    if (reply.ok) expect(reply.data.helpers).toBeUndefined();
  });
});
