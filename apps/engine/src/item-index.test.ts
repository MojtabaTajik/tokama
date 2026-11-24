import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
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

  it("creates the database file 0600 with a schema version, and recreates a database of another version", () => {
    const file = join(home, "tokama.db");
    const index = ItemIndex.open(file);
    index.rebuild([create(openStore(), "Fix it")]);
    index.close();
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const raw = new DatabaseSync(file);
    expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(raw.prepare("SELECT schema_version FROM items").all()).toEqual([{ schema_version: 1 }]);
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
