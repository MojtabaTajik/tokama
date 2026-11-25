import type { ClientEvent, ConnectError, EngineClient } from "@tokama/client";
import { err, ok, type Result } from "@tokama/core";
import { describe, expect, it, vi } from "vitest";
import type { BridgeEvent, ConnectionState } from "../shared/bridge.js";
import { watchConnection } from "./connection.js";
import type { ReplaceResult } from "./replace.js";

/** A client whose events the test pushes by hand. */
function fakeClient(engineId = "engine-1") {
  const queue: ClientEvent[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const client = {
    engineId,
    query: vi.fn(),
    command: vi.fn(),
    close: vi.fn(async () => {
      ended = true;
      wake?.();
    }),
    events: () => ({
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length === 0 && !ended) await new Promise<void>((resolve) => (wake = resolve));
          const event = queue.shift();
          if (event === undefined) return;
          yield event;
          if (event.kind === "failed") return;
        }
      },
    }),
  } satisfies EngineClient;
  const push = (event: ClientEvent) => {
    queue.push(event);
    wake?.();
  };
  return { client, push };
}

const APP_API = 7;

function watch(
  connect: () => Promise<Result<EngineClient, ConnectError>>,
  logTail: string[] = [],
  replaceOlder: () => Promise<ReplaceResult> = async () => ({ ok: true, forced: false }),
) {
  const states: ConnectionState[] = [];
  const events: BridgeEvent[] = [];
  const readLogTail = vi.fn(() => logTail);
  const replace = vi.fn(replaceOlder);
  const watcher = watchConnection({
    connect,
    logPath: "/run/tokama/engine.log",
    readLogTail,
    onState: (s) => states.push(s),
    onEvent: (e) => events.push(e),
    apiVersion: APP_API,
    replaceOlder: replace,
    olderLock: () => ({ lockPath: "/run/tokama/engine.lock", pid: 4821 }),
    waitPollMs: 10,
  });
  return { watcher, states, events, readLogTail, replace };
}

/** The refusal of an engine with `apiVersion`, reporting `runningItems` unless undefined. */
const versionRefusal = (apiVersion: number, runningItems?: number): ConnectError => ({
  code: "unsupported_version",
  message: `engine speaks API version ${apiVersion}, client sent ${APP_API}`,
  engine: { apiVersion, ...(runningItems !== undefined && { runningItems }) },
});

type Connect = () => Promise<Result<EngineClient, ConnectError>>;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("watchConnection", () => {
  it("starts in 'starting' and becomes 'connected' with the engine id", async () => {
    const { client } = fakeClient("engine-7");
    const { watcher, states } = watch(async () => ok(client));
    expect(watcher.state()).toEqual({ status: "starting" });
    await settle();
    expect(states).toEqual([{ status: "connected", engineId: "engine-7" }]);
    expect(watcher.state()).toEqual({ status: "connected", engineId: "engine-7" });
  });

  it("fails with the connect error, the log path and the log tail", async () => {
    const error: ConnectError = { code: "start_failed", message: "the engine exited with code 1 before it accepted a connection" };
    const { watcher, readLogTail } = watch(async () => err(error), ["Error: boom"]);
    await settle();
    expect(watcher.state()).toEqual({
      status: "failed",
      reason: error.message,
      logPath: "/run/tokama/engine.log",
      logTail: ["Error: boom"],
    });
    expect(readLogTail).toHaveBeenCalledWith("/run/tokama/engine.log");
  });

  describe("an older engine", () => {
    it("is replaced at once when it runs nothing: updating, then connected to the new engine", async () => {
      const { client } = fakeClient("engine-new");
      const connect = vi.fn<Connect>().mockResolvedValueOnce(err(versionRefusal(APP_API - 1, 0))).mockResolvedValueOnce(ok(client));
      const { watcher, states, replace } = watch(connect);
      await settle();
      await settle();
      expect(replace).toHaveBeenCalledOnce();
      expect(states).toEqual([{ status: "starting", updating: true }, { status: "connected", engineId: "engine-new" }]);
      expect(watcher.state()).toEqual({ status: "connected", engineId: "engine-new" });
      expect(client.command).not.toHaveBeenCalled();
    });

    it("asks first when it runs items, and Restart now replaces it", async () => {
      const { client } = fakeClient("engine-new");
      const busy = err(versionRefusal(APP_API - 1, 3));
      const connect = vi.fn<Connect>().mockResolvedValueOnce(busy).mockResolvedValueOnce(busy).mockResolvedValueOnce(ok(client));
      const { watcher, states, replace } = watch(connect);
      await settle();
      expect(replace).not.toHaveBeenCalled();
      expect(watcher.state()).toMatchObject({
        status: "failed",
        reason: "An older Tokama engine is still running. Restart it?",
        older: { runningItems: 3, waiting: false, lockPath: "/run/tokama/engine.lock", pid: 4821 },
      });
      watcher.restartEngine();
      await settle();
      await settle();
      expect(replace).toHaveBeenCalledOnce();
      expect(states.map((s) => s.status)).toEqual(["failed", "starting", "starting", "connected"]);
      expect(states[2]).toEqual({ status: "starting", updating: true });
    });

    it("on Wait, checks again until nothing runs, then replaces it", async () => {
      const { client } = fakeClient("engine-new");
      const connect = vi
        .fn<Connect>()
        .mockResolvedValueOnce(err(versionRefusal(APP_API - 1, 2)))
        .mockResolvedValueOnce(err(versionRefusal(APP_API - 1, 1)))
        .mockResolvedValueOnce(err(versionRefusal(APP_API - 1, 0)))
        .mockResolvedValueOnce(ok(client));
      const { watcher, states, replace } = watch(connect);
      await settle();
      watcher.waitForEngine();
      expect(watcher.state()).toMatchObject({ status: "failed", older: { runningItems: 2, waiting: true } });
      expect(connect).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(watcher.state()).toEqual({ status: "connected", engineId: "engine-new" }));
      expect(connect).toHaveBeenCalledTimes(4);
      expect(replace).toHaveBeenCalledOnce();
      expect(states.map((s) => (s.status === "failed" ? `${String(s.older?.runningItems)} ${String(s.older?.waiting)}` : s.status))).toEqual([
        "2 false",
        "2 true",
        "1 true",
        "starting",
        "connected",
      ]);
    });

    it("asks when it is too old to say whether it runs items, and offers no Wait", async () => {
      const connect = vi.fn<Connect>().mockResolvedValue(err(versionRefusal(APP_API - 1)));
      const { watcher, replace } = watch(connect);
      await settle();
      expect(watcher.state()).toMatchObject({ status: "failed", reason: "An older Tokama engine is still running. Restart it?", older: { waiting: false } });
      expect(watcher.state()).not.toHaveProperty("older.runningItems");
      watcher.waitForEngine();
      await settle();
      expect(connect).toHaveBeenCalledOnce();
      expect(replace).not.toHaveBeenCalled();
    });

    it("shows why when the replace fails, with Retry", async () => {
      const connect = vi.fn<Connect>().mockResolvedValue(err(versionRefusal(APP_API - 1, 0)));
      const { watcher } = watch(connect, [], async () => ({ ok: false, reason: "could not confirm pid 4821" }));
      await settle();
      await settle();
      expect(watcher.state()).toEqual({ status: "failed", reason: "could not confirm pid 4821", logPath: "/run/tokama/engine.log", logTail: [] });
    });

    it("marks the crash seen on the new engine after it had to kill the old one", async () => {
      const { client } = fakeClient("engine-new");
      client.command.mockResolvedValue({ ok: true, data: {} });
      const connect = vi.fn<Connect>().mockResolvedValueOnce(err(versionRefusal(APP_API - 1, 0))).mockResolvedValueOnce(ok(client));
      const { watcher } = watch(connect, [], async () => ({ ok: true, forced: true }));
      await vi.waitFor(() => expect(watcher.state().status).toBe("connected"));
      expect(client.command).toHaveBeenCalledWith({ type: "diagnostics_settings", crashSeen: true });
    });

    it("asks rather than replacing again when an older engine still answers right after a replace", async () => {
      const connect = vi.fn<Connect>().mockResolvedValue(err(versionRefusal(APP_API - 1, 0)));
      const { watcher, replace } = watch(connect);
      await settle();
      await settle();
      expect(replace).toHaveBeenCalledOnce();
      expect(watcher.state()).toMatchObject({ status: "failed", older: { runningItems: 0, waiting: false } });
    });
  });

  it("never replaces a newer engine, and says so", async () => {
    const { watcher, replace } = watch(async () => err(versionRefusal(APP_API + 1, 0)));
    await settle();
    expect(replace).not.toHaveBeenCalled();
    expect(watcher.state()).toMatchObject({ status: "failed", reason: expect.stringContaining("A newer Tokama engine is running") });
    expect(watcher.state()).not.toHaveProperty("older");
    watcher.restartEngine();
    await settle();
    expect(replace).not.toHaveBeenCalled();
  });

  it("follows a lost connection through 'reconnecting' back to 'connected'", async () => {
    const { client, push } = fakeClient("engine-1");
    const { states } = watch(async () => ok(client));
    await settle();
    push({ kind: "disconnected" });
    await settle();
    push({ kind: "reconnected", engineId: "engine-2" });
    await settle();
    expect(states).toEqual([
      { status: "connected", engineId: "engine-1" },
      { status: "reconnecting" },
      { status: "connected", engineId: "engine-2" },
    ]);
  });

  it("passes engine events on without a state change, and fails when the client gives up", async () => {
    const { client, push } = fakeClient();
    const { watcher, states, events } = watch(async () => ok(client));
    await settle();
    const event = { kind: "event", seq: 1, event: { type: "item_updated" } } as unknown as ClientEvent;
    push(event);
    push({ kind: "disconnected" });
    push({ kind: "failed", error: { code: "unauthorized", message: "bad token" } });
    await settle();
    expect(events).toEqual([event]);
    expect(states.map((s) => s.status)).toEqual(["connected", "reconnecting", "failed"]);
    expect(watcher.state()).toMatchObject({ status: "failed", reason: "bad token" });
  });

  it("gives out the client only while connected or reconnecting", async () => {
    const { client, push } = fakeClient();
    let resolve: (value: Result<EngineClient, ConnectError>) => void = () => {};
    const { watcher } = watch(() => new Promise((r) => (resolve = r)));
    expect(watcher.client()).toBeUndefined();
    resolve(ok(client));
    await settle();
    expect(watcher.client()).toBe(client);
    push({ kind: "disconnected" });
    await settle();
    expect(watcher.client()).toBe(client);
    push({ kind: "failed", error: { code: "start_failed", message: "gone" } });
    await settle();
    expect(watcher.client()).toBeUndefined();
  });

  it("reports an unexpected throw from connect as a failure", async () => {
    const { watcher } = watch(async () => {
      throw new Error("kaput");
    });
    await settle();
    expect(watcher.state()).toMatchObject({ status: "failed", reason: "unexpected error: Error: kaput" });
  });

  it("closes the client on close and emits nothing after", async () => {
    const { client } = fakeClient();
    const { watcher, states } = watch(async () => ok(client));
    await settle();
    await watcher.close();
    await settle();
    expect(client.close).toHaveBeenCalledOnce();
    expect(states).toEqual([{ status: "connected", engineId: "engine-1" }]);
  });

  it("closes a client that connects after close was called", async () => {
    const { client } = fakeClient();
    let resolve: (value: Result<EngineClient, ConnectError>) => void = () => {};
    const { watcher, states } = watch(() => new Promise((r) => (resolve = r)));
    await watcher.close();
    resolve(ok(client));
    await settle();
    expect(client.close).toHaveBeenCalledOnce();
    expect(states).toEqual([]);
  });

  describe("retry", () => {
    const refused: ConnectError = { code: "start_failed", message: "cannot start the engine: node was not found on PATH" };

    it("connects again after a failure: starting, then connected", async () => {
      const { client } = fakeClient("engine-9");
      const connect = vi.fn<() => Promise<Result<EngineClient, ConnectError>>>().mockResolvedValueOnce(err(refused)).mockResolvedValueOnce(ok(client));
      const { watcher, states } = watch(connect, ["Error: boom"]);
      await settle();
      expect(watcher.state().status).toBe("failed");
      watcher.retry();
      expect(watcher.state()).toEqual({ status: "starting" });
      await settle();
      expect(states.map((s) => s.status)).toEqual(["failed", "starting", "connected"]);
      expect(watcher.state()).toEqual({ status: "connected", engineId: "engine-9" });
      expect(connect).toHaveBeenCalledTimes(2);
    });

    it("fails again with the new reason when the engine still does not start", async () => {
      const connect = vi.fn<() => Promise<Result<EngineClient, ConnectError>>>().mockResolvedValueOnce(err(refused)).mockResolvedValueOnce(err({ code: "start_failed", message: "still no" }));
      const { watcher } = watch(connect);
      await settle();
      watcher.retry();
      await settle();
      expect(watcher.state()).toMatchObject({ status: "failed", reason: "still no" });
    });

    it("does nothing unless the state is failed", async () => {
      const { client } = fakeClient();
      const connect = vi.fn(async () => ok(client));
      const { watcher } = watch(connect);
      watcher.retry();
      await settle();
      watcher.retry();
      expect(connect).toHaveBeenCalledOnce();
      expect(watcher.state().status).toBe("connected");
    });

    it("closes the failed client and ignores its later events", async () => {
      const first = fakeClient("engine-1");
      const second = fakeClient("engine-2");
      const connect = vi.fn<() => Promise<Result<EngineClient, ConnectError>>>().mockResolvedValueOnce(ok(first.client)).mockResolvedValueOnce(ok(second.client));
      const { watcher, states } = watch(connect);
      await settle();
      first.push({ kind: "failed", error: { code: "unauthorized", message: "bad token" } });
      await settle();
      watcher.retry();
      await settle();
      expect(first.client.close).toHaveBeenCalledOnce();
      first.push({ kind: "disconnected" });
      await settle();
      expect(states.map((s) => s.status)).toEqual(["connected", "failed", "starting", "connected"]);
      expect(watcher.state()).toEqual({ status: "connected", engineId: "engine-2" });
    });

    it("does nothing after close", async () => {
      const connect = vi.fn(async () => err(refused));
      const { watcher } = watch(connect);
      await settle();
      await watcher.close();
      watcher.retry();
      expect(connect).toHaveBeenCalledOnce();
    });
  });
});
