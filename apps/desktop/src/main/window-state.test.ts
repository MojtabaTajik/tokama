import { describe, expect, it, vi } from "vitest";
import { DEFAULT_DESKTOP_STATE, type DesktopState } from "../shared/desktop-state.js";
import type { DesktopStore } from "./desktop-store.js";
import { type Area, fitBounds, trackWindow, type TrackedWindow } from "./window-state.js";

const main: Area = { x: 0, y: 25, width: 1440, height: 875 };
const side: Area = { x: 1440, y: 0, width: 1920, height: 1080 };
const left: Area = { x: -1280, y: 100, width: 1280, height: 720 };
const sizes = { width: 1200, height: 800, minWidth: 720, minHeight: 480 };

describe("fitBounds", () => {
  it("opens at the default size, centred, with nothing saved", () => {
    expect(fitBounds(undefined, [main], main, sizes)).toEqual({ width: 1200, height: 800 });
  });

  it("keeps saved bounds that are fully on a display", () => {
    expect(fitBounds({ x: 100, y: 80, width: 1000, height: 700 }, [main, side], main, sizes)).toEqual({ x: 100, y: 80, width: 1000, height: 700 });
  });

  it("keeps a window on a second display where it was", () => {
    expect(fitBounds({ x: 1600, y: 100, width: 1200, height: 800 }, [main, side], main, sizes)).toEqual({ x: 1600, y: 100, width: 1200, height: 800 });
  });

  it("moves a window fully onto the display that shows most of it", () => {
    // 440 px of it are on the main display, 360 px on the second.
    const placed = fitBounds({ x: 1000, y: 100, width: 800, height: 500 }, [main, side], main, sizes);
    expect(placed).toEqual({ x: 640, y: 100, width: 800, height: 500 });
  });

  it("centres a window on the primary display when its display is gone", () => {
    expect(fitBounds({ x: 3000, y: 200, width: 1000, height: 700 }, [main], main, sizes)).toEqual({ width: 1200, height: 800 });
  });

  it("treats a window with only a sliver on screen as off screen", () => {
    expect(fitBounds({ x: 1400, y: 100, width: 1000, height: 700 }, [main], main, sizes)).toEqual({ width: 1200, height: 800 });
  });

  it("shrinks a window that is larger than the display, and not under the minimum size", () => {
    expect(fitBounds({ x: 0, y: 25, width: 3000, height: 2000 }, [main], main, sizes)).toEqual({ x: 0, y: 25, width: 1440, height: 875 });
    expect(fitBounds({ x: 10, y: 30, width: 130, height: 130 }, [main], main, sizes)).toEqual({ x: 10, y: 30, width: 720, height: 480 });
  });

  it("also keeps a window on a display at negative coordinates", () => {
    expect(fitBounds({ x: -1200, y: 150, width: 1000, height: 600 }, [main, left], main, sizes)).toEqual({ x: -1200, y: 150, width: 1000, height: 600 });
  });

  it("never gives a size above the primary display for the default", () => {
    expect(fitBounds(undefined, [{ x: 0, y: 0, width: 1024, height: 700 }], { x: 0, y: 0, width: 1024, height: 700 }, sizes)).toEqual({ width: 1024, height: 700 });
  });
});

describe("trackWindow", () => {
  function fakeWindow(overrides: Partial<TrackedWindow> = {}) {
    const listeners = new Map<string, () => void>();
    const window: TrackedWindow = {
      on: (event, listener) => void listeners.set(event, listener),
      getNormalBounds: () => ({ x: 10, y: 20, width: 900, height: 600 }),
      isMaximized: () => false,
      isFullScreen: () => false,
      isMinimized: () => false,
      ...overrides,
    };
    return { window, fire: (event: string) => listeners.get(event)?.() };
  }
  function fakeStore() {
    let state: DesktopState = DEFAULT_DESKTOP_STATE;
    const store: DesktopStore = { get: () => state, update: (change) => void (state = change(state)), flush: vi.fn() };
    return { store, state: () => state };
  }

  it("records the normal bounds and flags on resize, move, maximize and full screen", () => {
    const { window, fire } = fakeWindow({ isMaximized: () => true });
    const { store, state } = fakeStore();
    trackWindow(window, store);
    for (const event of ["resize", "move", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"]) {
      fire(event);
      expect(state().window).toEqual({ bounds: { x: 10, y: 20, width: 900, height: 600 }, maximized: true, fullscreen: false });
    }
  });

  it("records full screen", () => {
    const { window, fire } = fakeWindow({ isFullScreen: () => true });
    const { store, state } = fakeStore();
    trackWindow(window, store);
    fire("enter-full-screen");
    expect(state().window.fullscreen).toBe(true);
  });

  it("ignores a minimized window", () => {
    const { window, fire } = fakeWindow({ isMinimized: () => true });
    const { store, state } = fakeStore();
    trackWindow(window, store);
    fire("resize");
    expect(state()).toEqual(DEFAULT_DESKTOP_STATE);
  });

  it("writes at once when the window closes", () => {
    const { window, fire } = fakeWindow();
    const { store, state } = fakeStore();
    trackWindow(window, store);
    fire("close");
    expect(state().window.bounds).toEqual({ x: 10, y: 20, width: 900, height: 600 });
    expect(store.flush).toHaveBeenCalledOnce();
  });
});
