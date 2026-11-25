// The window's place on screen, remembered between runs. `fitBounds` turns the saved bounds into
// bounds that are visible on a display that exists now (the monitors may have changed since);
// `trackWindow` keeps the store current while the user moves, resizes, maximizes or full-screens.
import type { DesktopState, WindowBounds } from "../shared/desktop-state.js";
import type { DesktopStore } from "./desktop-store.js";

export interface Area {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Placement {
  readonly width: number;
  readonly height: number;
  /** Absent: the system centres the window. */
  readonly x?: number;
  readonly y?: number;
}

export interface Sizes {
  readonly width: number;
  readonly height: number;
  readonly minWidth: number;
  readonly minHeight: number;
}

/** At least this much of the window must lie on a display, or it counts as off screen (the title bar stays reachable). */
const MIN_VISIBLE = { width: 120, height: 60 };

const overlap = (a: Area, b: Area): { width: number; height: number } => ({
  width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
  height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
});
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/**
 * Where to open the window. With no saved bounds, or none that reach a display, it gets its
 * default size, centred on the primary display. Otherwise it keeps its saved size (never above a
 * display's work area, never under the minimum) and is moved fully onto the display that shows
 * most of it.
 */
export function fitBounds(saved: WindowBounds | undefined, displays: readonly Area[], primary: Area, sizes: Sizes): Placement {
  const fallback = (): Placement => ({ width: Math.min(sizes.width, primary.width), height: Math.min(sizes.height, primary.height) });
  if (saved === undefined) return fallback();
  let best: Area | undefined;
  let bestArea = 0;
  for (const display of displays) {
    const shared = overlap(saved, display);
    if (shared.width < MIN_VISIBLE.width || shared.height < MIN_VISIBLE.height) continue;
    if (shared.width * shared.height > bestArea) {
      best = display;
      bestArea = shared.width * shared.height;
    }
  }
  if (best === undefined) return fallback();
  const width = clamp(saved.width, sizes.minWidth, best.width);
  const height = clamp(saved.height, sizes.minHeight, best.height);
  return { width, height, x: clamp(saved.x, best.x, best.x + best.width - width), y: clamp(saved.y, best.y, best.y + best.height - height) };
}

/** The part of Electron's BrowserWindow that `trackWindow` uses. */
export interface TrackedWindow {
  on(event: "resize" | "move" | "maximize" | "unmaximize" | "enter-full-screen" | "leave-full-screen" | "close", listener: () => void): unknown;
  getNormalBounds(): WindowBounds;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  isMinimized(): boolean;
}

/** Keeps `store` in step with the window. Bounds are the window's normal ones, so a maximized window comes back to its old size when restored. */
export function trackWindow(window: TrackedWindow, store: DesktopStore): void {
  const record = () => {
    if (window.isMinimized()) return;
    const { x, y, width, height } = window.getNormalBounds();
    const maximized = window.isMaximized();
    const fullscreen = window.isFullScreen();
    store.update((state): DesktopState => ({ ...state, window: { bounds: { x, y, width, height }, maximized, fullscreen } }));
  };
  for (const event of ["resize", "move", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"] as const) window.on(event, record);
  window.on("close", () => {
    record();
    store.flush();
  });
}
