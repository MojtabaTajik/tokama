import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type EngineClient } from "@tokama/client";
import { err, ItemStore, loadHostId, parseQueryResult, parseTemplateRecord, type RepoId, type StepId, systemClock } from "@tokama/core";
import { afterEach, describe, expect, it } from "vitest";
import { startEngine } from "./engine.js";
import { tempEngineDir } from "./testing/helpers.js";

const BUILD = "build" as StepId;
const NO_PROCESSES = { list: async () => [], bootTime: () => 0, signalGroup: () => undefined };

let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

async function client(dir: string, lockPath: string): Promise<EngineClient> {
  const connected = await connect({ dir, lockPath, startTimeoutMs: 2_000 });
  if (!connected.ok) throw new Error(connected.error.message);
  cleanups.push(() => connected.value.close());
  return connected.value;
}

const template = (() => {
  const parsed = parseTemplateRecord({
    schemaVersion: 2,
    ref: "orders-api/quick-fix",
    id: "quick-fix",
    source: { kind: "builtin" },
    name: "Quick fix",
    uses: { repos: { picked: "edit", named: [] }, connections: [], commands: [] },
    start: { needs: ["text", "repo"], askBeforeCloud: false, notify: false },
    steps: [{ id: BUILD, name: "Build", agentId: "builder", instructions: { text: "Fix it." }, doneWhen: "agent finishes", ifFailed: { action: "ask" }, maxAttempts: 1, data: "none", sees: [], connections: [], commands: [] }],
    finish: ["commit"],
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error.issues));
  return parsed.value;
})();

describe("machine query", () => {
  it("serves sample readings in sample mode", async () => {
    const dir = tempEngineDir(cleanups);
    const started = await startEngine({ dir, sample: true });
    if (!started.ok) throw new Error(started.error.message);
    cleanups.push(() => started.value.close());
    const reply = await (await client(dir, started.value.endpoint.lockPath)).query({ type: "machine" });
    if (!reply.ok) throw new Error(reply.error.message);
    expect(parseQueryResult("machine", reply.data).ok).toBe(true);
    expect(reply.data.points).toHaveLength(360);
    expect(reply.data.items.length).toBeGreaterThan(0);
  });

  it("reads this machine, and the process group of a running item", async () => {
    const home = mkdtempSync(join(tmpdir(), "tokama-machine-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const hostId = loadHostId(home);
    if (!hostId.ok) throw new Error(hostId.error);
    const before = ItemStore.open({ home, hostId: hostId.value, clock: systemClock }).store;
    const created = before.create({ template, title: "Fix the checkout timeout", text: "", repoIds: ["orders-api" as RepoId] });
    if (!created.ok) throw new Error(created.error.message);

    // A real process that leads its own group, as an agent does.
    const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    cleanups.push(() => child.kill());
    const pid = child.pid;
    if (pid === undefined) throw new Error("sleep did not start");
    const dir = tempEngineDir(cleanups);
    const started = await startEngine({ dir, home, planSources: {}, processTable: NO_PROCESSES });
    if (!started.ok) throw new Error(started.error.message);
    cleanups.push(() => started.value.close());
    // After the start: the engine ends the attempts it finds open at start.
    const recorded = started.value.items!.append(created.value.id, [
      { type: "step_started", stepId: BUILD },
      { type: "attempt_started", stepId: BUILD, attempt: 1 },
      { type: "process_started", stepId: BUILD, attempt: 1, role: "agent", pid, pgid: pid, bootTime: 0 },
    ]);
    if (!recorded.ok) throw new Error(recorded.error.message);

    const reply = await (await client(dir, started.value.endpoint.lockPath)).query({ type: "machine" });
    if (!reply.ok) throw new Error(reply.error.message);
    const report = parseQueryResult("machine", reply.data);
    if (!report.ok) throw new Error(JSON.stringify(report.error.issues));
    expect(report.value.cores).toBeGreaterThan(0);
    expect(report.value.memoryTotalBytes).toBeGreaterThan(0);
    expect(report.value.points).toHaveLength(1);
    expect(report.value.engine).toMatchObject({ processes: 1 });
    expect(report.value.engine.memoryBytes).toBeGreaterThan(1_000_000);
    expect(report.value.items).toEqual([expect.objectContaining({ title: "Fix the checkout timeout", role: "agent", processes: 1 })]);
    expect(report.value.items[0]?.memoryBytes).toBeGreaterThan(0);
  });

  it("answers an error when the machine cannot be read", async () => {
    const dir = tempEngineDir(cleanups);
    const started = await startEngine({ dir, machineSource: { memory: async () => err("no access"), processes: async () => err("no access") } });
    if (!started.ok) throw new Error(started.error.message);
    cleanups.push(() => started.value.close());
    const reply = await (await client(dir, started.value.endpoint.lockPath)).query({ type: "machine" });
    expect(reply).toMatchObject({ ok: false, error: { code: "unavailable", message: "no access" } });
  });
});
