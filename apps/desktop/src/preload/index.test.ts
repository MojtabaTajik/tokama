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
const [, pushOpenItem] = electron.on.mock.calls.find(([channel]) => channel === CHANNELS.openItem) as [string, (event: unknown, itemId: unknown) => void];

describe("preload bridge", () => {
  it("exposes window.tokama with only the bridge methods", () => {
    expect(exposed).toEqual([["tokama", bridge]]);
    expect(Object.keys(bridge).sort()).toEqual(["command", "copyBuildInfo", "getAboutInfo", "getConnection", "getDesktopState", "onConnection", "onEvent", "onOpenItem", "openTemplateFile", "pickFolder", "query", "reportError", "retryConnection", "saveLayout", "saveNotifications", "setViewedItem", "showDataFolder"].sort());
  });

  it("query and command invoke their channels with the request only", async () => {
    electron.invoke.mockResolvedValue({ ok: true, data: { items: [] } });
    await expect(bridge.query({ type: "setup" })).resolves.toEqual({ ok: true, data: { items: [] } });
    expect(electron.invoke).toHaveBeenCalledWith(CHANNELS.query, { type: "setup" });
    electron.invoke.mockResolvedValue({ ok: true, data: null });
    await bridge.command({ type: "stop_item", itemId: "item_x" });
    expect(electron.invoke).toHaveBeenLastCalledWith(CHANNELS.command, { type: "stop_item", itemId: "item_x" });
  });

  it("onEvent passes the event without the IPC event, and unsubscribes", () => {
    const listener = vi.fn();
    const stop = bridge.onEvent(listener);
    const [channel, handler] = electron.on.mock.calls[0] as [string, (event: unknown, message: unknown) => void];
    expect(channel).toBe(CHANNELS.event);
    const message = { kind: "event", seq: 3, event: { type: "item_updated" } };
    handler({ sender: "ipc" }, message);
    expect(listener.mock.calls).toEqual([[message]]);
    stop();
    expect(electron.removeListener).toHaveBeenCalledWith(CHANNELS.event, handler);
  });

  it("openTemplateFile sends the origin and file only", async () => {
    electron.invoke.mockResolvedValue({ ok: true });
    const name = { origin: "orders-api", file: ".tokama/templates/plan.yaml", path: "/bin/sh" } as { origin: string; file: string };
    await expect(bridge.openTemplateFile(name)).resolves.toEqual({ ok: true });
    expect(electron.invoke).toHaveBeenCalledWith(CHANNELS.openTemplateFile, { origin: "orders-api", file: ".tokama/templates/plan.yaml" });
  });

  it("reportError sends the message and stack only, as strings", async () => {
    electron.invoke.mockResolvedValue(undefined);
    const error = { message: "x is undefined", stack: "TypeError: x is undefined", source: "engine", where: "startup" } as { message: string; stack: string };
    await bridge.reportError(error);
    expect(electron.invoke).toHaveBeenCalledWith(CHANNELS.reportError, { message: "x is undefined", stack: "TypeError: x is undefined" });
  });

  it("pickFolder invokes its channel with no arguments", async () => {
    electron.invoke.mockResolvedValue("/home/dev/code/orders-api");
    await expect(bridge.pickFolder()).resolves.toBe("/home/dev/code/orders-api");
    expect(electron.invoke).toHaveBeenCalledWith(CHANNELS.pickFolder);
  });

  it("the About calls invoke their channels with no arguments", async () => {
    electron.invoke.mockResolvedValue({ ok: true });
    await bridge.getAboutInfo();
    await bridge.copyBuildInfo();
    await bridge.showDataFolder();
    expect(electron.invoke.mock.calls).toEqual([[CHANNELS.getAboutInfo], [CHANNELS.copyBuildInfo], [CHANNELS.showDataFolder]]);
  });

  it("getDesktopState and saveLayout use their own channels, and saveLayout sends the patch as given", async () => {
    electron.invoke.mockResolvedValue(undefined);
    await bridge.getDesktopState();
    await bridge.saveLayout({ drawer: { width: 500 } });
    expect(electron.invoke.mock.calls).toEqual([[CHANNELS.getDesktopState], [CHANNELS.saveLayout, { drawer: { width: 500 } }]]);
  });

  it("getConnection invokes the connection channel", async () => {
    electron.invoke.mockResolvedValue({ status: "starting" });
    await expect(bridge.getConnection()).resolves.toEqual({ status: "starting" });
    expect(electron.invoke).toHaveBeenCalledWith(CHANNELS.getConnection);
  });

  it("retryConnection invokes the retry channel with no argument", async () => {
    electron.invoke.mockResolvedValue(undefined);
    await bridge.retryConnection();
    expect(electron.invoke).toHaveBeenCalledWith(CHANNELS.retryConnection);
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

  it("saveNotifications and setViewedItem use their own channels", async () => {
    electron.invoke.mockResolvedValue(undefined);
    await bridge.saveNotifications({ sound: true });
    await bridge.setViewedItem("item_1");
    await bridge.setViewedItem(undefined);
    expect(electron.invoke.mock.calls).toEqual([[CHANNELS.saveNotifications, { sound: true }], [CHANNELS.viewedItem, "item_1"], [CHANNELS.viewedItem, undefined]]);
  });

  it("onOpenItem passes the item id without the IPC event, and keeps one that came before a listener", () => {
    pushOpenItem({ sender: "ipc" }, "item_early");
    pushOpenItem({ sender: "ipc" }, 5);
    const listener = vi.fn();
    const stop = bridge.onOpenItem(listener);
    expect(listener.mock.calls).toEqual([["item_early"]]);
    pushOpenItem({ sender: "ipc" }, "item_live");
    expect(listener.mock.calls).toEqual([["item_early"], ["item_live"]]);
    stop();
    pushOpenItem({ sender: "ipc" }, "item_late");
    const next = vi.fn();
    bridge.onOpenItem(next)();
    expect(next.mock.calls).toEqual([["item_late"]]);
  });
});
