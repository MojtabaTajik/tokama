import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { systemClock } from "../../kernel/clock/index.js";
import type { ProcessInfo, ProcessTable, TreeSignal } from "../../kernel/process/index.js";
import type { DecisionId, ItemEventBody, RepoId, StoredItem } from "../../kernel/schemas/index.js";
import { countedAttempts, openAttempt, openDecisions } from "./fold.js";
import { recoverItems } from "./recovery.js";
import { ItemStore } from "./store.js";
import { BUILD, DECISION, HOST, OTHER_HOST, REVIEW, TEMPLATE, TEMPLATE_REF } from "./testing/events.js";

const BOOT = Date.UTC(2026, 10, 23, 8, 0, 0);

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tokama-recovery-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A process table in memory; a signalled group's processes die. */
function fakeTable(processes: ProcessInfo[]) {
  let live = [...processes];
  const signals: Array<[number, TreeSignal]> = [];
  const table: ProcessTable = {
    list: async () => [...live],
    bootTime: () => BOOT,
    signalGroup(pgid, signal) {
      signals.push([pgid, signal]);
      live = live.filter((p) => p.pgid !== pgid);
    },
  };
  return { table, signals, alive: () => live.map((p) => p.pid) };
}

// The stores use the real clock, so the recorded start times line up with the fake table.
function open(hostId = HOST) {
  return ItemStore.open({ home, hostId, clock: systemClock });
}

function item(store: ItemStore, bodies: ItemEventBody[]): StoredItem {
  const created = store.create({ templateRef: TEMPLATE_REF, template: TEMPLATE, title: "Fix it", text: "", repoIds: ["orders-api" as RepoId], stepIds: [BUILD, REVIEW] });
  if (!created.ok) throw new Error(created.error.message);
  if (bodies.length === 0) return created.value;
  const appended = store.append(created.value.id, bodies);
  if (!appended.ok) throw new Error(appended.error.message);
  return appended.value;
}

const running = (pid?: number): ItemEventBody[] => [
  { type: "step_started", stepId: BUILD },
  { type: "attempt_started", stepId: BUILD, attempt: 1 },
  ...(pid === undefined ? [] : [{ type: "process_started", stepId: BUILD, attempt: 1, role: "agent", pid, bootTime: BOOT } as const]),
];

/** The agent (pid 100) with a shell command in its own group (110) and that command's child. */
const agentTree = (startedAt: number) => [
  { pid: 100, ppid: 1, pgid: 100, startedAt },
  { pid: 110, ppid: 100, pgid: 110, startedAt },
  { pid: 111, ppid: 110, pgid: 110, startedAt },
  { pid: 50, ppid: 1, pgid: 50, startedAt },
];

describe("recoverItems", () => {
  it("kills the leftover agent's tree, records a run failure that does not count, and asks Retry step / Stop", async () => {
    const { store: before } = open();
    const started = item(before, running(100));
    const startedAt = started.steps[0]?.attempts[0]?.processes[0]?.startedAt ?? 0;

    // The engine restarts.
    const { store } = open();
    const { table, signals, alive } = fakeTable(agentTree(startedAt));
    const recovered = await recoverItems(store, { table, graceMs: 0 });

    expect(recovered).toEqual([{ itemId: started.id, stepId: BUILD, kills: [{ pid: 100, outcome: { kind: "killed", groups: [100, 110], forced: [] } }] }]);
    expect(signals).toEqual([
      [100, "SIGTERM"],
      [110, "SIGTERM"],
    ]);
    expect(alive()).toEqual([50]);

    const after = store.get(started.id);
    if (after === undefined) throw new Error("item missing");
    expect(openAttempt(after)).toBeUndefined();
    expect(after.steps[0]?.attempts[0]).toMatchObject({ result: "run_failed", failure: "engine_restart" });
    expect(countedAttempts(after.steps[0] ?? { id: BUILD, state: "pending", attempts: [] })).toBe(0);
    expect(after.state).toBe("needs_you");
    expect(after.steps[0]?.state).toBe("needs_you");
    expect(openDecisions(after)).toMatchObject([
      {
        kind: "run_failure",
        stepId: BUILD,
        choices: [
          { id: "retry_step", label: "Retry step" },
          { id: "stop", label: "Stop" },
        ],
      },
    ]);

    // It is in the log: another restart restores the decision and recovers nothing again.
    const { store: third } = open();
    expect(third.get(started.id)).toEqual(after);
    expect(await recoverItems(third, { table, graceMs: 0 })).toEqual([]);
  });

  it("skips the kill when the pid now belongs to a process that started at another time", async () => {
    const { store: before } = open();
    const started = item(before, running(100));
    const startedAt = started.steps[0]?.attempts[0]?.processes[0]?.startedAt ?? 0;
    const { store } = open();
    const { table, signals, alive } = fakeTable(agentTree(startedAt - 3_600_000));

    const recovered = await recoverItems(store, { table, graceMs: 0 });
    expect(recovered[0]?.kills).toEqual([{ pid: 100, outcome: { kind: "skipped", reason: "pid_reused" } }]);
    expect(signals).toEqual([]);
    expect(alive()).toEqual([100, 110, 111, 50]);
    // The run failure is still recorded.
    expect(store.get(started.id)?.state).toBe("needs_you");
  });

  it("recovers an attempt that was running while it waited on a question, and keeps that question open", async () => {
    const { store: before } = open();
    const started = item(before, [
      ...running(100),
      { type: "decision_opened", decisionId: DECISION as DecisionId, kind: "cloud_summary", stepId: BUILD, choices: [{ id: "send", label: "Send" }] },
    ]);
    expect(started.steps[0]?.state).toBe("needs_you");
    const startedAt = started.steps[0]?.attempts[0]?.processes[0]?.startedAt ?? 0;
    const { store } = open();
    const { table, alive } = fakeTable(agentTree(startedAt));

    const recovered = await recoverItems(store, { table, graceMs: 0 });
    expect(recovered[0]?.kills).toEqual([{ pid: 100, outcome: { kind: "killed", groups: [100, 110], forced: [] } }]);
    expect(alive()).toEqual([50]);
    const after = store.get(started.id) as StoredItem;
    expect(openAttempt(after)).toBeUndefined();
    expect(openDecisions(after).map((d) => d.kind)).toEqual(["cloud_summary", "run_failure"]);
  });

  it("asks Retry step / Stop for a step that was running between attempts, with nothing to kill", async () => {
    const { store: before } = open();
    const started = item(before, [...running(), { type: "attempt_ended", stepId: BUILD, attempt: 1, result: "passed" }]);
    const { store } = open();
    const { table, signals } = fakeTable([]);
    const recovered = await recoverItems(store, { table, graceMs: 0 });
    expect(recovered).toEqual([{ itemId: started.id, stepId: BUILD, kills: [] }]);
    expect(signals).toEqual([]);
    expect(store.get(started.id)?.steps[0]?.attempts[0]?.result).toBe("passed");
    expect(openDecisions(store.get(started.id) as StoredItem)).toHaveLength(1);
  });

  it("leaves alone items that are queued, waiting on a decision, ended, deleted, or owned by another host", async () => {
    const { store: before } = open();
    const queued = item(before, []);
    const waiting = item(before, [
      ...running(),
      { type: "attempt_ended", stepId: BUILD, attempt: 1, result: "passed" },
      { type: "decision_opened", decisionId: DECISION as DecisionId, kind: "plan_approval", stepId: BUILD, choices: [{ id: "approve", label: "Approve" }] },
    ]);
    const ended = item(before, [{ type: "step_started", stepId: BUILD }, { type: "item_ended", outcome: "no_action_needed" }]);
    const deleted = item(before, [{ type: "item_ended", outcome: "done" }, { type: "tombstone" }]);
    const { store: foreignStore } = open(OTHER_HOST);
    item(foreignStore, running(100));

    const { store } = open();
    const { table, signals } = fakeTable(agentTree(Date.now()));
    expect(await recoverItems(store, { table, graceMs: 0 })).toEqual([]);
    expect(signals).toEqual([]);
    // The open decision survives the restart unchanged.
    expect(store.get(waiting.id)).toEqual(waiting);
    expect(openDecisions(waiting)).toMatchObject([{ id: DECISION, kind: "plan_approval" }]);
    for (const other of [queued, ended, deleted]) expect(store.get(other.id)).toEqual(other);
  });

  it("records the run failure even when reading the process table fails", async () => {
    const { store: before } = open();
    const started = item(before, running(100));
    const { store } = open();
    const table: ProcessTable = { list: () => Promise.reject(new Error("ps failed")), bootTime: () => BOOT, signalGroup: () => {} };
    const recovered = await recoverItems(store, { table, graceMs: 0 });
    expect(recovered[0]?.kills).toEqual([{ pid: 100, outcome: { kind: "failed", message: "Error: ps failed" } }]);
    expect(store.get(started.id)?.state).toBe("needs_you");
  });
});
