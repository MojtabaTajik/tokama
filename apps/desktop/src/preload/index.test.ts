import { describe, expect, it, vi } from "vitest";
import { CHANNELS, type ConnectionState } from "../shared/bridge.js";

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, removeListener: electron.removeListener },
}));

const { bridge } = await import("./index.js");
// Vitest clears mock calls before each test, so the call made at import time is kept here.
const exposed = [...electron.exposeInMainWorld.mock.calls];

describe("preload bridge", () => {
  it("exposes window.tokama with only getConnection and onConnection", () => {
    expect(exposed).toEqual([["tokama", bridge]]);
    expect(Object.keys(bridge).sort()).toEqual(["getConnection", "onConnection"]);
  });

  it("getConnection invokes the connection channel", async () => {
    electron.invoke.mockResolvedValue({ status: "starting" });
    await expect(bridge.getConnection()).resolves.toEqual({ status: "starting" });
    expect(electron.invoke).toHaveBeenCalledWith(CHANNELS.getConnection);
  });

  it("onConnection passes the state without the IPC event, and unsubscribes", () => {
    const listener = vi.fn();
    const stop = bridge.onConnection(listener);
    const [channel, handler] = electron.on.mock.calls[0] as [string, (event: unknown, state: ConnectionState) => void];
    expect(channel).toBe(CHANNELS.connectionChanged);
    handler({ sender: "ipc" }, { status: "reconnecting" });
    expect(listener).toHaveBeenCalledWith({ status: "reconnecting" });
    expect(listener.mock.calls[0]).toHaveLength(1);
    stop();
    expect(electron.removeListener).toHaveBeenCalledWith(CHANNELS.connectionChanged, handler);
  });
});
