import { spawn } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClientEvent, connect, type EngineClient, requestShutdown, stopEngine } from "@tokama/client";
import { API_VERSION, err, manualClock, MAX_MESSAGE_BYTES, probeSocket, readEngineLock } from "@tokama/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type EngineHandle, startEngine } from "./engine.js";
import { rawConnect, sampleItem, tempEngineDir, waitFor } from "./testing/helpers.js";

// linkSync passes through, unless a test makes it fail once.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, linkSync: vi.fn(actual.linkSync) };
});

const ITEM_ID = "item_0b9f3c1e-6a2d-4f7b-9c1a-2e3d4f5a6b7c";

let cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

async function engine(dir: string, options: { helloTimeoutMs?: number; engineVersion?: string } = {}): Promise<EngineHandle> {
  const started = await startEngine({ dir, ...options });
  if (!started.ok) throw new Error(started.error.message);
  cleanups.push(() => started.value.close());
  return started.value;
}

/** The lock of an engine started without a home: in its engine dir. */
const lockIn = (dir: string) => join(dir, "engine.lock");

/** A socket file and token that an engine left behind when it was killed: the file is there, and nobody listens on it. */
async function deadSocket(dir: string, name: string): Promise<string> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const socketPath = join(dir, `${name}.sock`);
  writeFileSync(join(dir, `${name}.token`), "stale");
  const script = `require("net").createServer().listen(process.argv[1], () => console.log("ready")); setTimeout(() => {}, 60_000);`;
  const child = spawn(process.execPath, ["-e", script, socketPath], { stdio: ["ignore", "pipe", "ignore"] });
  cleanups.push(() => child.kill("SIGKILL"));
  await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
  return socketPath;
}

async function client(dir: string): Promise<EngineClient> {
  const connected = await connect({ dir, lockPath: lockIn(dir), startTimeoutMs: 2_000 });
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
  expect(await raw.next()).toEqual({ kind: "welcome", apiVersion: API_VERSION, engineId: handle.engineId, engineVersion: "0.0.0", pid: process.pid, runningItems: 0 });
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
    expect(statSync(lockPath).mode & 0o777).toBe(0o600);
    expect(socketPath).toMatch(/\/s-[0-9a-f]{8}\.sock$/);
    expect(lockPath).toBe(lockIn(dir));
    expect(readFileSync(lockPath, "utf8")).toBe(`${process.pid} ${handle.engineId} ${socketPath}\n`);
    expect(readdirSync(dir).sort()).toEqual([lockPath, socketPath, tokenPath].map((path) => path.slice(dir.length + 1)).sort());

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
    expect(await connect({ dir, lockPath: lockIn(dir) })).toMatchObject({ ok: false, error: { code: "unauthorized" } });
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

  it("says its build version, in the welcome and in the version refusal", async () => {
    const dir = tempEngineDir(cleanups);
    const handle = await engine(dir, { engineVersion: "1.2.3" });
    const token = readFileSync(handle.endpoint.tokenPath, "utf8");

    const welcomed = await rawConnect(handle.endpoint.socketPath);
    cleanups.push(() => welcomed.destroy());
    welcomed.send({ kind: "hello", apiVersion: API_VERSION, token });
    expect(await welcomed.next()).toMatchObject({ kind: "welcome", engineVersion: "1.2.3" });

    const refused = await rawConnect(handle.endpoint.socketPath);
    refused.send({ kind: "hello", apiVersion: API_VERSION + 1, token });
    expect(await refused.next()).toMatchObject({ kind: "connection_error", code: "unsupported_version", engineVersion: "1.2.3" });
    await refused.closed;
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
    // It says who it is, so a client signals only the process that answered.
    expect(await raw.next()).toEqual({ kind: "shutdown_accepted", apiVersion: API_VERSION, engineId: handle.engineId, pid: process.pid });
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

  it("listens first and publishes its lock after: the socket the lock names accepts from the moment the lock exists", async () => {
    // A client that finds a lock waits on its socket, so the socket must already accept then.
    const dir = tempEngineDir(cleanups);
    const lockPath = lockIn(dir);
    const starting = startEngine({ dir });
    let seen: { text: string; socket: Awaited<ReturnType<typeof probeSocket>> } | undefined;
    while (seen === undefined) {
      const lock = readEngineLock(lockPath);
      if (lock !== undefined) seen = { text: lock.text, socket: await probeSocket(lock.socketPath) };
      else await new Promise((resolve) => setImmediate(resolve));
    }
    const started = await starting;
    if (!started.ok) throw new Error(started.error.message);
    cleanups.push(() => started.value.close());
    expect(seen.socket).toBe("alive");
    expect(seen.text).toBe(`${process.pid} ${started.value.engineId} ${started.value.endpoint.socketPath}`);
  });

  it("answers a hello that came while the start was held after listening, once the start goes on", async () => {
    const dir = tempEngineDir(cleanups);
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    cleanups.push(() => release());
    let listening = () => {};
    const heldAtListen = new Promise<void>((resolve) => (listening = resolve));
    const starting = startEngine({
      dir,
      afterListen: async () => {
        listening();
        await gate;
      },
    });
    await heldAtListen;
    // No lock yet, but the socket is there and takes the connection; the hello waits.
    expect(existsSync(lockIn(dir))).toBe(false);
    const [name] = readdirSync(dir).filter((file) => file.endsWith(".sock"));
    if (name === undefined) throw new Error("no socket");
    const raw = await rawConnect(join(dir, name));
    cleanups.push(() => raw.destroy());
    raw.send({ kind: "hello", apiVersion: API_VERSION, token: readFileSync(join(dir, name.replace(/\.sock$/, ".token")), "utf8") });
    let early = false;
    const answered = raw.next().then((message) => ((early = true), message));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(early).toBe(false);
    release();
    const started = await starting;
    if (!started.ok) throw new Error(started.error.message);
    cleanups.push(() => started.value.close());
    expect(await answered).toMatchObject({ kind: "welcome", engineId: started.value.engineId, pid: process.pid });
  });

  it("does not signal a process that took a dead engine's pid when a new engine listens but has not replaced the lock", async () => {
    // Engine A (pid P, id X) was killed and left its lock. Another process took pid P. Engine B
    // listens and has not published its lock yet. A stop meant for X must send no signal.
    const dir = tempEngineDir(cleanups);
    mkdirSync(dir, { mode: 0o700 });
    const unrelated = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
    cleanups.push(() => unrelated.kill("SIGKILL"));
    if (unrelated.pid === undefined) throw new Error("no pid");
    const dead = await deadSocket(dir, "s-deadbeef");
    writeFileSync(lockIn(dir), `${unrelated.pid} e-x ${dead}\n`, { mode: 0o600 });

    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    cleanups.push(() => release());
    let listening = () => {};
    const heldAtListen = new Promise<void>((resolve) => (listening = resolve));
    const starting = startEngine({
      dir,
      afterListen: async () => {
        listening();
        await gate;
      },
    });
    await heldAtListen;

    const signals: [number, string][] = [];
    const result = await stopEngine({ lockPath: lockIn(dir), expectedEngineId: "e-x", ifIdle: false, force: true, signal: (pid, signal) => void signals.push([pid, signal]) });
    expect(result).toEqual({ kind: "stopped", forced: false });
    expect(signals).toEqual([]);
    expect(unrelated.exitCode).toBeNull();

    release();
    const started = await starting;
    if (!started.ok) throw new Error(started.error.message);
    cleanups.push(() => started.value.close());
    expect(readEngineLock(lockIn(dir))?.engineId).toBe(started.value.engineId);
  });

  describe("a shutdown request with ifIdle", () => {
    const putItem = (handle: EngineHandle, n: number, state: "running" | "queued" | "needs_you") =>
      handle.store.put({ ...sampleItem(`Item ${n}`), id: `item_${n}b9f3c1e-6a2d-4f7b-9c1a-2e3d4f5a6b7c` as never, state });
    const askIfIdle = async (handle: EngineHandle) => {
      const raw = await rawConnect(handle.endpoint.socketPath);
      cleanups.push(() => raw.destroy());
      raw.send({ kind: "shutdown", apiVersion: API_VERSION, token: readFileSync(handle.endpoint.tokenPath, "utf8"), ifIdle: true });
      return raw;
    };

    it("is refused with the count while items run or wait to start, and the engine keeps serving", async () => {
      const dir = tempEngineDir(cleanups);
      const handle = await engine(dir);
      putItem(handle, 1, "running");
      putItem(handle, 2, "queued");
      putItem(handle, 3, "needs_you");

      const raw = await askIfIdle(handle);
      expect(await raw.next()).toEqual({ kind: "shutdown_refused", apiVersion: API_VERSION, engineId: handle.engineId, pid: process.pid, runningItems: 2 });
      await raw.closed;

      const welcomed = await rawConnect(handle.endpoint.socketPath);
      cleanups.push(() => welcomed.destroy());
      welcomed.send({ kind: "hello", apiVersion: API_VERSION, token: readFileSync(handle.endpoint.tokenPath, "utf8") });
      expect(await welcomed.next()).toMatchObject({ kind: "welcome", runningItems: 1 });
      expect(existsSync(handle.endpoint.socketPath)).toBe(true);
    });

    it("stops the engine when nothing runs, even with an item that waits for the user", async () => {
      const dir = tempEngineDir(cleanups);
      const handle = await engine(dir);
      putItem(handle, 3, "needs_you");
      const { socketPath, tokenPath, lockPath } = handle.endpoint;

      const raw = await askIfIdle(handle);
      expect(await raw.next()).toEqual({ kind: "shutdown_accepted", apiVersion: API_VERSION, engineId: handle.engineId, pid: process.pid });
      await raw.closed;
      await handle.closed;
      expect([socketPath, tokenPath, lockPath].filter((path) => existsSync(path))).toEqual([]);
    });

    it("stops a busy engine when the request does not say ifIdle", async () => {
      const dir = tempEngineDir(cleanups);
      const handle = await engine(dir);
      putItem(handle, 1, "running");
      const raw = await rawConnect(handle.endpoint.socketPath);
      cleanups.push(() => raw.destroy());
      raw.send({ kind: "shutdown", apiVersion: API_VERSION, token: readFileSync(handle.endpoint.tokenPath, "utf8") });
      expect(await raw.next()).toEqual({ kind: "shutdown_accepted", apiVersion: API_VERSION, engineId: handle.engineId, pid: process.pid });
      await handle.closed;
    });

    it("refuses without a count when the store cannot list its items", async () => {
      const dir = tempEngineDir(cleanups);
      const handle = await engine(dir);
      const spy = vi.spyOn(handle.store, "list").mockImplementation(() => {
        throw new Error("unreadable");
      });
      const raw = await askIfIdle(handle);
      expect(await raw.next()).toEqual({ kind: "shutdown_refused", apiVersion: API_VERSION, engineId: handle.engineId, pid: process.pid });
      spy.mockRestore();
    });

    it("is refused while a command is still being handled, and accepted once it is answered", async () => {
      const dir = tempEngineDir(cleanups);
      let release = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      cleanups.push(() => release());
      let reached = () => {};
      const arrived = new Promise<void>((resolve) => (reached = resolve));
      const started = await startEngine({
        dir,
        beforeCommand: async () => {
          reached();
          await gate;
        },
      });
      if (!started.ok) throw new Error(started.error.message);
      cleanups.push(() => started.value.close());
      const connected = await client(dir);
      const command = connected.command({ type: "stop_item", itemId: ITEM_ID });
      await arrived;

      const refused = await askIfIdle(started.value);
      expect(await refused.next()).toEqual({ kind: "shutdown_refused", apiVersion: API_VERSION, engineId: started.value.engineId, pid: process.pid, runningItems: 1 });
      release();
      expect(await command).toMatchObject({ ok: false });

      const accepted = await askIfIdle(started.value);
      expect(await accepted.next()).toEqual({ kind: "shutdown_accepted", apiVersion: API_VERSION, engineId: started.value.engineId, pid: process.pid });
      await started.value.closed;
    });

    it("answers a command that arrives while the engine drains with invalid_state", async () => {
      const dir = tempEngineDir(cleanups);
      // A machine reading that stays open holds the drain, so a connected client can still send.
      let release = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      cleanups.push(() => release());
      const started = await startEngine({
        dir,
        machineSource: { memory: async () => (await gate, err("no access")), processes: async () => (await gate, err("no access")) },
      });
      if (!started.ok) throw new Error(started.error.message);
      cleanups.push(() => started.value.close());
      const connected = await client(dir);
      const reading = connected.query({ type: "machine" });

      const raw = await askIfIdle(started.value);
      expect(await raw.next()).toEqual({ kind: "shutdown_accepted", apiVersion: API_VERSION, engineId: started.value.engineId, pid: process.pid });
      const late = await connected.command({ type: "stop_item", itemId: ITEM_ID });
      expect(late).toMatchObject({ ok: false, error: { code: "invalid_state", message: "The engine is shutting down." } });
      release();
      await reading;
      await started.value.closed;
    });
  });

  it("is stopped by the client's requestShutdown, which an engine that does not know it refuses", async () => {
    const dir = tempEngineDir(cleanups);
    const handle = await engine(dir);
    const { socketPath, tokenPath } = handle.endpoint;
    expect(await requestShutdown({ socketPath, tokenPath })).toBe(true);
    await handle.closed;
    expect(await requestShutdown({ socketPath, tokenPath })).toBe(false);
  });

  it("answers a shutdown request while it drains, with its id and pid, and closes any other connection", async () => {
    const dir = tempEngineDir(cleanups);
    const started = await startEngine({ dir, shutdownTimeoutMs: 5_000 });
    if (!started.ok) throw new Error(started.error.message);
    const handle = started.value;
    cleanups.push(() => handle.close());
    const { socketPath, tokenPath } = handle.endpoint;
    const token = readFileSync(tokenPath, "utf8");
    // A client that does not close when asked keeps the engine draining.
    const stuck = await rawConnect(socketPath, { allowHalfOpen: true });
    cleanups.push(() => stuck.destroy());
    stuck.send({ kind: "hello", apiVersion: API_VERSION, token });
    await stuck.next();
    const closing = handle.close();

    const asking = await rawConnect(socketPath);
    cleanups.push(() => asking.destroy());
    asking.send({ kind: "shutdown", apiVersion: API_VERSION, token, ifIdle: true });
    expect(await asking.next()).toEqual({ kind: "shutdown_accepted", apiVersion: API_VERSION, engineId: handle.engineId, pid: process.pid });
    await asking.closed;

    // A hello, a wrong token, or silence gets no reply at all.
    const hello = await rawConnect(socketPath);
    hello.send({ kind: "hello", apiVersion: API_VERSION, token });
    await hello.closed;
    const wrong = await rawConnect(socketPath);
    wrong.send({ kind: "shutdown", apiVersion: API_VERSION, token: "0".repeat(64) });
    await wrong.closed;
    const silent = await rawConnect(socketPath);
    cleanups.push(() => silent.destroy());
    expect(await probeSocket(socketPath)).toBe("alive");

    stuck.destroy();
    await closing;
    await silent.closed;
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

  it("takes over the lock of a dead engine whose socket file is still there, and sweeps its files", async () => {
    const dir = tempEngineDir(cleanups);
    const dead = await deadSocket(dir, "s-deadbeef");
    // A crashed engine's pid may belong to anything by now: this live test process stands in.
    writeFileSync(lockIn(dir), `${process.pid} e-crashed ${dead}\n`, { mode: 0o600 });

    const handle = await engine(dir);
    expect(readFileSync(handle.endpoint.lockPath, "utf8")).toBe(`${process.pid} ${handle.engineId} ${handle.endpoint.socketPath}\n`);
    expect((await client(dir)).engineId).toBe(handle.engineId);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(dead.replace(/\.sock$/, ".token"))).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(["engine.lock", handle.endpoint.socketPath, handle.endpoint.tokenPath].map((path) => path.slice(path.lastIndexOf("/") + 1)).sort());
  });

  it("takes over the lock of an engine whose socket file is gone", async () => {
    const dir = tempEngineDir(cleanups);
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(lockIn(dir), `${process.pid} e-crashed ${join(dir, "s-deadbeef.sock")}\n`, { mode: 0o600 });

    const handle = await engine(dir);
    expect(readEngineLock(lockIn(dir))?.engineId).toBe(handle.engineId);
  });

  it("keeps the lock of a live engine that does not answer yet, however long that takes", async () => {
    const dir = tempEngineDir(cleanups);
    mkdirSync(dir, { mode: 0o700 });
    // A plain server that accepts and says nothing, like an engine that is opening a large item log.
    const socketPath = join(dir, "s-1a2b3c4d.sock");
    const silent: Server = createServer((socket) => socket.on("error", () => {}));
    await new Promise<void>((resolve) => silent.listen(socketPath, resolve));
    cleanups.push(() => new Promise((resolve) => silent.close(resolve)));
    const text = `${process.pid} e-starting ${socketPath}\n`;
    writeFileSync(lockIn(dir), text, { mode: 0o600 });

    expect(await startEngine({ dir })).toMatchObject({ ok: false, error: { code: "already_running", message: expect.stringContaining(socketPath) } });
    expect(readFileSync(lockIn(dir), "utf8")).toBe(text);
    // The loser leaves nothing behind but the files that were there.
    expect(readdirSync(dir).sort()).toEqual(["engine.lock", "s-1a2b3c4d.sock"]);
  });

  it("replaces a lock that names no engine, without reading anything it points to", async () => {
    const dir = tempEngineDir(cleanups);
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(lockIn(dir), "", { mode: 0o600 });
    const handle = await engine(dir);
    expect(readEngineLock(lockIn(dir))?.engineId).toBe(handle.engineId);
  });

  it("removes a symlink in place of the lock without reading or touching its target", async () => {
    const dir = tempEngineDir(cleanups);
    mkdirSync(dir, { mode: 0o700 });
    const target = join(dir, "elsewhere");
    writeFileSync(target, `${process.pid} e-other ${join(dir, "s-1a2b3c4d.sock")}\n`);
    symlinkSync(target, join(dir, "engine.lock"));

    const handle = await engine(dir);
    expect(readFileSync(handle.endpoint.lockPath, "utf8")).toContain(handle.engineId);
    expect(readFileSync(target, "utf8")).toBe(`${process.pid} e-other ${join(dir, "s-1a2b3c4d.sock")}\n`);
  });

  it("keeps the socket of a live engine that is not its own when it sweeps, and removes only dead ones", async () => {
    const dir = tempEngineDir(cleanups);
    mkdirSync(dir, { mode: 0o700 });
    const livePath = join(dir, "s-0a0a0a0a.sock");
    writeFileSync(join(dir, "s-0a0a0a0a.token"), "live");
    const live: Server = createServer((socket) => socket.on("error", () => {}));
    await new Promise<void>((resolve) => live.listen(livePath, resolve));
    cleanups.push(() => new Promise((resolve) => live.close(resolve)));
    const dead = await deadSocket(dir, "s-0b0b0b0b");

    // This engine's lock is in a home of its own, so the live server's engine is no rival.
    const home = mkdtempSync(join(tmpdir(), "tk-home-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const started = await startEngine({ dir, home });
    if (!started.ok) throw new Error(started.error.message);
    cleanups.push(() => started.value.close());
    expect(existsSync(livePath)).toBe(true);
    expect(existsSync(join(dir, "s-0a0a0a0a.token"))).toBe(true);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(join(dir, "s-0b0b0b0b.token"))).toBe(false);
  });

  it("names the folder when the file system cannot link a lock", async () => {
    const dir = tempEngineDir(cleanups);
    vi.mocked(linkSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });
    const started = await startEngine({ dir });
    expect(started).toMatchObject({ ok: false, error: { code: "start_failed", message: expect.stringContaining(lockIn(dir)) } });
    // Nothing is left behind.
    expect(readdirSync(dir)).toEqual([]);
  });

  // Two engines start at once on one home; whichever links its lock first wins, whatever else happens.
  describe.each([
    ["on an empty home", false],
    ["on a stale lock", true],
  ])("two starters %s", (_label, stale) => {
    it("end with one engine running, the loser's files gone and the lock naming the winner", async () => {
      for (let round = 0; round < 20; round++) {
        const root = mkdtempSync(join(tmpdir(), "tk-two-"));
        cleanups.push(() => rmSync(root, { recursive: true, force: true }));
        const dir = join(root, "run");
        const home = join(root, "home");
        mkdirSync(home, { mode: 0o700 });
        if (stale) {
          const dead = await deadSocket(dir, "s-deadbeef");
          writeFileSync(join(home, "engine.lock"), `${process.pid} e-crashed ${dead}\n`, { mode: 0o600 });
        }
        const [first, second] = await Promise.all([startEngine({ dir, home }), startEngine({ dir, home })]);
        const winners = [first, second].filter((result) => result.ok);
        const losers = [first, second].filter((result) => !result.ok);
        expect(winners, `round ${round}`).toHaveLength(1);
        expect(losers, `round ${round}`).toHaveLength(1);
        expect(losers[0]).toMatchObject({ ok: false, error: { code: "already_running" } });
        const winner = winners[0];
        if (winner === undefined || !winner.ok) throw new Error("no winner");
        const lock = readEngineLock(join(home, "engine.lock"));
        expect(lock?.engineId, `round ${round}`).toBe(winner.value.engineId);
        expect(lock?.socketPath).toBe(winner.value.endpoint.socketPath);
        expect(readdirSync(dir).sort(), `round ${round}`).toEqual([winner.value.endpoint.socketPath, winner.value.endpoint.tokenPath].map((path) => path.slice(path.lastIndexOf("/") + 1)).sort());
        await winner.value.close();
        expect(existsSync(join(home, "engine.lock"))).toBe(false);
      }
    }, 60_000);
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
