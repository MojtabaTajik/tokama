// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState, TokamaBridge } from "../shared/bridge.js";
import { App } from "./App.js";
import { brand } from "./brand/index.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakeBridge(initial: ConnectionState) {
  let listener: ((state: ConnectionState) => void) | undefined;
  const stop = vi.fn();
  const bridge: TokamaBridge = {
    getConnection: vi.fn(async () => initial),
    onConnection: vi.fn((next) => {
      listener = next;
      return stop;
    }),
  };
  const emit = (state: ConnectionState) => act(() => listener?.(state));
  return { bridge, emit, stop };
}

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = async (bridge: TokamaBridge) => {
  await act(async () => root.render(<App bridge={bridge} />));
};
const status = () => container.querySelector(".status");

describe("App connection screen", () => {
  it("shows the brand mark and wordmark from the brand folder", async () => {
    await render(fakeBridge({ status: "starting" }).bridge);
    const sources = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(sources).toEqual([brand.markUrl, brand.wordmarkUrl]);
    expect(container.querySelector('img[alt="Tokama"]')).not.toBeNull();
  });

  it.each([
    [{ status: "starting" }, "◌", "Starting the engine"],
    [{ status: "connected", engineId: "e-42" }, "●", "Connected to the engine"],
    [{ status: "reconnecting" }, "◐", "Reconnecting to the engine"],
  ] as const)("shows %j with a symbol and a word", async (state, symbol, text) => {
    await render(fakeBridge(state).bridge);
    expect(status()?.getAttribute("data-status")).toBe(state.status);
    expect(status()?.textContent).toBe(`${symbol}${text}`);
  });

  it("shows the engine id when connected", async () => {
    await render(fakeBridge({ status: "connected", engineId: "e-42" }).bridge);
    expect(container.querySelector(".detail .mono")?.textContent).toBe("e-42");
  });

  it("shows the reason, the log path and the log tail when failed, as text", async () => {
    const state: ConnectionState = {
      status: "failed",
      reason: "the engine exited with code 1 <img src=x onerror=alert(1)>",
      logPath: "/home/a/.tokama/run/engine.log",
      logTail: ["Error: Cannot find module", "  at main.js:1"],
    };
    await render(fakeBridge(state).bridge);
    expect(status()?.textContent).toBe("✕The engine is not available");
    expect(container.textContent).toContain(state.reason);
    expect(container.textContent).toContain(state.logPath);
    expect(container.querySelector("pre")?.textContent).toBe("Error: Cannot find module\n  at main.js:1");
    expect(container.querySelectorAll("img")).toHaveLength(2);
  });

  it("leaves out the log block when the tail is empty", async () => {
    await render(fakeBridge({ status: "failed", reason: "timeout", logPath: "/l/engine.log", logTail: [] }).bridge);
    expect(container.querySelector("pre")).toBeNull();
  });

  it("follows pushed changes and unsubscribes on unmount", async () => {
    const { bridge, emit, stop } = fakeBridge({ status: "connected", engineId: "e-1" });
    await render(bridge);
    emit({ status: "reconnecting" });
    expect(status()?.getAttribute("data-status")).toBe("reconnecting");
    emit({ status: "connected", engineId: "e-2" });
    expect(container.querySelector(".detail .mono")?.textContent).toBe("e-2");
    act(() => root.unmount());
    expect(stop).toHaveBeenCalledOnce();
    root = createRoot(container);
  });
});
