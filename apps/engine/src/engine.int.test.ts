import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClientEvent, connect, type EngineClient, requestShutdown } from "@tokama/client";
import { API_VERSION, manualClock, MAX_MESSAGE_BYTES } from "@tokama/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type EngineHandle, startEngine } from "./engine.js";
import { rawConnect, sampleItem, tempEngineDir, waitFor } from "./testing/helpers.js";

const ITEM_ID = "item_0b9f3c1e-6a2d-4f7b-9c1a-2e3d4f5a6b7c";

let cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

async function engine(dir: string, options: { helloTimeoutMs?: number } = {}): Promise<EngineHandle> {
  const started = await startEngine({ dir, ...options });
  if (!started.ok) throw new Error(started.error.message);
  cleanups.push(() => started.value.close());
  return started.value;
}

async function client(dir: string): Promise<EngineClient> {
  const connected = await connect({ dir, startTimeoutMs: 2_000 });
  if (!connected.ok) throw new Error(connected.error.message);
  cleanups.push(() => connected.value.close());
  return connected.value;
}

/** Collects client events in the background. */
function collect(engineClient: EngineClient): ClientEvent[] {
  const events: ClientEvent[] = [];
  void (async () => {
    for await (const event of engineClient.events()) events.push(event);
  })();
  return events;
}

async function handshaken(handle: EngineHandle) {
  const raw = await rawConnect(handle.endpoint.socketPath);
  cleanups.push(() => raw.destroy());
  raw.send({ kind: "hello", apiVersion: API_VERSION, token: readFileSync(handle.endpoint.tokenPath, "utf8") });
  expect(await raw.next()).toEqual({ kind: "welcome", apiVersion: API_VERSION, engineId: handle.engineId, runningItems: 0 });
  return raw;
}

describe("engine service", () => {
  it("handshakes, answers queries from its store and refuses commands cleanly", async () => {
    const dir = tempEngineDir(cleanups);
    const handle = await engine(dir);
    const engineClient = await client(dir);

    expect(engineClient.engineId).toBe(handle.engineId);
    expect(await engineClient.query({ type: "board" })).toEqual({ ok: true, data: { items: [], counts: [] } });
    expect(await engineClient.query({ type: "item", itemId: ITEM_ID })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await engineClient.query({ type: "setup" })).toEqual({ ok: true, data: { repos: [], connections: [], agents: [], templates: [], health: { git: { ok: true }, clis: [], config: [] } } });
    expect(await engineClient.command({ type: "stop_item", itemId: ITEM_ID })).toMatchObject({
      ok: false,
      error: { code: "not_implemented" },
    });

    // The client validates before sending.
    expect(await engineClient.query({ type: "board", extra: 1 })).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });

    handle.store.put(sampleItem());
    expect(await engineClient.query({ type: "item", itemId: ITEM_ID })).toEqual({ ok: true, data: { item: sampleItem() } });
    // Query data is typed per query: no casts.
    const board = await engineClient.query({ type: "board" });
    expect(board.ok && board.data.items.map((item) => item.title)).toEqual(["Checkout latency spike"]);
  });

  it("answers item_list from the items in its store, and refuses a search or page size over the limits", async () => {
    const dir = tempEngineDir(cleanups);
    const handle = await engine(dir);
    const engineClient = await client(dir);
    expect(await engineClient.query({ type: "item_list", group: "done", limit: 50 })).toEqual({ ok: true, data: { items: [], nextCursor: null, total: 0, days: [] } });

    // Items put in the store after the engine started are listed, with their state as it is now.
    handle.store.put(sampleItem("Checkout latency spike"));
    handle.store.put({ ...sampleItem("Checkout latency spike"), state: "done" });
    const page = await engineClient.query({ type: "item_list", group: "done", q: "LATENCY", limit: 50 });
    expect(page.ok && page.data.items.map((item) => [item.title, item.state])).toEqual([["Checkout latency spike", "done"]]);
    expect(page.ok && page.data.total).toBe(1);
    expect(page.ok && page.data.days.map((day) => day.count)).toEqual([1]);
    expect(await engineClient.query({ type: "item_list", group: "running", limit: 50 })).toMatchObject({ ok: true, data: { total: 0 } });

    for (const query of [
      { type: "item_list", group: "done", limit: 1001 },
      { type: "item_list", group: "done", limit: 0 },
      { type: "item_list", group: "done", limit: 50, q: "x".repeat(201) },
      { type: "item_list", group: "done", limit: 50, before: "1; DROP TABLE list_items" },
      { type: "item_list", group: "done", limit: 50, since: "yesterday" },
      { type: "item_list", group: "all", limit: 50 },
    ]) {
      expect(await engineClient.query(query as never)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    }
  });

  it("ends an item_list page before the reply gets too large, and goes on from there", async () => {
    const dir = tempEngineDir(cleanups);
    const handle = await engine(dir);
    const engineClient = await client(dir);
    // 600 items of about 4.5 KB each: 1000 of them would not fit in one message.
    for (let n = 1; n <= 600; n++) {
      const id = `item_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      handle.store.put({ ...sampleItem(`Item ${n}`), id, state: "done", text: "x".repeat(4000), createdAt: 1_760_000_000_000 + n } as never);
    }
    const seen = new Set<string>();
    let before: string | undefined;
    let pages = 0;
    do {
      const page = await engineClient.query({ type: "item_list", group: "done", limit: 1000, ...(before !== undefined && { before }) });
      if (!page.ok) throw new Error(page.error.message);
      expect(page.data.total).toBe(600);
      for (const item of page.data.items) seen.add(item.id);
      before = page.data.nextCursor ?? undefined;
      pages++;
    } while (before !== undefined && pages < 10);
    expect(pages).toBeGreaterThan(1);
    expect(seen.size).toBe(600);
  });

  it("answers the board with the open items and counts of the finished ones, also with 5,000 items", async () => {
    const dir = tempEngineDir(cleanups);
    // Local noon, so the days below hold in any time zone.
    const now = new Date(2026, 10, 26, 12).getTime();
    const started = await startEngine({ dir, clock: manualClock(now) });
    if (!started.ok) throw new Error(started.error.message);
    cleanups.push(() => started.value.close());
    const handle = started.value;
    const engineClient = await client(dir);
    // 30 open items, then 4,970 finished ones over the last 100 days in two workflows and two sets of repos.
    const states = ["needs_you", "running", "queued"] as const;
    for (let n = 1; n <= 5000; n++) {
      const open = n <= 30;
      handle.store.put({
        ...sampleItem(`Item ${n}`),
        id: `item_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
        state: open ? states[n % 3]! : n % 5 === 0 ? "failed" : n % 7 === 0 ? "stopped" : "done",
        templateId: n % 2 === 0 ? "builtin/quick-fix" : "builtin/emergency-investigator",
        repoIds: n % 3 === 0 ? ["orders-api", "checkout-web"] : ["orders-api"],
        createdAt: now - (n % 100) * 86_400_000,
      } as never);
    }

    const before = performance.now();
    const board = await engineClient.query({ type: "board" });
    const ms = performance.now() - before;
    if (!board.ok) throw new Error(board.error.message);
    expect(board.data.items).toHaveLength(30);
    expect(board.data.items.every((item) => item.state === "needs_you" || item.state === "running" || item.state === "queued")).toBe(true);
    const sum = (key: "done" | "failed") => board.data.counts.reduce((total, row) => total + row[key], 0);
    expect(sum("done") + sum("failed")).toBe(4970);
    expect(sum("failed")).toBe(994);
    // One row per day of the last 31, and one for everything older, per workflow and set of repos.
    expect(board.data.counts.length).toBeLessThanOrEqual(32 * 4);
    expect(new Set(board.data.counts.map((row) => row.day)).size).toBe(32);
    // Days 31 to 99 before today: 69 of every 100 items, less the open ones among them.
    expect(board.data.counts.filter((row) => row.day === null).reduce((total, row) => total + row.done + row.failed, 0)).toBe(69 * 50);
    expect(board.data.counts[0]).toMatchObject({ day: "2026-11-26" });
    // Small and quick: well under the message limit, and a generous time bound for slow CI machines.
    expect(Buffer.byteLength(JSON.stringify(board.data))).toBeLessThan(64 * 1024);
    expect(ms).toBeLessThan(1_000);
  });

  it("pushes an item_updated event only when the store changes", async () => {
    const dir = tempEngineDir(cleanups);
    const handle = await engine(dir);
    const events = collect(await client(dir));

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events).toEqual([]);

    handle.store.put(sampleItem());
    handle.store.put(sampleItem("Checkout latency spike, again"));
    await waitFor(() => events.length === 2, 5_000, "two events");
    expect(events).toEqual([
      { kind: "event", seq: 0, event: { type: "item_updated", item: sampleItem() } },
      { kind: "event", seq: 1, event: { type: "item_updated", item: sampleItem("Checkout latency spike, again") } },
    ]);
  });

  it("keeps the socket dir, socket and token private and removes its files on shutdown", async () => {
    const dir = tempEngineDir(cleanups);
    const handle = await engine(dir);
    const { socketPath, tokenPath, lockPath } = handle.endpoint;

    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(tokenPath, "utf8")).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(lockPath, "utf8")).toBe(`${process.pid} ${handle.engineId}\n`);

    await handle.close();
    expect([socketPath, tokenPath, lockPath].filter((path) => existsSync(path))).toEqual([]);
  });

  it("refuses a wrong token", async () => {
    const dir = tempEngineDir(cleanups);
    const handle = await engine(dir);

    const raw = await rawConnect(handle.endpoint.socketPath);
    raw.send({ kind: "hello", apiVersion: API_VERSION, token: "0".repeat(64) });
    expect(await raw.next()).toMatchObject({ kind: "connection_error", code: "unauthorized" });
    await raw.closed;

    // The client reports it as a value, and does not retry.
    writeFileSync(handle.endpoint.tokenPath, "not-the-token");
    expect(await connect({ dir })).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });

  it("answers a hello of another API version with unsupported_version", async () => {
    const dir = tempEngineDir(cleanups);
    const handle = await engine(dir);

    const raw = await rawConnect(handle.endpoint.socketPath);
    raw.send({ kind: "hello", apiVersion: API_VERSION + 1, token: readFileSync(handle.endpoint.tokenPath, "utf8"), extra: true });
    expect(await raw.next()).toMatchObject({ kind: "connection_error", apiVersion: API_VERSION, code: "unsupported_version" });
    await raw.closed;
  });

  it("refuses a hello of the previous API version", async () => {
    const dir = tempEngineDir(cleanups);
    const handle = await engine(dir);

    const raw = await rawConnect(handle.endpoint.socketPath);
    raw.send({ kind: "hello", apiVersion: API_VERSION - 1, token: readFileSync(handle.endpoint.tokenPath, "utf8") });
    expect(await raw.next()).toMatchObject({ kind: "connection_error", apiVersion: API_VERSION, code: "unsupported_version" });
    await raw.closed;
  });

  it("says how many items run, in the welcome and in the version refusal", async () => {
    const dir = tempEngineDir(cleanups);
    const handle = await engine(dir);
    const token = readFileSync(handle.endpoint.tokenPath, "utf8");
    handle.store.put({ ...sampleItem("Running one"), id: "item_1b9f3c1e-6a2d-4f7b-9c1a-2e3d4f5a6b7c" as never, state: "running" });
    handle.store.put({ ...sampleItem("Running two"), id: "item_2b9f3c1e-6a2d-4f7b-9c1a-2e3d4f5a6b7c" as never, state: "running" });
    handle.store.put({ ...sampleItem("Needs you"), id: "item_3b9f3c1e-6a2d-4f7b-9c1a-2e3d4f5a6b7c" as never, state: "needs_you" });

    const welcomed = await rawConnect(handle.endpoint.socketPath);
    cleanups.push(() => welcomed.destroy());
    welcomed.send({ kind: "hello", apiVersion: API_VERSION, token });
    expect(await welcomed.next()).toMatchObject({ kind: "welcome", runningItems: 2 });

    const refused = await rawConnect(handle.endpoint.socketPath);
    refused.send({ kind: "hello", apiVersion: API_VERSION + 1, token });
    expect(await refused.next()).toMatchObject({ kind: "connection_error", code: "unsupported_version", runningItems: 2 });
    await refused.closed;
  });

  it("stops on a shutdown request with its token, from a client of any API version", async () => {
    const dir = tempEngineDir(cleanups);
    const handle = await engine(dir);
    const { socketPath, tokenPath, lockPath } = handle.endpoint;

    const raw = await rawConnect(socketPath);
    raw.send({ kind: "shutdown", apiVersion: API_VERSION + 3, token: readFileSync(tokenPath, "utf8"), extra: true });
    expect(await raw.next()).toEqual({ kind: "shutdown_accepted", apiVersion: API_VERSION });
    await raw.closed;
    await handle.closed;
    expect([socketPath, tokenPath, lockPath].filter((path) => existsSync(path))).toEqual([]);
  });

  it("refuses a shutdown request with a wrong token and keeps running", async () => {
    const dir = tempEngineDir(cleanups);
    const handle = await engine(dir);

    const raw = await rawConnect(handle.endpoint.socketPath);
    raw.send({ kind: "shutdown", apiVersion: API_VERSION, token: "0".repeat(64) });
    expect(await raw.next()).toMatchObject({ kind: "connection_error", code: "unauthorized" });
    await raw.closed;
    await handshaken(handle);
  });

  it("is stopped by the client's requestShutdown, which an engine that does not know it refuses", async () => {
    const dir = tempEngineDir(cleanups);
    const handle = await engine(dir);
    expect(await requestShutdown(dir)).toBe(true);
    await handle.closed;
    expect(await requestShutdown(dir)).toBe(false);
  });

  it("closes a connection that does not start with a hello", async () => {
    const dir = tempEngineDir(cleanups);
    const handle = await engine(dir);

    const raw = await rawConnect(handle.endpoint.socketPath);
    raw.send({ apiVersion: API_VERSION, kind: "query", requestId: "r1", query: { type: "board" } });
    expect(await raw.next()).toMatchObject({ kind: "connection_error", code: "bad_message" });
    await raw.closed;
  });

  it("closes a connection that sends no hello in time", async () => {
    const dir = tempEngineDir(cleanups);
    const handle = await engine(dir, { helloTimeoutMs: 100 });

    const raw = await rawConnect(handle.endpoint.socketPath);
    expect(await raw.next()).toMatchObject({ kind: "connection_error", code: "hello_timeout" });
    await raw.closed;
  });

  it.each([
    ["before the hello", false],
    ["after the hello", true],
  ])("rejects an oversized message %s", async (_label, afterHello) => {
    const dir = tempEngineDir(cleanups);
    const handle = await engine(dir);

    const raw = afterHello ? await handshaken(handle) : await rawConnect(handle.endpoint.socketPath);
    raw.write(Buffer.alloc(MAX_MESSAGE_BYTES + 1, "x"));
    expect(await raw.next()).toMatchObject({ kind: "connection_error", code: "message_too_large" });
    await raw.closed;
  });

  it("replies invalid_message to a bad request it can answer, and keeps the connection", async () => {
    const dir = tempEngineDir(cleanups);
    const handle = await engine(dir);
    const raw = await handshaken(handle);

    raw.send({ apiVersion: API_VERSION, kind: "query", requestId: "r1", query: { type: "board", extra: 1 } });
    expect(await raw.next()).toMatchObject({ kind: "reply", requestId: "r1", result: { ok: false, error: { code: "invalid_message" } } });

    raw.send({ apiVersion: API_VERSION, kind: "query", requestId: "r2", query: { type: "board" } });
    expect(await raw.next()).toEqual({ apiVersion: API_VERSION, kind: "reply", requestId: "r2", result: { ok: true, data: { items: [], counts: [] } } });

    raw.write("not json\n");
    expect(await raw.next()).toMatchObject({ kind: "connection_error", code: "bad_message" });
    await raw.closed;
  });

  it("refuses to start next to a live engine and leaves its files alone", async () => {
    const dir = tempEngineDir(cleanups);
    const handle = await engine(dir);
    const token = readFileSync(handle.endpoint.tokenPath, "utf8");

    expect(await startEngine({ dir })).toMatchObject({ ok: false, error: { code: "already_running" } });
    expect(readFileSync(handle.endpoint.tokenPath, "utf8")).toBe(token);
    const engineClient = await client(dir);
    expect(engineClient.engineId).toBe(handle.engineId);
  });

  it("refuses to start while an old engine drains, and the old one leaves the next one's files alone", async () => {
    const dir = tempEngineDir(cleanups);
    const started = await startEngine({ dir, shutdownTimeoutMs: 300 });
    if (!started.ok) throw new Error(started.error.message);
    const old = started.value;
    // An engine that has run for a while: its lock is older than the starting grace.
    const longAgo = new Date(Date.now() - 3_600_000);
    utimesSync(old.endpoint.lockPath, longAgo, longAgo);
    // A client that does not close when asked keeps the old engine draining.
    const stuck = await rawConnect(old.endpoint.socketPath, { allowHalfOpen: true });
    cleanups.push(() => stuck.destroy());
    stuck.send({ kind: "hello", apiVersion: API_VERSION, token: readFileSync(old.endpoint.tokenPath, "utf8") });
    await stuck.next();

    const closing = old.close();
    expect(await startEngine({ dir })).toMatchObject({ ok: false, error: { code: "already_running" } });
    await closing;

    const next = await engine(dir);
    expect((await client(dir)).engineId).toBe(next.engineId);
    expect(readFileSync(next.endpoint.lockPath, "utf8")).toContain(next.engineId);
  });

  it("cleans up a stale lock and socket file left by a dead engine", async () => {
    const dir = tempEngineDir(cleanups);
    mkdirSync(dir, { mode: 0o700 });
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(join(dir, "engine.lock"), `${deadPid}\n`, { mode: 0o600 });
    writeFileSync(join(dir, "engine.sock"), "");
    writeFileSync(join(dir, "engine.token"), "stale");

    const handle = await engine(dir);
    expect(statSync(handle.endpoint.socketPath).isSocket()).toBe(true);
    expect((await client(dir)).engineId).toBe(handle.engineId);
  });

  it("keeps the lock of an engine that has been starting for longer than 10 s", async () => {
    const dir = tempEngineDir(cleanups);
    mkdirSync(dir, { mode: 0o700 });
    // This process wrote the lock and has not listened yet; a minute passes.
    writeFileSync(join(dir, "engine.lock"), `${process.pid} e-starting\n`, { mode: 0o600 });
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    cleanups.push(() => vi.restoreAllMocks());

    expect(await startEngine({ dir })).toMatchObject({ ok: false, error: { code: "already_running", message: expect.stringContaining(`pid ${process.pid}, still starting`) } });
    expect(readFileSync(join(dir, "engine.lock"), "utf8")).toBe(`${process.pid} e-starting\n`);
  });

  it("takes over a lock whose pid now belongs to a process that started after the lock was written", async () => {
    const dir = tempEngineDir(cleanups);
    mkdirSync(dir, { mode: 0o700 });
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
    cleanups.push(() => other.kill("SIGKILL"));
    if (other.pid === undefined) throw new Error("no pid");
    writeFileSync(join(dir, "engine.lock"), `${other.pid} e-crashed\n`, { mode: 0o600 });
    const longAgo = new Date(Date.now() - 3_600_000);
    utimesSync(join(dir, "engine.lock"), longAgo, longAgo);

    const handle = await engine(dir);
    expect(readFileSync(handle.endpoint.lockPath, "utf8")).toBe(`${process.pid} ${handle.engineId}\n`);
    expect(other.exitCode).toBeNull();
  });

  it("still waits for a fresh lock that names no pid yet: another engine is still writing it", async () => {
    const dir = tempEngineDir(cleanups);
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, "engine.lock"), "", { mode: 0o600 });

    expect(await startEngine({ dir })).toMatchObject({ ok: false, error: { code: "already_running" } });
    expect(readFileSync(join(dir, "engine.lock"), "utf8")).toBe("");
  });

  it("removes a symlink in place of the lock without reading or touching its target", async () => {
    const dir = tempEngineDir(cleanups);
    mkdirSync(dir, { mode: 0o700 });
    const target = join(dir, "elsewhere");
    writeFileSync(target, `${process.pid} e-other\n`);
    symlinkSync(target, join(dir, "engine.lock"));

    const handle = await engine(dir);
    expect(readFileSync(handle.endpoint.lockPath, "utf8")).toContain(handle.engineId);
    expect(readFileSync(target, "utf8")).toBe(`${process.pid} e-other\n`);
  });

  it("refuses an engine dir that is a symlink", async () => {
    const root = mkdtempSync(join(tmpdir(), "tk-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "real"), { mode: 0o700 });
    symlinkSync(join(root, "real"), join(root, "run"));

    expect(await startEngine({ dir: join(root, "run") })).toMatchObject({ ok: false, error: { code: "unsafe_dir" } });
  });

  it("tightens a dir that others can read", async () => {
    const dir = tempEngineDir(cleanups);
    mkdirSync(dir, { mode: 0o755 });
    await engine(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("reconnects the client after an engine restart and tells it to resync", async () => {
    const dir = tempEngineDir(cleanups);
    const first = await engine(dir);
    const engineClient = await client(dir);
    const events = collect(engineClient);
    first.store.put(sampleItem());
    await waitFor(() => events.length === 1, 5_000, "first event");

    await first.close();
    await waitFor(() => events.some((event) => event.kind === "disconnected"), 5_000, "disconnected");
    // In flight or not, a request while disconnected fails as a value; it is never queued.
    expect(await engineClient.query({ type: "board" })).toMatchObject({
      ok: false,
      error: { code: "disconnected" },
    });

    const second = await engine(dir);
    await waitFor(() => events.some((event) => event.kind === "reconnected"), 5_000, "reconnected");
    expect(events.at(-1)).toEqual({ kind: "reconnected", engineId: second.engineId });
    expect(second.engineId).not.toBe(first.engineId);
    expect(engineClient.engineId).toBe(second.engineId);

    expect(await engineClient.query({ type: "board" })).toEqual({ ok: true, data: { items: [], counts: [] } });
    second.store.put(sampleItem());
    // seq restarted with the new engine.
    await waitFor(() => events.length === 4, 5_000, "event from the new engine");
    expect(events.at(-1)).toMatchObject({ kind: "event", seq: 0 });
  });

  it("gives up after a bounded number of engine starts that never come up", { timeout: 30_000 }, async () => {
    const dir = tempEngineDir(cleanups);
    const handle = await engine(dir);
    // An engine command that never serves: it exits at once with the "already running" code.
    const connected = await connect({ dir, start: { command: process.execPath, args: ["-e", "process.exit(3)"] } });
    if (!connected.ok) throw new Error(connected.error.message);
    cleanups.push(() => connected.value.close());
    const events = collect(connected.value);

    await handle.close();
    await waitFor(() => events.some((event) => event.kind === "failed"), 25_000, "failed");
    expect(events).toEqual([
      { kind: "disconnected" },
      { kind: "failed", error: { code: "start_failed", message: expect.stringContaining("after 5 starts") } },
    ]);
  });

  it("ends the client's event streams on close", async () => {
    const dir = tempEngineDir(cleanups);
    await engine(dir);
    const engineClient = await client(dir);
    const iterator = engineClient.events()[Symbol.asyncIterator]();
    const next = iterator.next();
    await engineClient.close();
    expect(await next).toEqual({ done: true, value: undefined });
  });
});
