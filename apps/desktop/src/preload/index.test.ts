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
    expect(Object.keys(bridge).sort()).toEqual(["command", "copyBuildInfo", "countUsage", "getAboutInfo", "getConnection", "getDesktopState", "getToolsPath", "onConnection", "onEvent", "onOpenItem", "openAttemptFile", "openTemplateFile", "pickFolder", "query", "reportError", "restartEngine", "retryConnection", "waitForEngine", "saveLayout", "saveNotifications", "playSound", "setViewedItem", "showDataFolder", "loadDiagnostics", "sendDiagnostics", "saveDiagnostics", "stopCrashPrompt", "getWhatsNew", "closeWhatsNew", "getUpdate", "onUpdate", "checkForUpdates", "installUpdate", "openUpdateNotes"].sort());
  });

  it("the release notes calls: one without arguments, and a close that sends only two strings", async () => {
    electron.invoke.mockResolvedValue(undefined);
    await bridge.getWhatsNew();
    expect(electron.invoke).toHaveBeenLastCalledWith(CHANNELS.getWhatsNew);
    await bridge.closeWhatsNew("0.2.0", "card");
    expect(electron.invoke).toHaveBeenLastCalledWith(CHANNELS.closeWhatsNew, "0.2.0", "card");
    await bridge.closeWhatsNew({ evil: true } as unknown as string, 5 as unknown as "chip");
    expect(electron.invoke).toHaveBeenLastCalledWith(CHANNELS.closeWhatsNew, "[object Object]", "5");
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

  it("openAttemptFile sends the item, step, attempt and file only", async () => {
    electron.invoke.mockResolvedValue({ ok: true });
    const name = { itemId: "item_x", stepIndex: 1, attempt: 2, file: 1, path: "/bin/sh" } as { itemId: string; stepIndex: number; attempt: number; file: number };
    await expect(bridge.openAttemptFile(name)).resolves.toEqual({ ok: true });
    expect(electron.invoke).toHaveBeenCalledWith(CHANNELS.openAttemptFile, { itemId: "item_x", stepIndex: 1, attempt: 2, file: 1 });
  });

  it("reportError sends the message and stack only, as strings", async () => {
    electron.invoke.mockResolvedValue(undefined);
    const error = { message: "x is undefined", stack: "TypeError: x is undefined", source: "engine", where: "startup" } as { message: string; stack: string };
    await bridge.reportError(error);
    expect(electron.invoke).toHaveBeenCalledWith(CHANNELS.reportError, { message: "x is undefined", stack: "TypeError: x is undefined" });
  });

  it("countUsage sends the action name only, as a string", async () => {
    electron.invoke.mockResolvedValue(undefined);
    await bridge.countUsage("expand_view");
    expect(electron.invoke).toHaveBeenLastCalledWith(CHANNELS.countUsage, "expand_view");
    await bridge.countUsage({ toString: () => "expand_view", extra: 1 } as never);
    expect(electron.invoke).toHaveBeenLastCalledWith(CHANNELS.countUsage, "expand_view");
  });

  it("the diagnostics calls pass a list of strings only: never a URL, text or other fields", async () => {
    electron.invoke.mockResolvedValue({ ok: true, sent: 1 });
    const ids = Object.assign(["diag_a", 5], { url: "https://evil.example" }) as unknown as string[];
    await bridge.sendDiagnostics(ids);
    expect(electron.invoke).toHaveBeenLastCalledWith(CHANNELS.sendDiagnostics, ["diag_a", "5"]);
    await bridge.saveDiagnostics(ids);
    expect(electron.invoke).toHaveBeenLastCalledWith(CHANNELS.saveDiagnostics, ["diag_a", "5"]);
    await bridge.loadDiagnostics();
    expect(electron.invoke).toHaveBeenLastCalledWith(CHANNELS.loadDiagnostics);
    await bridge.stopCrashPrompt();
    expect(electron.invoke).toHaveBeenLastCalledWith(CHANNELS.stopCrashPrompt);
  });

  it("the update calls send no argument, and onUpdate follows the pushed channel", async () => {
    await bridge.getUpdate();
    expect(electron.invoke).toHaveBeenLastCalledWith(CHANNELS.getUpdate);
    await bridge.checkForUpdates();
    expect(electron.invoke).toHaveBeenLastCalledWith(CHANNELS.checkForUpdates);
    await bridge.installUpdate();
    expect(electron.invoke).toHaveBeenLastCalledWith(CHANNELS.installUpdate);
    await bridge.openUpdateNotes();
    expect(electron.invoke).toHaveBeenLastCalledWith(CHANNELS.openUpdateNotes);
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

  it("getToolsPath invokes its channel with no arguments", async () => {
    electron.invoke.mockResolvedValue({ source: "inherited" });
    await expect(bridge.getToolsPath()).resolves.toEqual({ source: "inherited" });
    expect(electron.invoke).toHaveBeenLastCalledWith(CHANNELS.getToolsPath);
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

  it("restartEngine and waitForEngine invoke their channels with no argument", async () => {
    electron.invoke.mockResolvedValue(undefined);
    await bridge.restartEngine();
    expect(electron.invoke).toHaveBeenCalledWith(CHANNELS.restartEngine);
    await bridge.waitForEngine();
    expect(electron.invoke).toHaveBeenCalledWith(CHANNELS.waitForEngine);
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
    await bridge.saveNotifications({ finished: "off" });
    await bridge.setViewedItem("item_1");
    await bridge.setViewedItem(undefined);
    expect(electron.invoke.mock.calls).toEqual([[CHANNELS.saveNotifications, { finished: "off" }], [CHANNELS.viewedItem, "item_1"], [CHANNELS.viewedItem, undefined]]);
  });

  it("playSound sends only the two names, as strings", async () => {
    electron.invoke.mockResolvedValue(undefined);
    await bridge.playSound("tokayCall", "tokama");
    await bridge.playSound({ evil: true } as never, 5 as never);
    expect(electron.invoke.mock.calls).toEqual([[CHANNELS.playSound, "tokayCall", "tokama"], [CHANNELS.playSound, "[object Object]", "5"]]);
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
