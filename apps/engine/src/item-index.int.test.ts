import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ItemStore,
  loadHostId,
  manualClock,
  parseTemplateRecord,
  type ProcessTable,
  type RepoId,
  type StepId,
  type StoredItem,
  type TemplateRef,
} from "@tokama/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startEngine } from "./engine.js";
import { ItemIndex } from "./item-index.js";
import { tempEngineDir, waitFor } from "./testing/helpers.js";

const T0 = Date.UTC(2026, 10, 24, 10, 0, 0);
const BUILD = "build" as StepId;
const REF = "builtin/quick-fix" as TemplateRef;

let home: string;
let cleanups: (() => unknown)[] = [];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tokama-index-"));
});
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
  rmSync(home, { recursive: true, force: true });
});

function openStore(): ItemStore {
  const hostId = loadHostId(home);
  if (!hostId.ok) throw new Error(hostId.error);
  return ItemStore.open({ home, hostId: hostId.value, clock: manualClock(T0) }).store;
}

const parsedTemplate = parseTemplateRecord({
  schemaVersion: 1,
  ref: REF,
  id: "quick-fix",
  source: { kind: "builtin" },
  name: "Quick fix",
  uses: { repos: { picked: "edit", named: [] }, connections: [], commands: [] },
  start: { needs: ["text", "repo"], askBeforeCloud: false, notify: false },
  steps: [
    {
      id: BUILD,
      name: "Build",
      agentId: "builder",
      instructions: { text: "Fix it." },
      doneWhen: "agent finishes",
      ifFailed: { action: "ask" },
      maxAttempts: 1,
      data: "none",
      sees: [],
      connections: [],
      commands: [],
    },
  ],
  finish: ["commit"],
});
if (!parsedTemplate.ok) throw new Error(JSON.stringify(parsedTemplate.error.issues));
const template = parsedTemplate.value;

function create(store: ItemStore, title: string): StoredItem {
  const created = store.create({ template, title, text: "", repoIds: ["orders-api" as RepoId] });
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

/** Starts the build step and records one finished call of it. */
function spend(store: ItemStore, item: StoredItem, n: number, endedAt = T0 + n * 60_000): void {
  const started = store.get(item.id)?.steps[0]?.attempts.length === 0;
  const appended = store.append(item.id, [
    ...(started ? [{ type: "step_started" as const, stepId: BUILD }, { type: "attempt_started" as const, stepId: BUILD, attempt: 1 }] : []),
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
        startedAt: endedAt - 30_000,
        endedAt,
        tokens: { input: n, output: 1, cacheRead: 0, cacheWrite: 0 },
        plan: { status: "allowed", windows: [{ window: "five_hour", usedPercent: 40 }], at: endedAt },
      },
    },
  ]);
  if (!appended.ok) throw new Error(appended.error.message);
}

function openIndex(file = join(home, "tokama.db")): ItemIndex {
  const index = ItemIndex.open(file);
  cleanups.push(() => index.close());
  return index;
}

describe("ItemIndex", () => {
  it("holds the board row of each item: id, templateRef, state, updatedAt, needs you", () => {
    const store = openStore();
    const index = openIndex();
    store.subscribe((item) => index.put(item));
    const item = create(store, "Fix it");
    store.append(item.id, [
      { type: "step_started", stepId: BUILD },
      { type: "decision_opened", decisionId: "decision_0190a000-0000-7000-8000-00000000000d" as never, kind: "plan_approval", stepId: BUILD, choices: [{ id: "approve", label: "Approve" }] },
    ]);
    expect(index.list()).toEqual([{ id: item.id, templateRef: REF, state: "needs_you", updatedAt: T0, needsYou: true }]);
  });

  it("is rebuilt from the item logs alone to the same rows", () => {
    const store = openStore();
    const live = openIndex();
    store.subscribe((item) => live.put(item));
    const first = create(store, "First");
    const second = create(store, "Second");
    const deleted = create(store, "Deleted");
    store.append(first.id, [{ type: "step_started", stepId: BUILD }]);
    store.append(second.id, [{ type: "item_ended", outcome: "no_action_needed" }]);
    store.append(deleted.id, [{ type: "item_ended", outcome: "done" }, { type: "tombstone" }]);
    const rows = live.list();
    expect(rows.map((row) => [row.id, row.state])).toEqual(
      expect.arrayContaining([
        [first.id, "running"],
        [second.id, "done"],
      ]),
    );
    expect(rows).toHaveLength(2);

    // A new database, filled from the logs on disk only.
    const rebuilt = openIndex(join(home, "rebuilt.db"));
    rebuilt.rebuild(openStore().list());
    expect(rebuilt.list()).toEqual(rows);
    // Rebuilding again replaces, never duplicates.
    rebuilt.rebuild(openStore().list());
    expect(rebuilt.list()).toEqual(rows);
  });

  it("holds one row per recorded call, follows new calls, and is rebuilt from the logs to the same rows", () => {
    const store = openStore();
    const live = openIndex();
    const added: number[] = [];
    store.subscribe((item) => added.push(live.put(item)));
    const item = create(store, "Fix it");
    spend(store, item, 1);
    spend(store, item, 2);
    expect(added).toEqual([0, 1, 1]);
    const rows = live.usageRows(0);
    expect(rows.map((row) => [row.itemId, row.title, row.templateId, row.call.tokens.input])).toEqual([
      [item.id, "Fix it", REF, 1],
      [item.id, "Fix it", REF, 2],
    ]);
    expect(live.usageRows(T0 + 2 * 60_000)).toHaveLength(1);

    const rebuilt = openIndex(join(home, "rebuilt.db"));
    rebuilt.rebuild(openStore().list());
    expect(rebuilt.usageRows(0)).toEqual(rows);
    rebuilt.rebuild(openStore().list());
    expect(rebuilt.usageRows(0)).toEqual(rows);

    // A deleted item takes its calls with it.
    store.append(item.id, [{ type: "attempt_ended", stepId: BUILD, attempt: 1, result: "passed" }, { type: "step_ended", stepId: BUILD, result: "passed" }, { type: "item_ended", outcome: "done" }, { type: "tombstone" }]);
    expect(live.usageRows(0)).toEqual([]);
  });

  it("keeps plan samples across a rebuild, one per CLI", () => {
    const index = openIndex();
    index.savePlanSample("claude-code", { windows: [{ window: "five_hour", usedPercent: 36 }], asOf: T0 });
    index.savePlanSample("claude-code", { windows: [{ window: "five_hour", usedPercent: 37 }], asOf: T0 + 1 });
    index.rebuild([]);
    expect(index.planSample("claude-code")).toEqual({ windows: [{ window: "five_hour", usedPercent: 37 }], asOf: T0 + 1 });
    expect(index.planSample("codex-cli")).toBeUndefined();
  });

  it("creates the database file 0600 with a schema version, and recreates a database of another version", () => {
    const file = join(home, "tokama.db");
    const index = ItemIndex.open(file);
    index.rebuild([create(openStore(), "Fix it")]);
    index.close();
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const raw = new DatabaseSync(file);
    expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect(raw.prepare("SELECT schema_version FROM items").all()).toEqual([{ schema_version: 2 }]);
    raw.exec("PRAGMA user_version = 99");
    raw.close();

    // Derived data: a database from another version is dropped and rebuilt from the logs.
    expect(openIndex(file).list()).toEqual([]);
  });

  it("stores no absolute paths", () => {
    const index = openIndex();
    index.rebuild([create(openStore(), "Fix it")]);
    index.close();
    cleanups.pop();
    // Closing checkpoints the WAL into the database file.
    const bytes = readFileSync(join(home, "tokama.db"), "latin1");
    expect(bytes).toContain("builtin/quick-fix");
    expect(bytes).not.toContain(home);
    expect(bytes).not.toContain(tmpdir());
  });
});

describe("engine start with a home folder", () => {
  it("rebuilds the index, records a run failure for a step that was running, and keeps the index current", async () => {
    const store = openStore();
    const item = create(store, "Fix it");
    store.append(item.id, [
      { type: "step_started", stepId: BUILD },
      { type: "attempt_started", stepId: BUILD, attempt: 1 },
    ]);
    // A stale index from before the crash.
    const stale = ItemIndex.open(join(home, "tokama.db"));
    stale.rebuild([]);
    stale.close();

    const table: ProcessTable = { list: async () => [], bootTime: () => T0, signalGroup: () => {} };
    const dir = tempEngineDir(cleanups);
    const logs: string[] = [];
    const started = await startEngine({ dir, home, processTable: table, log: (line) => logs.push(line) });
    if (!started.ok) throw new Error(started.error.message);
    cleanups.push(() => started.value.close());

    const recovered = started.value.items?.get(item.id);
    expect(recovered?.state).toBe("needs_you");
    expect(recovered?.steps[0]?.attempts[0]).toMatchObject({ result: "run_failed", failure: "engine_restart" });
    expect(logs.some((line) => line.includes(`item ${item.id}: step build was running`))).toBe(true);

    const raw = new DatabaseSync(join(home, "tokama.db"), { readOnly: true });
    cleanups.push(() => raw.close());
    expect(raw.prepare("SELECT id, state, needs_you FROM items").all()).toEqual([{ id: item.id, state: "needs_you", needs_you: 1 }]);
  });

  it("answers on its socket while recovery runs, so a second engine does not take its lock", { timeout: 20_000 }, async () => {
    const store = openStore();
    const item = create(store, "Fix it");
    store.append(item.id, [
      { type: "step_started", stepId: BUILD },
      { type: "attempt_started", stepId: BUILD, attempt: 1 },
      { type: "process_started", stepId: BUILD, attempt: 1, role: "agent", pid: 4242, bootTime: T0 },
    ]);
    // Reading the process table hangs until the test lets it go.
    let release = () => {};
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const table: ProcessTable = {
      list: async () => {
        await blocked;
        return [];
      },
      bootTime: () => T0,
      signalGroup: () => {},
    };
    const dir = tempEngineDir(cleanups);
    const first = startEngine({ dir, home, processTable: table });
    await waitFor(() => existsSync(join(dir, "engine.sock")), 10_000, "socket");
    // Old enough that a lock whose engine does not answer counts as stale.
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, "engine.lock"), old, old);

    expect(await startEngine({ dir, home })).toMatchObject({ ok: false, error: { code: "already_running" } });

    release();
    const started = await first;
    if (!started.ok) throw new Error(started.error.message);
    cleanups.push(() => started.value.close());
    expect(started.value.items?.get(item.id)?.state).toBe("needs_you");
  });

  it("refuses a second engine on the same home folder, even with another engine dir", async () => {
    const first = await startEngine({ dir: tempEngineDir(cleanups), home });
    if (!first.ok) throw new Error(first.error.message);
    cleanups.push(() => first.value.close());
    const secondDir = tempEngineDir(cleanups);
    const second = await startEngine({ dir: secondDir, home });
    expect(second).toMatchObject({ ok: false, error: { code: "already_running" } });
    // It released its own engine lock, and the first engine still holds the home lock.
    expect(existsSync(join(secondDir, "engine.lock"))).toBe(false);
    expect(readFileSync(join(home, "engine.lock"), "utf8")).toContain(first.value.endpoint.socketPath);

    // Once the first engine stops, the home folder is free again.
    await first.value.close();
    expect(existsSync(join(home, "engine.lock"))).toBe(false);
    const third = await startEngine({ dir: secondDir, home });
    if (!third.ok) throw new Error(third.error.message);
    cleanups.push(() => third.value.close());
  });

  it("takes over a home lock whose engine is gone", async () => {
    const gone = spawnSync(process.execPath, ["-e", "process.pid"]).pid;
    writeFileSync(join(home, "engine.lock"), `${gone} old-engine /nowhere/engine.sock\n`, { mode: 0o600 });
    const started = await startEngine({ dir: tempEngineDir(cleanups), home });
    if (!started.ok) throw new Error(started.error.message);
    cleanups.push(() => started.value.close());
    expect(readFileSync(join(home, "engine.lock"), "utf8")).toContain(started.value.endpoint.socketPath);
  });

  it("finishes recovery before it releases the home folder when stopped during recovery", { timeout: 20_000 }, async () => {
    const store = openStore();
    const first = create(store, "First");
    const second = create(store, "Second");
    for (const item of [first, second]) {
      store.append(item.id, [
        { type: "step_started", stepId: BUILD },
        { type: "attempt_started", stepId: BUILD, attempt: 1 },
        { type: "process_started", stepId: BUILD, attempt: 1, role: "agent", pid: 4242, bootTime: T0 },
      ]);
    }
    let release = () => {};
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const table: ProcessTable = {
      list: async () => {
        await blocked;
        return [];
      },
      bootTime: () => T0,
      signalGroup: () => {},
    };
    const dir = tempEngineDir(cleanups);
    const stop = new AbortController();
    const starting = startEngine({ dir, home, processTable: table, signal: stop.signal });
    await waitFor(() => existsSync(join(dir, "engine.sock")), 10_000, "socket");
    stop.abort();
    // Shutdown waits for the recovery that is in the middle of a kill.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(existsSync(join(home, "engine.lock"))).toBe(true);
    release();
    expect(await starting).toMatchObject({ ok: false, error: { code: "stopped" } });
    expect(existsSync(join(home, "engine.lock"))).toBe(false);

    // Nothing was written after the stop; the logs reload cleanly and the next start recovers both.
    const { store: reloaded, problems } = ItemStore.open({ home, hostId: store.hostId });
    expect(problems).toEqual([]);
    expect(reloaded.list().map((item) => item.lastSeq)).toEqual([3, 3]);
    const next = await startEngine({ dir: tempEngineDir(cleanups), home, processTable: { ...table, list: async () => [] } });
    if (!next.ok) throw new Error(next.error.message);
    cleanups.push(() => next.value.close());
    for (const item of [first, second]) {
      const lines = readFileSync(join(home, "items", item.id, "events.jsonl"), "utf8").trim().split("\n");
      expect(lines.map((line) => (JSON.parse(line) as { seq: number }).seq)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(next.value.items?.get(item.id)?.state).toBe("needs_you");
    }
  });

  it("moves a damaged database aside and rebuilds the index from the logs", async () => {
    const store = openStore();
    const item = create(store, "Fix it");
    writeFileSync(join(home, "tokama.db"), "this is not a database, just garbage bytes ".repeat(200));
    writeFileSync(join(home, "tokama.db-wal"), "garbage");
    const logs: string[] = [];
    const started = await startEngine({ dir: tempEngineDir(cleanups), home, log: (line) => logs.push(line) });
    if (!started.ok) throw new Error(started.error.message);
    cleanups.push(() => started.value.close());

    expect(logs.some((line) => line.includes("is damaged"))).toBe(true);
    const aside = readdirSync(home).filter((name) => name.includes(".damaged-") && !name.endsWith("-wal") && !name.endsWith("-shm"));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(home, aside[0] ?? ""), "utf8")).toContain("garbage bytes");
    // The garbage WAL is gone from beside the new database (moved aside, or dropped by SQLite).
    if (existsSync(join(home, "tokama.db-wal"))) expect(readFileSync(join(home, "tokama.db-wal"), "utf8")).not.toBe("garbage");
    const raw = new DatabaseSync(join(home, "tokama.db"), { readOnly: true });
    cleanups.push(() => raw.close());
    expect(raw.prepare("SELECT id FROM items").all()).toEqual([{ id: item.id }]);
  });

  it("does not open item storage in sample mode or for an engine that finds another running", async () => {
    const dir = tempEngineDir(cleanups);
    const sample = await startEngine({ dir, home, sample: true });
    if (!sample.ok) throw new Error(sample.error.message);
    cleanups.push(() => sample.value.close());
    expect(sample.value.items).toBeUndefined();

    const second = await startEngine({ dir, home: join(dirname(home), `${home.split("/").pop()}-second`) });
    expect(second).toMatchObject({ ok: false, error: { code: "already_running" } });
    expect(() => statSync(join(home, "tokama.db"))).toThrow();
  });
});
