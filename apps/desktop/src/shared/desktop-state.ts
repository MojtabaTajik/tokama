// What the desktop app remembers on this machine: the window, the panel widths and a few view
// choices. The main process keeps it in `~/.tokama/desktop.json`; the renderer gets it at start
// and sends back changes to its own part. Pure: no files, no Electron. Reading is forgiving, so
// a file from an older version, a hand edit or a broken write never stops the app: every field
// that is not valid falls back to its default.

/** Panel widths in px: where an edge may go, and where a double-click resets it. */
export const SIDEBAR_WIDTH = { min: 200, max: 360, default: 264 } as const;
export const DRAWER_WIDTH = { min: 340, max: 640, default: 420 } as const;
/** The icon rail never resizes. */
export const RAIL_WIDTH = 60;
/** The main area never gets narrower than this: the drawer gives way first, then the sidebar, then the drawer floats. */
export const MAIN_MIN_WIDTH = 420;

export const SECTIONS = ["workflows", "repos"] as const;
export type SectionName = (typeof SECTIONS)[number];
export const STATUS_FILTERS = ["active", "needs", "done", "failed", "all"] as const;
export const RANGES = ["today", "7d", "30d"] as const;

export type LastView = { readonly kind: "all" } | { readonly kind: "workflow" | "repo"; readonly id: string };
export interface LastFilter {
  readonly status: (typeof STATUS_FILTERS)[number];
  readonly range: (typeof RANGES)[number];
}

export interface WindowBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DesktopState {
  readonly window: {
    /** The window's normal (not maximized) bounds; absent until the window has been placed once. */
    readonly bounds?: WindowBounds;
    readonly maximized: boolean;
    readonly fullscreen: boolean;
  };
  readonly sidebar: { readonly width: number; readonly collapsed: boolean };
  readonly drawer: { readonly width: number };
  readonly collapsedSections: readonly SectionName[];
  readonly lastView: LastView;
  /** The status filter and range of `lastView`. */
  readonly lastFilter: LastFilter;
  /** The repo folder chosen last in the Add repo picker. */
  readonly lastRepoFolder?: string;
}

/** What the renderer may change; the window and the repo folder belong to the main process. */
export type LayoutPatch = Partial<Pick<DesktopState, "sidebar" | "drawer" | "collapsedSections" | "lastView" | "lastFilter">>;

export const DEFAULT_DESKTOP_STATE: DesktopState = {
  window: { maximized: false, fullscreen: false },
  sidebar: { width: SIDEBAR_WIDTH.default, collapsed: false },
  drawer: { width: DRAWER_WIDTH.default },
  collapsedSections: [],
  lastView: { kind: "all" },
  lastFilter: { status: "active", range: "today" },
};

type Limits = { readonly min: number; readonly max: number };

/** `width` rounded and held inside `limits`. */
export const clampWidth = (width: number, limits: Limits): number => Math.min(limits.max, Math.max(limits.min, Math.round(width)));

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined => list.find((entry) => entry === value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const MAX_TEXT = 512;

function width(value: unknown, limits: Limits & { readonly default: number }): number {
  return finite(value) ? clampWidth(value, limits) : limits.default;
}

function bounds(value: unknown): WindowBounds | undefined {
  if (!isRecord(value)) return undefined;
  const { x, y, width: w, height: h } = value;
  if (!finite(x) || !finite(y) || !finite(w) || !finite(h) || w < 1 || h < 1) return undefined;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) };
}

function lastView(value: unknown): LastView {
  if (!isRecord(value)) return DEFAULT_DESKTOP_STATE.lastView;
  if (value["kind"] === "workflow" || value["kind"] === "repo") {
    const id = value["id"];
    if (typeof id === "string" && id !== "" && id.length <= MAX_TEXT) return { kind: value["kind"], id };
  }
  return DEFAULT_DESKTOP_STATE.lastView;
}

function lastFilter(value: unknown): LastFilter {
  const record = isRecord(value) ? value : {};
  return {
    status: oneOf(STATUS_FILTERS, record["status"]) ?? DEFAULT_DESKTOP_STATE.lastFilter.status,
    range: oneOf(RANGES, record["range"]) ?? DEFAULT_DESKTOP_STATE.lastFilter.range,
  };
}

/** The state in `input` (a parsed file or a renderer message), with every invalid field replaced by its default. */
export function parseDesktopState(input: unknown): DesktopState {
  const root = isRecord(input) ? input : {};
  const win = isRecord(root["window"]) ? root["window"] : {};
  const sidebar = isRecord(root["sidebar"]) ? root["sidebar"] : {};
  const drawer = isRecord(root["drawer"]) ? root["drawer"] : {};
  const sections = Array.isArray(root["collapsedSections"]) ? root["collapsedSections"] : [];
  const placed = bounds(win["bounds"]);
  const folder = root["lastRepoFolder"];
  return {
    window: { ...(placed === undefined ? {} : { bounds: placed }), maximized: win["maximized"] === true, fullscreen: win["fullscreen"] === true },
    sidebar: { width: width(sidebar["width"], SIDEBAR_WIDTH), collapsed: sidebar["collapsed"] === true },
    drawer: { width: width(drawer["width"], DRAWER_WIDTH) },
    collapsedSections: SECTIONS.filter((name) => sections.includes(name)),
    lastView: lastView(root["lastView"]),
    lastFilter: lastFilter(root["lastFilter"]),
    ...(typeof folder === "string" && folder !== "" && folder.length <= MAX_TEXT ? { lastRepoFolder: folder } : {}),
  };
}

/** `state` with the parts of `patch` that are valid; anything else in the patch is ignored. */
export function applyLayoutPatch(state: DesktopState, patch: unknown): DesktopState {
  if (!isRecord(patch)) return state;
  const merged = parseDesktopState({ ...state, ...Object.fromEntries(["sidebar", "drawer", "collapsedSections", "lastView", "lastFilter"].filter((key) => key in patch).map((key) => [key, patch[key]])) });
  return { ...state, sidebar: merged.sidebar, drawer: merged.drawer, collapsedSections: merged.collapsedSections, lastView: merged.lastView, lastFilter: merged.lastFilter };
}
