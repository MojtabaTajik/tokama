import type { ClientEvent, ConnectError, EngineClient } from "@tokama/client";
import { err, ok, type Result } from "@tokama/core";
import { describe, expect, it, vi } from "vitest";
import type { BridgeEvent, ConnectionState } from "../shared/bridge.js";
import { watchConnection } from "./connection.js";

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

function watch(connect: () => Promise<Result<EngineClient, ConnectError>>, logTail: string[] = []) {
  const states: ConnectionState[] = [];
  const events: BridgeEvent[] = [];
  const readLogTail = vi.fn(() => logTail);
  const watcher = watchConnection({
    connect,
    logPath: "/run/tokama/engine.log",
    readLogTail,
    onState: (s) => states.push(s),
    onEvent: (e) => events.push(e),
  });
  return { watcher, states, events, readLogTail };
}

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
});
