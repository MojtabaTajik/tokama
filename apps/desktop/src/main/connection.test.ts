import type { ClientEvent, ConnectError, EngineClient, EngineInfo, StopResult } from "@tokama/client";
import { err, ok, type Result } from "@tokama/core";
import { describe, expect, it, vi } from "vitest";
import type { BridgeEvent, ConnectionState } from "../shared/bridge.js";
import { type StopRequest, watchConnection } from "./connection.js";

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

const STOPPED: StopResult = { kind: "stopped", forced: false };

function watch(
  connect: () => Promise<Result<EngineClient, ConnectError>>,
  logTail: string[] = [],
  stopEngine: (request: StopRequest) => Promise<StopResult> = async () => STOPPED,
  appVersion?: string,
  newestBuildAt?: number,
) {
  const states: ConnectionState[] = [];
  const events: BridgeEvent[] = [];
  const readLogTail = vi.fn(() => logTail);
  const stop = vi.fn(stopEngine);
  const watcher = watchConnection({
    connect,
    logPath: "/run/tokama/engine.log",
    readLogTail,
    onState: (s) => states.push(s),
    onEvent: (e) => events.push(e),
    apiVersion: APP_API,
    ...(appVersion !== undefined && { appVersion }),
    ...(newestBuildAt !== undefined && { newestBuildAt: () => newestBuildAt }),
    stopEngine: stop,
    olderLock: () => ({ lockPath: "/run/tokama/engine.lock", pid: 4821, engineId: "e-lock" }),
  });
  return { watcher, states, events, readLogTail, stop };
}

/** The refusal of an engine with `apiVersion`, reporting `runningItems` unless undefined. */
const versionRefusal = (apiVersion: number, runningItems?: number): ConnectError => ({
  code: "unsupported_version",
  message: `engine speaks API version ${apiVersion}, client sent ${APP_API}`,
  engine: { apiVersion, ...(runningItems !== undefined && { runningItems }) },
});

type Connect = () => Promise<Result<EngineClient, ConnectError>>;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const OLDER_TEXT = "An older Tokama engine is still running. Restart it?";

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

  describe("an older engine of another API version", () => {
    it("is replaced at once when it runs nothing, only if it is still idle: updating, then connected to the new engine", async () => {
      const { client } = fakeClient("engine-new");
      const connect = vi.fn<Connect>().mockResolvedValueOnce(err(versionRefusal(APP_API - 1, 0))).mockResolvedValueOnce(ok(client));
      const { watcher, states, stop } = watch(connect);
      await settle();
      await settle();
      expect(stop).toHaveBeenCalledExactlyOnceWith({ engineId: "e-lock", engine: { apiVersion: APP_API - 1, runningItems: 0 }, ifIdle: true });
      expect(states).toEqual([{ status: "starting", updating: true }, { status: "connected", engineId: "engine-new" }]);
      expect(watcher.state()).toEqual({ status: "connected", engineId: "engine-new" });
      expect(client.command).not.toHaveBeenCalled();
    });

    it("asks first when it runs items, and Restart engine now stops it whatever it runs", async () => {
      const { client } = fakeClient("engine-new");
      const busy = err(versionRefusal(APP_API - 1, 3));
      // The restart connects first, finds the engine busy still, and only then stops it.
      const connect = vi.fn<Connect>().mockResolvedValueOnce(busy).mockResolvedValueOnce(busy).mockResolvedValueOnce(ok(client));
      const { watcher, states, stop } = watch(connect);
      await settle();
      expect(stop).not.toHaveBeenCalled();
      expect(watcher.state()).toMatchObject({
        status: "failed",
        reason: OLDER_TEXT,
        older: { runningItems: 3, lockPath: "/run/tokama/engine.lock", pid: 4821 },
      });
      expect(watcher.state()).not.toHaveProperty("older.waiting");
      watcher.restartEngine();
      await settle();
      await settle();
      expect(stop).toHaveBeenCalledExactlyOnceWith({ engineId: "e-lock", engine: { apiVersion: APP_API - 1, runningItems: 3 }, ifIdle: false });
      expect(states.map((s) => s.status)).toEqual(["failed", "starting", "starting", "connected"]);
      expect(states[2]).toEqual({ status: "starting", updating: true });
    });

    it("keeps the screen when Try again finds it still busy, and replaces it when Try again finds it idle", async () => {
      const { client } = fakeClient("engine-new");
      const connect = vi
        .fn<Connect>()
        .mockResolvedValueOnce(err(versionRefusal(APP_API - 1, 3)))
        .mockResolvedValueOnce(err(versionRefusal(APP_API - 1, 1)))
        .mockResolvedValueOnce(err(versionRefusal(APP_API - 1, 0)))
        .mockResolvedValueOnce(ok(client));
      const { watcher, states, stop } = watch(connect);
      await settle();
      watcher.retry();
      await settle();
      expect(stop).not.toHaveBeenCalled();
      // Only the check the user asked for says when it was made.
      expect(watcher.state()).toMatchObject({ status: "failed", reason: OLDER_TEXT, older: { runningItems: 1, checkedAt: expect.any(Number) } });
      expect(states.find((s) => s.status === "failed")).not.toHaveProperty("older.checkedAt");
      watcher.retry();
      await settle();
      await settle();
      expect(stop).toHaveBeenCalledExactlyOnceWith({ engineId: "e-lock", engine: { apiVersion: APP_API - 1, runningItems: 0 }, ifIdle: true });
      expect(watcher.state()).toEqual({ status: "connected", engineId: "engine-new" });
      expect(connect).toHaveBeenCalledTimes(4);
      expect(states.map((s) => s.status)).toEqual(["failed", "starting", "failed", "starting", "starting", "connected"]);
    });

    it("asks when it is too old to say whether it runs items, and Restart engine now stops it", async () => {
      const { client } = fakeClient("engine-new");
      const unknown = err(versionRefusal(APP_API - 1));
      const connect = vi.fn<Connect>().mockResolvedValueOnce(unknown).mockResolvedValueOnce(unknown).mockResolvedValueOnce(ok(client));
      const { watcher, stop } = watch(connect);
      await settle();
      expect(watcher.state()).toMatchObject({ status: "failed", reason: OLDER_TEXT });
      expect(watcher.state()).not.toHaveProperty("older.runningItems");
      expect(stop).not.toHaveBeenCalled();
      watcher.restartEngine();
      await settle();
      await settle();
      expect(stop).toHaveBeenCalledExactlyOnceWith({ engineId: "e-lock", engine: { apiVersion: APP_API - 1 }, ifIdle: false });
      expect(watcher.state()).toEqual({ status: "connected", engineId: "engine-new" });
    });

    it("shows why when it cannot stop the engine, with Retry", async () => {
      const connect = vi.fn<Connect>().mockResolvedValue(err(versionRefusal(APP_API - 1, 0)));
      const { watcher } = watch(connect, [], async () => ({ kind: "still_running", pid: 4821 }));
      await settle();
      await settle();
      expect(watcher.state()).toEqual({
        status: "failed",
        reason: "The engine (pid 4821) did not stop. Quit it in Activity Monitor (macOS) or with `kill 4821` (Linux), then press Try again.",
        logPath: "/run/tokama/engine.log",
        logTail: [],
      });
    });

    it("leaves diagnostics alone after any stop: the engine's own note tells it that the app killed the old one", async () => {
      for (const outcome of [STOPPED, { kind: "stopped", forced: true }, { kind: "replaced" }] as const) {
        const { client } = fakeClient("engine-new");
        const connect = vi.fn<Connect>().mockResolvedValueOnce(err(versionRefusal(APP_API - 1, 0))).mockResolvedValueOnce(ok(client));
        const { watcher } = watch(connect, [], async () => outcome);
        await vi.waitFor(() => expect(watcher.state().status).toBe("connected"));
        expect(client.query).not.toHaveBeenCalled();
        expect(client.command).not.toHaveBeenCalled();
      }
    });

    it("asks rather than replacing again when an older engine still answers right after a replace", async () => {
      const connect = vi.fn<Connect>().mockResolvedValue(err(versionRefusal(APP_API - 1, 0)));
      const { watcher, stop } = watch(connect);
      await settle();
      await settle();
      expect(stop).toHaveBeenCalledOnce();
      expect(watcher.state()).toMatchObject({ status: "failed", reason: OLDER_TEXT, older: { runningItems: 0 } });
    });

    it("connects and shows the screen when the engine refused the replace because an item started meanwhile", async () => {
      const connect = vi.fn<Connect>().mockResolvedValueOnce(err(versionRefusal(APP_API - 1, 0))).mockResolvedValueOnce(err(versionRefusal(APP_API - 1, 2)));
      const { watcher, states, stop } = watch(connect, [], async () => ({ kind: "refused", runningItems: 2 }));
      await settle();
      await settle();
      expect(stop).toHaveBeenCalledOnce();
      expect(connect).toHaveBeenCalledTimes(2);
      expect(states.map((s) => s.status)).toEqual(["starting", "failed"]);
      expect(watcher.state()).toMatchObject({ status: "failed", reason: OLDER_TEXT, older: { runningItems: 2 } });
    });
  });

  describe("an engine of the same API version and an older build (packaged app 0.2.0)", () => {
    const APP = "0.2.0";
    /** A client of an engine of the same API version, with `engineVersion` and `runningItems` as given. */
    const sameApi = (engineId: string, engineVersion?: string, runningItems?: number) =>
      fakeClient(engineId, { apiVersion: APP_API, ...(engineVersion !== undefined && { engineVersion }), ...(runningItems !== undefined && { runningItems }) }).client;

    it("is replaced at once when it runs nothing: the old client closes first, then updating, then connected", async () => {
      const old = sameApi("e-old", "0.1.0", 0);
      const fresh = sameApi("engine-new", "0.2.0", 0);
      const connect = vi.fn<Connect>().mockResolvedValueOnce(ok(old)).mockResolvedValueOnce(ok(fresh));
      const { watcher, states, stop } = watch(connect, [], undefined, APP);
      await vi.waitFor(() => expect(watcher.state()).toEqual({ status: "connected", engineId: "engine-new" }));
      expect(stop).toHaveBeenCalledExactlyOnceWith({ engineId: "e-old", engine: { apiVersion: APP_API, engineVersion: "0.1.0", runningItems: 0 }, ifIdle: true });
      expect(old.close.mock.invocationCallOrder[0]).toBeLessThan(stop.mock.invocationCallOrder[0] ?? 0);
      expect(states).toEqual([{ status: "starting", updating: true }, { status: "connected", engineId: "engine-new" }]);
      expect(old.command).not.toHaveBeenCalled();
    });

    it("does nothing more when the watcher closes while the probe client is still closing", async () => {
      const old = sameApi("e-old", "0.1.0", 0);
      let finishClose: () => void = () => {};
      old.close.mockImplementation(() => new Promise<void>((resolve) => (finishClose = resolve)));
      const { watcher, states, stop } = watch(async () => ok(old), [], undefined, APP);
      await settle();
      expect(old.close).toHaveBeenCalledOnce();
      const closing = watcher.close();
      finishClose();
      await closing;
      await settle();
      expect(stop).not.toHaveBeenCalled();
      expect(states).toEqual([]);
    });

    it("is used as it is when it runs items: connected and marked stale, no screen, nothing stopped", async () => {
      for (const runningItems of [3, undefined]) {
        const busy = sameApi("e-old", "0.1.0", runningItems);
        const { watcher, states, stop } = watch(async () => ok(busy), [], undefined, APP);
        await settle();
        expect(watcher.state()).toEqual({ status: "connected", engineId: "e-old", staleEngine: true });
        expect(states).toEqual([{ status: "connected", engineId: "e-old", staleEngine: true }]);
        expect(stop).not.toHaveBeenCalled();
        expect(busy.close).not.toHaveBeenCalled();
      }
    });

    it("is replaced at the next connect that finds it idle, without polling", async () => {
      const connect = vi
        .fn<Connect>()
        .mockResolvedValueOnce(ok(sameApi("e-old", "0.1.0", 2)))
        .mockResolvedValueOnce(ok(sameApi("e-old", "0.1.0", 0)))
        .mockResolvedValueOnce(ok(sameApi("engine-new", "0.2.0", 0)));
      const { watcher, stop } = watch(connect, [], undefined, APP);
      await settle();
      expect(connect).toHaveBeenCalledOnce();
      // The next connect: a suspend and resume stand in for the app's next start of the watch.
      await watcher.suspend();
      watcher.resume();
      await vi.waitFor(() => expect(watcher.state()).toEqual({ status: "connected", engineId: "engine-new" }));
      expect(stop).toHaveBeenCalledOnce();
      expect(connect).toHaveBeenCalledTimes(3);
    });

    it("is used as it is, with no screen, when it refuses the replace (an item is queued that its count leaves out)", async () => {
      const old = () => sameApi("e-old", "0.1.0", 0);
      const connect = vi.fn<Connect>().mockResolvedValueOnce(ok(old())).mockResolvedValueOnce(ok(old()));
      const { watcher, states, stop } = watch(connect, [], async () => ({ kind: "refused", runningItems: 1 }), APP);
      await settle();
      await settle();
      expect(stop).toHaveBeenCalledOnce();
      expect(watcher.state()).toEqual({ status: "connected", engineId: "e-old", staleEngine: true });
      expect(states.map((s) => s.status)).toEqual(["starting", "connected"]);
    });

    it("is used as it is, not replaced again, when an older build still answers right after a replace", async () => {
      const connect = vi.fn<Connect>().mockImplementation(async () => ok(sameApi("e-old", "0.1.0", 0)));
      const { watcher, stop } = watch(connect, [], undefined, APP);
      await settle();
      await settle();
      expect(stop).toHaveBeenCalledOnce();
      expect(watcher.state()).toEqual({ status: "connected", engineId: "e-old" });
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
      const { watcher, stop } = watch(async () => ok(client), [], undefined, appVersion);
      await settle();
      expect(watcher.state()).toEqual({ status: "connected", engineId: "engine-1" });
      expect(stop).not.toHaveBeenCalled();
      expect(client.close).not.toHaveBeenCalled();
    });
  });

  describe("an engine of the same API version that runs older code and items", () => {
    const APP = "0.2.0";
    const BUILT = 2000;
    const engineOf = (info: Partial<EngineInfo>): EngineInfo => ({ apiVersion: APP_API, ...info });
    /** Updates of an item that is in `state`, as the engine pushes them. */
    const itemUpdated = (state: string): ClientEvent => ({ kind: "event", seq: 1, event: { type: "item_updated", item: { id: "item_1", state } } } as unknown as ClientEvent);
    const fresh = () => fakeClient("engine-new", engineOf({ engineVersion: APP, runningItems: 0 })).client;

    it("shows the note, and replaces it when an item that stopped running leaves it idle", async () => {
      const busy = fakeClient("e-old", engineOf({ engineVersion: "0.1.0", runningItems: 1 }));
      const probe = fakeClient("e-old", engineOf({ engineVersion: "0.1.0", runningItems: 0 })).client;
      const idle = fakeClient("e-old", engineOf({ engineVersion: "0.1.0", runningItems: 0 })).client;
      const connect = vi.fn<Connect>().mockResolvedValueOnce(ok(busy.client)).mockResolvedValueOnce(ok(probe)).mockResolvedValueOnce(ok(idle)).mockResolvedValueOnce(ok(fresh()));
      const { watcher, states, stop } = watch(connect, [], undefined, APP);
      await settle();
      expect(watcher.state()).toEqual({ status: "connected", engineId: "e-old", staleEngine: true });
      busy.push(itemUpdated("done"));
      await vi.waitFor(() => expect(watcher.state()).toEqual({ status: "connected", engineId: "engine-new" }));
      // The probe was closed at once and was never used; the stop is only for an idle engine.
      expect(probe.close).toHaveBeenCalledOnce();
      expect(busy.client.close).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledExactlyOnceWith({ engineId: "e-old", engine: engineOf({ engineVersion: "0.1.0", runningItems: 0 }), ifIdle: true });
      expect(states.map((s) => s.status)).toEqual(["connected", "starting", "starting", "connected"]);
    });

    it("checks again at an item that left running, and not at one that still runs", async () => {
      const busy = fakeClient("e-old", engineOf({ engineVersion: "0.1.0", runningItems: 2 }));
      const connect = vi.fn<Connect>().mockResolvedValueOnce(ok(busy.client)).mockImplementation(async () => ok(fakeClient("e-old", engineOf({ engineVersion: "0.1.0", runningItems: 2 })).client));
      const { watcher, stop } = watch(connect, [], undefined, APP);
      await settle();
      busy.push(itemUpdated("running"));
      busy.push({ kind: "event", seq: 2, event: { type: "usage_changed" } });
      await settle();
      expect(connect).toHaveBeenCalledOnce();
      busy.push(itemUpdated("needs_you"));
      await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
      await settle();
      // Still busy: nothing is stopped, the screen stays, the note stays.
      expect(stop).not.toHaveBeenCalled();
      expect(watcher.state()).toEqual({ status: "connected", engineId: "e-old", staleEngine: true });
    });

    it("runs one check at a time, and once more when an event came during it (it may have been the last item)", async () => {
      const busy = fakeClient("e-old", engineOf({ engineVersion: "0.1.0", runningItems: 2 }));
      let release: (result: Awaited<ReturnType<Connect>>) => void = () => {};
      const connect = vi
        .fn<Connect>()
        .mockResolvedValueOnce(ok(busy.client))
        .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
        .mockResolvedValueOnce(ok(fakeClient("e-old", engineOf({ engineVersion: "0.1.0", runningItems: 0 })).client))
        .mockResolvedValueOnce(ok(fakeClient("e-old", engineOf({ engineVersion: "0.1.0", runningItems: 0 })).client))
        .mockResolvedValueOnce(ok(fresh()));
      const { watcher, stop } = watch(connect, [], undefined, APP);
      await settle();
      busy.push(itemUpdated("done"));
      busy.push(itemUpdated("stopped"));
      await settle();
      // The second event opened no second connection while the first check waits.
      expect(connect).toHaveBeenCalledTimes(2);
      // The first check read 1 (one item was still running then); the repeat reads 0.
      release(ok(fakeClient("e-old", engineOf({ engineVersion: "0.1.0", runningItems: 1 })).client));
      await vi.waitFor(() => expect(watcher.state()).toEqual({ status: "connected", engineId: "engine-new" }));
      expect(stop).toHaveBeenCalledOnce();
    });

    it("keeps the note when the stop is refused (item B is queued while A ends), and replaces it once B is done", async () => {
      const busy = fakeClient("e-old", engineOf({ engineVersion: "0.1.0", runningItems: 1 }));
      const idleOld = () => fakeClient("e-old", engineOf({ engineVersion: "0.1.0", runningItems: 0 })).client;
      const afterRefusal = fakeClient("e-old", engineOf({ engineVersion: "0.1.0", runningItems: 0 }));
      const connect = vi
        .fn<Connect>()
        .mockResolvedValueOnce(ok(busy.client))
        // A is done: the probe reads 0 (a queued item is not counted), the replace is tried and refused.
        .mockResolvedValueOnce(ok(idleOld()))
        .mockResolvedValueOnce(ok(idleOld()))
        .mockResolvedValueOnce(ok(afterRefusal.client))
        // B is done: the probe, the replace and the new engine.
        .mockResolvedValueOnce(ok(idleOld()))
        .mockResolvedValueOnce(ok(idleOld()))
        .mockResolvedValueOnce(ok(fresh()));
      const stopOutcomes: StopResult[] = [{ kind: "refused", runningItems: 1 }, STOPPED];
      const { watcher, stop } = watch(connect, [], async () => stopOutcomes.shift() ?? STOPPED, APP);
      await settle();
      busy.push(itemUpdated("done"));
      await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
      await settle();
      await settle();
      expect(watcher.state()).toEqual({ status: "connected", engineId: "e-old", staleEngine: true });
      expect(connect).toHaveBeenCalledTimes(4);
      // B's own updates while it sets up (queued) or runs start no check; its end does.
      afterRefusal.push(itemUpdated("queued"));
      afterRefusal.push(itemUpdated("running"));
      await settle();
      expect(connect).toHaveBeenCalledTimes(4);
      afterRefusal.push(itemUpdated("done"));
      await vi.waitFor(() => expect(watcher.state()).toEqual({ status: "connected", engineId: "engine-new" }));
      expect(stop).toHaveBeenCalledTimes(2);
    });

    it("keeps the note when the same engine is reached again, and drops it for an engine that started since", async () => {
      const busy = fakeClient("e-old", engineOf({ engineVersion: "0.1.0", runningItems: 1 }));
      const { watcher } = watch(async () => ok(busy.client), [], undefined, APP);
      await settle();
      busy.push({ kind: "disconnected" });
      await settle();
      expect(watcher.state()).toEqual({ status: "reconnecting" });
      busy.push({ kind: "reconnected", engineId: "e-old" });
      await settle();
      expect(watcher.state()).toEqual({ status: "connected", engineId: "e-old", staleEngine: true });
      busy.push({ kind: "reconnected", engineId: "e-started-by-the-client" });
      await settle();
      expect(watcher.state()).toEqual({ status: "connected", engineId: "e-started-by-the-client" });
    });

    it("does nothing when the watcher closes while a check is open", async () => {
      const busy = fakeClient("e-old", engineOf({ engineVersion: "0.1.0", runningItems: 1 }));
      let release: (result: Awaited<ReturnType<Connect>>) => void = () => {};
      const connect = vi.fn<Connect>().mockResolvedValueOnce(ok(busy.client)).mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
      const { watcher, stop } = watch(connect, [], undefined, APP);
      await settle();
      busy.push(itemUpdated("done"));
      await settle();
      await watcher.close();
      release(ok(fakeClient("e-old", engineOf({ engineVersion: "0.1.0", runningItems: 0 })).client));
      await settle();
      await settle();
      expect(stop).not.toHaveBeenCalled();
      expect(connect).toHaveBeenCalledTimes(2);
    });

    it("leaves it alone, with no note, when the app cannot tell (an unpackaged app that has no built files, or a release engine)", async () => {
      for (const [engine, built] of [
        [engineOf({ engineVersion: "0.1.0", runningItems: 1 }), undefined],
        [engineOf({ engineVersion: "0.1.0", startedAt: 1, runningItems: 1 }), BUILT],
      ] as const) {
        const { watcher, stop } = watch(async () => ok(fakeClient("e-1", engine).client), [], undefined, undefined, built);
        await settle();
        expect(watcher.state()).toEqual({ status: "connected", engineId: "e-1" });
        expect(stop).not.toHaveBeenCalled();
      }
    });

    describe("in a dev app whose engine files were built at 2000", () => {
      const devEngine = (startedAt: number, runningItems: number) => engineOf({ engineVersion: "0.0.0", startedAt, runningItems });

      it("replaces an idle dev engine that started before, at once", async () => {
        const old = fakeClient("e-old", devEngine(1500, 0)).client;
        const connect = vi.fn<Connect>().mockResolvedValueOnce(ok(old)).mockResolvedValueOnce(ok(fakeClient("engine-new", devEngine(2500, 0)).client));
        const { watcher, stop } = watch(connect, [], undefined, undefined, BUILT);
        await vi.waitFor(() => expect(watcher.state()).toEqual({ status: "connected", engineId: "engine-new" }));
        expect(stop).toHaveBeenCalledExactlyOnceWith({ engineId: "e-old", engine: devEngine(1500, 0), ifIdle: true });
      });

      it("uses a busy one with the note, then replaces it once an item leaves it idle", async () => {
        const busy = fakeClient("e-old", devEngine(1500, 1));
        const connect = vi
          .fn<Connect>()
          .mockResolvedValueOnce(ok(busy.client))
          .mockResolvedValueOnce(ok(fakeClient("e-old", devEngine(1500, 0)).client))
          .mockResolvedValueOnce(ok(fakeClient("e-old", devEngine(1500, 0)).client))
          .mockResolvedValueOnce(ok(fakeClient("engine-new", devEngine(2500, 0)).client));
        const { watcher, stop } = watch(connect, [], undefined, undefined, BUILT);
        await settle();
        expect(watcher.state()).toEqual({ status: "connected", engineId: "e-old", staleEngine: true });
        busy.push(itemUpdated("done"));
        await vi.waitFor(() => expect(watcher.state()).toEqual({ status: "connected", engineId: "engine-new" }));
        expect(stop).toHaveBeenCalledOnce();
      });

      it("uses an engine that started after the build", async () => {
        const { watcher, stop } = watch(async () => ok(fakeClient("e-1", devEngine(2000, 0)).client), [], undefined, undefined, BUILT);
        await settle();
        expect(watcher.state()).toEqual({ status: "connected", engineId: "e-1" });
        expect(stop).not.toHaveBeenCalled();
      });
    });
  });

  it("never replaces a newer engine, and says so", async () => {
    const { watcher, stop } = watch(async () => err(versionRefusal(APP_API + 1, 0)));
    await settle();
    expect(stop).not.toHaveBeenCalled();
    expect(watcher.state()).toMatchObject({ status: "failed", reason: expect.stringContaining("A newer Tokama engine is running") });
    expect(watcher.state()).not.toHaveProperty("older");
    watcher.restartEngine();
    await settle();
    expect(stop).not.toHaveBeenCalled();
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
    it("closes the client, names its engine and its handshake, and does not connect again while suspended", async () => {
      const first = fakeClient("engine-1");
      const second = fakeClient("engine-2");
      const connect = vi.fn<Connect>().mockResolvedValueOnce(ok(first.client)).mockResolvedValueOnce(ok(second.client));
      const { watcher, states } = watch(connect);
      await settle();
      expect(await watcher.suspend()).toEqual({ engineId: "engine-1", engine: { apiVersion: APP_API } });
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
