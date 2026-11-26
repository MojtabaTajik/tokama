import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClientEvent, connect, type EngineClient } from "@tokama/client";
import { ItemStore, loadHostId, parseQueryResult, parseTemplateRecord, type RepoId, type StepId, type StoredItem, systemClock } from "@tokama/core";
import { afterEach, describe, expect, it } from "vitest";
import { startEngine } from "./engine.js";
import { tempEngineDir, waitFor } from "./testing/helpers.js";

const BUILD = "build" as StepId;
const MINUTE = 60_000;

let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

async function client(dir: string): Promise<EngineClient> {
  const connected = await connect({ dir, startTimeoutMs: 2_000 });
  if (!connected.ok) throw new Error(connected.error.message);
  cleanups.push(() => connected.value.close());
  return connected.value;
}

function collect(engineClient: EngineClient): ClientEvent[] {
  const events: ClientEvent[] = [];
  void (async () => {
    for await (const event of engineClient.events()) events.push(event);
  })();
  return events;
}

const usageChanged = (events: readonly ClientEvent[]) => events.filter((event) => event.kind === "event" && event.event.type === "usage_changed").length;

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

function spend(items: ItemStore, item: StoredItem, n: number, endedAt: number) {
  const appended = items.append(item.id, [
    ...(n === 1 ? [{ type: "step_started" as const, stepId: BUILD }, { type: "attempt_started" as const, stepId: BUILD, attempt: 1 }] : []),
    {
      type: "usage_recorded",
      usage: {
        callId: `call_0190a000-0000-7000-8000-${String(n).padStart(12, "0")}` as never,
        stepId: BUILD,
        attempt: 1,
        agentId: "builder" as never,
        cliId: "claude-code",
        model: "claude-opus-5-5",
        outcome: "completed",
        startedAt: endedAt - MINUTE,
        endedAt,
        tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
        plan: { status: "allowed", windows: [{ window: "five_hour", usedPercent: 40, resetsAt: endedAt + 60 * MINUTE }], at: endedAt },
      },
    },
  ]);
  if (!appended.ok) throw new Error(appended.error.message);
}

describe("usage query", () => {
  it("serves realistic sample usage in sample mode: 14 days, every CLI, and a fresh answer", async () => {
    const dir = tempEngineDir(cleanups);
    const started = await startEngine({ dir, sample: true });
    if (!started.ok) throw new Error(started.error.message);
    cleanups.push(() => started.value.close());
    const engineClient = await client(dir);
    const events = collect(engineClient);
    const reply = await engineClient.query({ type: "usage", range: 14 });
    if (!reply.ok) throw new Error(reply.error.message);
    expect(parseQueryResult("usage", reply.data).ok).toBe(true);
    const report = reply.data;
    expect(report.days).toHaveLength(14);
    expect(report.clis.map((cli) => cli.cliId)).toEqual(["claude-code", "codex-cli", "ollama"]);
    expect(report.clis[1]?.windows[0]?.usedPercent).toBe(84);
    expect(report.items.length).toBeGreaterThan(3);
    expect(report.totals.calls).toBeGreaterThan(10);
    expect(report.days.at(-1)?.workflows.length).toBeGreaterThan(0);
    await waitFor(() => usageChanged(events) > 0, 5_000, "usage_changed");
    const again = await engineClient.query({ type: "usage", range: 90 });
    expect(again.ok && again.data.clis[0]).toMatchObject({ source: "request", windows: [
        { window: "session", usedPercent: 36 },
        { window: "weekly_all", usedPercent: 58 },
        { window: "weekly_scoped", usedPercent: 12, scope: "Fable", sharePercent: 50 },
      ],
    });
    expect(again.ok && again.data.days).toHaveLength(90);
  });

  it("rolls up the calls in the item logs, tells clients when a new one is recorded, and never asks the CLI without a request source", async () => {
    const home = mkdtempSync(join(tmpdir(), "tokama-usage-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const hostId = loadHostId(home);
    if (!hostId.ok) throw new Error(hostId.error);
    const before = ItemStore.open({ home, hostId: hostId.value, clock: systemClock }).store;
    const created = before.create({ template, title: "Fix the checkout timeout", text: "", repoIds: ["orders-api" as RepoId] });
    if (!created.ok) throw new Error(created.error.message);
    const now = Date.now();
    spend(before, created.value, 1, now - 10 * MINUTE);

    const dir = tempEngineDir(cleanups);
    const started = await startEngine({ dir, home, planSources: {}, processTable: { list: async () => [], bootTime: () => 0, signalGroup: () => undefined } });
    if (!started.ok) throw new Error(started.error.message);
    cleanups.push(() => started.value.close());
    const engineClient = await client(dir);
    const events = collect(engineClient);

    const first = await engineClient.query({ type: "usage", range: 14 });
    if (!first.ok) throw new Error(first.error.message);
    expect(first.data.totals).toMatchObject({ calls: 1, costUsd: 4, unpricedCalls: 0 });
    expect(first.data.items).toEqual([expect.objectContaining({ title: "Fix the checkout timeout", templateId: "orders-api/quick-fix", costUsd: 4 })]);
    // The windows come from the run's own rate-limit event.
    expect(first.data.clis[0]).toMatchObject({ source: "run", windows: [{ window: "five_hour", usedPercent: 40 }] });

    spend(started.value.items!, started.value.items!.get(created.value.id)!, 2, Date.now());
    await waitFor(() => usageChanged(events) === 1, 5_000, "usage_changed");
    const second = await engineClient.query({ type: "usage", range: 14 });
    expect(second.ok && second.data.totals.calls).toBe(2);
    expect(usageChanged(events)).toBe(1);
  });
});
