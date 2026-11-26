import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { connect } from "@tokama/client";
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
  schemaVersion: 2,
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

/** The tables of schema version 3, as the engine created them before the items table was dropped. */
const V3_SCHEMA = `
  CREATE TABLE items (
    id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    template_ref TEXT NOT NULL,
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    needs_you INTEGER NOT NULL,
    last_seq INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX items_updated_at ON items (updated_at DESC);
  CREATE TABLE usage_calls (
    call_id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    title TEXT NOT NULL,
    template_ref TEXT NOT NULL,
    repo_id TEXT,
    ended_at INTEGER NOT NULL,
    record TEXT NOT NULL
  ) STRICT;
  CREATE INDEX usage_calls_ended_at ON usage_calls (ended_at);
  CREATE TABLE plan_samples (
    cli_id TEXT PRIMARY KEY,
    as_of INTEGER NOT NULL,
    record TEXT NOT NULL
  ) STRICT;
  CREATE TABLE claude_local_messages (
    key TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    day TEXT NOT NULL,
    model TEXT NOT NULL,
    project TEXT NOT NULL,
    input INTEGER NOT NULL,
    output INTEGER NOT NULL,
    cache_read INTEGER NOT NULL,
    cache_write INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX claude_local_messages_at ON claude_local_messages (at);
  CREATE TABLE claude_local_files (
    file_key TEXT PRIMARY KEY,
    ino INTEGER NOT NULL,
    offset INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE claude_local_projects (
    project TEXT PRIMARY KEY,
    repo_id TEXT
  ) STRICT;
`;

describe("ItemIndex", () => {
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
    expect(rows.map((row) => [row.itemId, row.title, row.templateId, row.repoId, row.call.tokens.input])).toEqual([
      [item.id, "Fix it", REF, "orders-api", 1],
      [item.id, "Fix it", REF, "orders-api", 2],
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
    index.savePlanSample("claude-code", { windows: [{ window: "five_hour", usedPercent: 36 }], asOf: T0 });
    index.close();
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const raw = new DatabaseSync(file);
    expect(raw.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4 });
    raw.exec("PRAGMA user_version = 99");
    raw.close();

    // Derived data: a database from another version is dropped and rebuilt from the logs.
    expect(openIndex(file).planSample("claude-code")).toBeUndefined();
  });

  it("upgrades a v3 database: drops items, keeps plan and Claude usage data", () => {
    const file = join(home, "tokama.db");
    const raw = new DatabaseSync(file);
    raw.exec(V3_SCHEMA);
    raw.exec("PRAGMA user_version = 3");
    raw.prepare("INSERT INTO items (id, schema_version, template_ref, state, updated_at, needs_you, last_seq) VALUES (?, 3, ?, 'done', ?, 0, 2)").run("item_0190a000-0000-7000-8000-000000000001", REF, T0);
    raw.prepare("INSERT INTO plan_samples (cli_id, as_of, record) VALUES (?, ?, ?)").run("claude-code", T0, JSON.stringify({ windows: [{ window: "five_hour", usedPercent: 36 }], asOf: T0 }));
    raw.prepare("INSERT INTO claude_local_messages (key, at, day, model, project, input, output, cache_read, cache_write) VALUES ('req_1', ?, '2026-11-24', 'claude-opus-5-5', 'p1', 10, 20, 30, 40)").run(T0);
    raw.prepare("INSERT INTO claude_local_files (file_key, ino, offset) VALUES ('f1', 7, 99)").run();
    raw.prepare("INSERT INTO claude_local_projects (project, repo_id) VALUES ('p1', 'orders-api')").run();
    raw.close();

    const index = openIndex(file);
    const check = new DatabaseSync(file, { readOnly: true });
    cleanups.push(() => check.close());
    expect(check.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4 });
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name IN ('items', 'items_updated_at')").all()).toEqual([]);
    expect(index.planSample("claude-code")).toEqual({ windows: [{ window: "five_hour", usedPercent: 36 }], asOf: T0 });
    expect(index.localMark("f1")).toEqual({ ino: 7, offset: 99 });
    expect(index.localCoveredFrom()).toBe(T0);
    expect(index.localDays(0)).toEqual([{ day: "2026-11-24", model: "claude-opus-5-5", project: "p1", repoId: "orders-api", tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }, messages: 1 }]);

    // The upgraded database takes writes and rebuilds.
    const store = openStore();
    const item = create(store, "Fix it");
    spend(store, item, 1);
    index.rebuild(store.list());
    expect(index.usageRows(0)).toHaveLength(1);
    expect(index.put(store.get(item.id) as StoredItem)).toBe(0);
    expect(index.planSample("claude-code")?.asOf).toBe(T0);
  });

  it("stores no absolute paths", () => {
    const index = openIndex();
    const store = openStore();
    const item = create(store, "Fix it");
    spend(store, item, 1);
    index.rebuild(store.list());
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
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'items'").all()).toEqual([]);
  });

  it("lists every item through the API when it starts on a v3 database", async () => {
    const store = openStore();
    const first = create(store, "First");
    const second = create(store, "Second");
    store.append(second.id, [{ type: "item_ended", outcome: "done" }]);
    const raw = new DatabaseSync(join(home, "tokama.db"));
    raw.exec(V3_SCHEMA);
    raw.exec("PRAGMA user_version = 3");
    raw.prepare("INSERT INTO items (id, schema_version, template_ref, state, updated_at, needs_you, last_seq) VALUES (?, 3, ?, 'done', ?, 0, 0)").run(first.id, REF, T0);
    raw.close();

    const dir = tempEngineDir(cleanups);
    const started = await startEngine({ dir, home });
    if (!started.ok) throw new Error(started.error.message);
    cleanups.push(() => started.value.close());
    const connected = await connect({ dir, startTimeoutMs: 2_000 });
    if (!connected.ok) throw new Error(connected.error.message);
    cleanups.push(() => connected.value.close());

    for (const item of [first, second]) {
      const answer = await connected.value.query({ type: "item", itemId: item.id });
      expect(answer.ok && answer.data.item.title).toBe(item.title);
    }
    const list = await connected.value.query({ type: "item_list", group: "done", limit: 50 });
    expect(list.ok && list.data.items.map((row) => row.title)).toEqual(["Second"]);
    const board = await connected.value.query({ type: "board" });
    expect(board.ok && board.data.items.map((row) => row.title)).toEqual(["First"]);
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
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'items'").all()).toEqual([]);
    expect(started.value.items?.get(item.id)?.title).toBe("Fix it");
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

describe("ItemIndex: Claude Code's usage from its logs", () => {
  const message = (key: string, at: number, output: number, model = "claude-opus-5-5", project = "p1") => ({ key, at, model, project, tokens: { input: 10, output, cacheRead: 100, cacheWrite: 5 } });
  // Local times, so the days do not depend on the machine's time zone.
  const day1 = new Date(2026, 10, 23, 9).getTime();
  const day2 = new Date(2026, 10, 24, 9).getTime();

  it("counts a message once across logs and reads, with its largest counts", () => {
    const index = openIndex();
    index.saveLocalFile("f1", { ino: 1, offset: 10 }, [message("req_1", day1, 5), message("req_1", day1 + 1, 400), message("req_2", day1, 50)]);
    // The same message in another log, and the first log read again from the start.
    index.saveLocalFile("f2", { ino: 2, offset: 20 }, [message("req_2", day1, 50)]);
    index.saveLocalFile("f1", { ino: 1, offset: 10 }, [message("req_1", day1, 5)]);
    expect(index.localDays(0)).toEqual([{ day: "2026-11-23", model: "claude-opus-5-5", project: "p1", repoId: null, tokens: { input: 20, output: 450, cacheRead: 200, cacheWrite: 10 }, messages: 2 }]);
    index.saveLocalProjects(new Map([["p1", "orders-api"]]));
    expect(index.localDays(0)[0]?.repoId).toBe("orders-api");
    expect(index.localCoveredFrom()).toBe(day1);
    expect(index.localMark("f1")).toEqual({ ino: 1, offset: 10 });
    expect(index.localMark("f3")).toBeUndefined();
  });

  it("sums per local day, model and project, and keeps it across an item rebuild", () => {
    const index = openIndex();
    index.saveLocalFile("f1", { ino: 1, offset: 1 }, [message("a", day1, 1), message("b", day2, 2), message("c", day2, 3, "claude-sonnet-5-5"), message("d", day2, 4, "claude-opus-5-5", "p2")]);
    index.rebuild([create(openStore(), "Fix it")]);
    expect(index.localDays(0).map((row) => [row.day, row.model, row.project, row.tokens.output, row.messages])).toEqual([
      ["2026-11-23", "claude-opus-5-5", "p1", 1, 1],
      ["2026-11-24", "claude-opus-5-5", "p1", 2, 1],
      ["2026-11-24", "claude-opus-5-5", "p2", 4, 1],
      ["2026-11-24", "claude-sonnet-5-5", "p1", 3, 1],
    ]);
    expect(index.localDays(day2).map((row) => row.day)).not.toContain("2026-11-23");
  });

  it("forgets the marks of logs that are gone and messages older than the range", () => {
    const index = openIndex();
    index.saveLocalFile("f1", { ino: 1, offset: 1 }, [message("a", day1, 1)]);
    index.saveLocalFile("f2", { ino: 2, offset: 2 }, [message("b", day2, 2)]);
    index.pruneLocal(undefined, day2);
    expect(index.localDays(0).map((row) => row.day)).toEqual(["2026-11-24"]);
    expect(index.localMark("f1")).toEqual({ ino: 1, offset: 1 });
    index.pruneLocal(["f2"], day2);
    expect(index.localMark("f1")).toBeUndefined();
    expect(index.localMark("f2")).toEqual({ ino: 2, offset: 2 });
  });
});
