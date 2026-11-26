import type { ClientEvent, ConnectError, EngineClient, EngineInfo } from "@tokama/client";
import { err, ok, type Result } from "@tokama/core";
import { describe, expect, it, vi } from "vitest";
import type { BridgeEvent, ConnectionState } from "../shared/bridge.js";
import { olderBuild, watchConnection } from "./connection.js";
import type { ReplaceResult } from "./replace.js";

/** A client whose events the test pushes by hand. */
function fakeClient(engineId = "engine-1", engine: EngineInfo = { apiVersion: APP_API }) {
  const queue: ClientEvent[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const client = {
    engineId,
    engine,
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
  appVersion?: string,
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
    ...(appVersion !== undefined && { appVersion }),
    replaceOlder: replace,
    olderLock: () => ({ lockPath: "/run/tokama/engine.lock", pid: 4821, engineId: "e-lock" }),
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

describe("olderBuild", () => {
  it.each([
    ["0.1.0", "0.2.0", true],
    ["0.9.0", "0.10.0", true],
    ["0.2.0", "0.2.0", false],
    ["0.3.0", "0.2.0", false],
    ["0.10.0", "0.9.9", false],
    [undefined, "0.2.0", false],
    ["0.0.0", "0.2.0", false],
    ["0.1.0", "0.0.0", false],
    ["0.1.0", undefined, false],
    ["0.1.0-beta", "0.2.0", false],
    ["dev", "0.2.0", false],
    ["0.1", "0.2.0", false],
  ])("engine %s against app %s is %s", (engine, app, expected) => {
    expect(olderBuild(engine, app)).toBe(expected);
  });
});

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
      expect(replace).toHaveBeenCalledExactlyOnceWith("e-lock");
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

  describe("a same-API engine of an older build (packaged app 0.2.0)", () => {
    const APP = "0.2.0";
    /** A client of an engine of the same API version, with `engineVersion` and `runningItems` as given. */
    const sameApi = (engineId: string, engineVersion?: string, runningItems?: number) =>
      fakeClient(engineId, { apiVersion: APP_API, ...(engineVersion !== undefined && { engineVersion }), ...(runningItems !== undefined && { runningItems }) }).client;

    it("is replaced at once when it runs nothing: the old client closes first, then updating, then connected", async () => {
      const old = sameApi("e-old", "0.1.0", 0);
      const fresh = sameApi("engine-new", "0.2.0", 0);
      const connect = vi.fn<Connect>().mockResolvedValueOnce(ok(old)).mockResolvedValueOnce(ok(fresh));
      const { watcher, states, replace } = watch(connect, [], undefined, APP);
      await vi.waitFor(() => expect(watcher.state()).toEqual({ status: "connected", engineId: "engine-new" }));
      expect(replace).toHaveBeenCalledExactlyOnceWith("e-old");
      expect(old.close.mock.invocationCallOrder[0]).toBeLessThan(replace.mock.invocationCallOrder[0] ?? 0);
      expect(states).toEqual([{ status: "starting", updating: true }, { status: "connected", engineId: "engine-new" }]);
      expect(old.command).not.toHaveBeenCalled();
    });

    it("does nothing more when the watcher closes while the probe client is still closing", async () => {
      const old = sameApi("e-old", "0.1.0", 0);
      let finishClose: () => void = () => {};
      old.close.mockImplementation(() => new Promise<void>((resolve) => (finishClose = resolve)));
      const { watcher, states, replace } = watch(async () => ok(old), [], undefined, APP);
      await settle();
      expect(old.close).toHaveBeenCalledOnce();
      const closing = watcher.close();
      finishClose();
      await closing;
      await settle();
      expect(replace).not.toHaveBeenCalled();
      expect(states).toEqual([]);
    });

    it("asks when it runs items, and Restart now replaces it", async () => {
      const busy = () => sameApi("e-old", "0.1.0", 3);
      const connect = vi.fn<Connect>().mockResolvedValueOnce(ok(busy())).mockResolvedValueOnce(ok(busy())).mockResolvedValueOnce(ok(sameApi("engine-new", "0.2.0", 0)));
      const { watcher, replace } = watch(connect, [], undefined, APP);
      await settle();
      expect(replace).not.toHaveBeenCalled();
      expect(watcher.state()).toMatchObject({
        status: "failed",
        reason: "An older Tokama engine is still running. Restart it?",
        older: { runningItems: 3, waiting: false, lockPath: "/run/tokama/engine.lock", pid: 4821 },
      });
      watcher.restartEngine();
      await vi.waitFor(() => expect(watcher.state()).toEqual({ status: "connected", engineId: "engine-new" }));
      expect(replace).toHaveBeenCalledExactlyOnceWith("e-old");
    });

    it("on Wait, checks again until nothing runs, then replaces it", async () => {
      const connect = vi
        .fn<Connect>()
        .mockResolvedValueOnce(ok(sameApi("e-old", "0.1.0", 2)))
        .mockResolvedValueOnce(ok(sameApi("e-old", "0.1.0", 0)))
        .mockResolvedValueOnce(ok(sameApi("engine-new", "0.2.0", 0)));
      const { watcher, replace } = watch(connect, [], undefined, APP);
      await settle();
      watcher.waitForEngine();
      expect(watcher.state()).toMatchObject({ status: "failed", older: { runningItems: 2, waiting: true } });
      await vi.waitFor(() => expect(watcher.state()).toEqual({ status: "connected", engineId: "engine-new" }));
      expect(connect).toHaveBeenCalledTimes(3);
      expect(replace).toHaveBeenCalledOnce();
    });

    it("asks when it is too old to say whether it runs items", async () => {
      const { watcher, replace } = watch(async () => ok(sameApi("e-old", "0.1.0")), [], undefined, APP);
      await settle();
      expect(watcher.state()).toMatchObject({ status: "failed", older: { waiting: false } });
      expect(watcher.state()).not.toHaveProperty("older.runningItems");
      expect(replace).not.toHaveBeenCalled();
    });

    it("asks rather than replacing again when an older build still answers right after a replace", async () => {
      const connect = vi.fn<Connect>().mockImplementation(async () => ok(sameApi("e-old", "0.1.0", 0)));
      const { watcher, replace } = watch(connect, [], undefined, APP);
      await settle();
      await settle();
      expect(replace).toHaveBeenCalledOnce();
      expect(watcher.state()).toMatchObject({ status: "failed", older: { runningItems: 0, waiting: false } });
    });

    it.each([
      ["a newer build", "0.3.0", APP],
      ["an equal build", "0.2.0", APP],
      ["an engine that sends no version", undefined, APP],
      ["a dev engine", "0.0.0", APP],
      ["an engine with an odd label", "0.1.0-beta", APP],
      ["an unpackaged app", "0.1.0", undefined],
      ["a dev app", "0.1.0", "0.0.0"],
    ])("leaves %s alone", async (_label, engineVersion, appVersion) => {
      const client = sameApi("engine-1", engineVersion, 0);
      const { watcher, replace } = watch(async () => ok(client), [], undefined, appVersion);
      await settle();
      expect(watcher.state()).toEqual({ status: "connected", engineId: "engine-1" });
      expect(replace).not.toHaveBeenCalled();
      expect(client.close).not.toHaveBeenCalled();
    });

    it("leaves it alone without a replacer", async () => {
      const client = sameApi("engine-1", "0.1.0", 0);
      const states: ConnectionState[] = [];
      watchConnection({
        connect: async () => ok(client),
        logPath: "/run/tokama/engine.log",
        readLogTail: () => [],
        onState: (s) => states.push(s),
        onEvent: () => {},
        apiVersion: APP_API,
        appVersion: APP,
      });
      await settle();
      expect(states).toEqual([{ status: "connected", engineId: "engine-1" }]);
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

  describe("suspend and resume", () => {
    it("closes the client, names its engine and does not connect again while suspended", async () => {
      const first = fakeClient("engine-1");
      const second = fakeClient("engine-2");
      const connect = vi.fn<Connect>().mockResolvedValueOnce(ok(first.client)).mockResolvedValueOnce(ok(second.client));
      const { watcher, states } = watch(connect);
      await settle();
      expect(await watcher.suspend()).toEqual({ engineId: "engine-1" });
      expect(first.client.close).toHaveBeenCalledOnce();
      expect(watcher.state()).toEqual({ status: "starting", updating: true });
      expect(watcher.client()).toBeUndefined();
      // The closed client's late events change nothing, and nothing reconnects.
      first.push({ kind: "disconnected" });
      first.push({ kind: "failed", error: { code: "unauthorized", message: "late" } });
      await settle();
      expect(connect).toHaveBeenCalledOnce();
      expect(states.map((s) => s.status)).toEqual(["connected", "starting"]);
      watcher.retry();
      watcher.restartEngine();
      await settle();
      expect(connect).toHaveBeenCalledOnce();
    });

    it("connects again on resume, once", async () => {
      const first = fakeClient("engine-1");
      const second = fakeClient("engine-2");
      const connect = vi.fn<Connect>().mockResolvedValueOnce(ok(first.client)).mockResolvedValueOnce(ok(second.client));
      const { watcher } = watch(connect);
      await settle();
      await watcher.suspend();
      watcher.resume();
      watcher.resume();
      await settle();
      expect(connect).toHaveBeenCalledTimes(2);
      expect(watcher.state()).toEqual({ status: "connected", engineId: "engine-2" });
    });

    it("lets a connect that was under way finish into nothing", async () => {
      const late = fakeClient("engine-9");
      let finish: (result: Result<EngineClient, ConnectError>) => void = () => undefined;
      const connect = vi.fn<Connect>(() => new Promise((resolve) => (finish = resolve)));
      const { watcher } = watch(connect);
      await settle();
      expect(await watcher.suspend()).toEqual({});
      finish(ok(late.client));
      await settle();
      expect(late.client.close).toHaveBeenCalledOnce();
      expect(watcher.state()).toEqual({ status: "starting", updating: true });
    });

    it("does nothing on resume without a suspend, and nothing after close", async () => {
      const connect = vi.fn<Connect>().mockResolvedValue(ok(fakeClient().client));
      const { watcher } = watch(connect);
      await settle();
      watcher.resume();
      await settle();
      expect(connect).toHaveBeenCalledOnce();
      await watcher.close();
      expect(await watcher.suspend()).toEqual({});
      watcher.resume();
      expect(connect).toHaveBeenCalledOnce();
    });
  });
});
