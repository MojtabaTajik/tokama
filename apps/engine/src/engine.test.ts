import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClientEvent, connect, type EngineClient } from "@tokama/client";
import { API_VERSION, MAX_MESSAGE_BYTES } from "@tokama/core";
import { afterEach, describe, expect, it } from "vitest";
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
  expect(await raw.next()).toEqual({ kind: "welcome", apiVersion: API_VERSION, engineId: handle.engineId });
  return raw;
}

describe("engine service", () => {
  it("handshakes, answers queries from its store and refuses commands cleanly", async () => {
    const dir = tempEngineDir(cleanups);
    const handle = await engine(dir);
    const engineClient = await client(dir);

    expect(engineClient.engineId).toBe(handle.engineId);
    expect(await engineClient.query({ type: "board", workspaceId: "northwind-prod" })).toEqual({ ok: true, data: { items: [] } });
    expect(await engineClient.query({ type: "item", itemId: ITEM_ID })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await engineClient.command({ type: "stop_item", itemId: ITEM_ID })).toMatchObject({
      ok: false,
      error: { code: "not_implemented" },
    });

    // The client validates before sending.
    expect(await engineClient.query({ type: "board", workspaceId: "Not Valid" })).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });

    handle.store.put(sampleItem());
    expect(await engineClient.query({ type: "item", itemId: ITEM_ID })).toEqual({ ok: true, data: { item: sampleItem() } });
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
    expect(readFileSync(lockPath, "utf8").trim()).toBe(String(process.pid));

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

  it("closes a connection that does not start with a hello", async () => {
    const dir = tempEngineDir(cleanups);
    const handle = await engine(dir);

    const raw = await rawConnect(handle.endpoint.socketPath);
    raw.send({ apiVersion: API_VERSION, kind: "query", requestId: "r1", query: { type: "board", workspaceId: "northwind-prod" } });
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

    raw.send({ apiVersion: API_VERSION, kind: "query", requestId: "r1", query: { type: "board", workspaceId: "Not Valid" } });
    expect(await raw.next()).toMatchObject({ kind: "reply", requestId: "r1", result: { ok: false, error: { code: "invalid_message" } } });

    raw.send({ apiVersion: API_VERSION, kind: "query", requestId: "r2", query: { type: "board", workspaceId: "northwind-prod" } });
    expect(await raw.next()).toEqual({ apiVersion: API_VERSION, kind: "reply", requestId: "r2", result: { ok: true, data: { items: [] } } });

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
    expect(await engineClient.query({ type: "board", workspaceId: "northwind-prod" })).toMatchObject({
      ok: false,
      error: { code: "disconnected" },
    });

    const second = await engine(dir);
    await waitFor(() => events.some((event) => event.kind === "reconnected"), 5_000, "reconnected");
    expect(events.at(-1)).toEqual({ kind: "reconnected", engineId: second.engineId });
    expect(second.engineId).not.toBe(first.engineId);
    expect(engineClient.engineId).toBe(second.engineId);

    expect(await engineClient.query({ type: "board", workspaceId: "northwind-prod" })).toEqual({ ok: true, data: { items: [] } });
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
