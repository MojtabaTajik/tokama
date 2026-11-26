// What the desktop app remembers on this machine: the window, the panel widths and a few view
// choices. The main process keeps it in `~/.tokama/desktop.json`; the renderer gets it at start
// and sends back changes to its own part. Pure: no files, no Electron. Reading is forgiving, so
// a file from an older version, a hand edit or a broken write never stops the app: every field
// that is not valid falls back to its default.
import { isVersion } from "./whats-new.js";

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
export const RANGES = ["today", "7d", "30d", "all"] as const;

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

/** How one kind of notification reaches the user: a banner with a sound, a banner alone, a sound alone, or nothing. */
export const NOTE_MODES = ["both", "banner", "sound", "off"] as const;
export type NoteMode = (typeof NOTE_MODES)[number];
/** Which sounds play: the ones Tokama ships, or the system's default. */
export const SOUND_SETS = ["tokama", "macos"] as const;
export type SoundSet = (typeof SOUND_SETS)[number];
export const NOTE_KINDS = ["needsYou", "finished", "failed"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
/** The sounds the app can play: one per kind of notification, and the call of the Tokay in About. */
export const SOUND_NAMES = ["needsYou", "finished", "failed", "tokayCall"] as const;
export type SoundName = (typeof SOUND_NAMES)[number];

/** How each kind of desktop notification reaches the user, and which sounds play. */
export interface NotificationSettings {
  readonly needsYou: NoteMode;
  readonly finished: NoteMode;
  readonly failed: NoteMode;
  readonly sounds: SoundSet;
}

/** The release notes still to show, each by the version of its note: the card (a release with highlights) and the "Updated to" chip (fixes only, or security). Set when the app starts after an update; cleared when the user closes the card or the chip first shows. */
export interface WhatsNewDue {
  readonly card?: string;
  readonly chip?: string;
}

/** Where the "Get started" checklist stands on this machine. */
export interface GetStartedState {
  /** The first item has started (or the user had items already): the checklist no longer takes the place of the empty board. */
  readonly done: boolean;
  /** The "Setup done" line was closed (or never shows, for a user who had items already). */
  readonly lineClosed: boolean;
  /** The first item the user started; the line stays until it ends, and its text shows in step 4. */
  readonly firstItemId?: string;
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
  readonly getStarted: GetStartedState;
  /** The repo folder chosen last in the Add repo picker. */
  readonly lastRepoFolder?: string;
  readonly notifications: NotificationSettings;
  /** True once a banner has told the user where to change how Tokama notifies them; the main process sets it. */
  readonly notificationHintShown: boolean;
  /** After a crash, the next start asks to send a report; false after "Don't ask again". */
  readonly askAfterCrash: boolean;
  /** The newest version of the app that has run; the main process sets it at each start. Absent in a file an older version wrote. */
  readonly lastRunVersion?: string;
  /** The release notes not yet shown; the main process owns it. */
  readonly whatsNewDue?: WhatsNewDue;
}

/** What the renderer may change; the window, the repo folder, the crash prompt and the release notes shown belong to the main process. */
export type LayoutPatch = Partial<Pick<DesktopState, "sidebar" | "drawer" | "collapsedSections" | "lastView" | "lastFilter" | "getStarted">>;
/** The keys of a layout patch the main process accepts. */
const LAYOUT_KEYS = ["sidebar", "drawer", "collapsedSections", "lastView", "lastFilter", "getStarted"] as const;

export const DEFAULT_DESKTOP_STATE: DesktopState = {
  window: { maximized: false, fullscreen: false },
  sidebar: { width: SIDEBAR_WIDTH.default, collapsed: false },
  drawer: { width: DRAWER_WIDTH.default },
  collapsedSections: [],
  lastView: { kind: "all" },
  lastFilter: { status: "active", range: "today" },
  getStarted: { done: false, lineClosed: false },
  notifications: { needsYou: "both", finished: "banner", failed: "both", sounds: "tokama" },
  notificationHintShown: false,
  askAfterCrash: true,
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

function getStarted(value: unknown): GetStartedState {
  const record = isRecord(value) ? value : {};
  const first = record["firstItemId"];
  return {
    done: record["done"] === true,
    lineClosed: record["lineClosed"] === true,
    ...(typeof first === "string" && first !== "" && first.length <= MAX_TEXT ? { firstItemId: first } : {}),
  };
}

/**
 * The notification settings in `value`. A kind saved as a mode is kept. A kind saved by an older
 * version as on or off becomes a mode: on with the one Sound switch on is Banner + sound, on
 * without it is Banner only, off is Off. Anything else falls back to the default of that field.
 */
function notifications(value: unknown): NotificationSettings {
  const record = isRecord(value) ? value : {};
  const defaults = DEFAULT_DESKTOP_STATE.notifications;
  const mode = (kind: NoteKind): NoteMode => {
    const saved = record[kind];
    if (typeof saved === "boolean") return !saved ? "off" : record["sound"] === true ? "both" : "banner";
    return oneOf(NOTE_MODES, saved) ?? defaults[kind];
  };
  return { needsYou: mode("needsYou"), finished: mode("finished"), failed: mode("failed"), sounds: oneOf(SOUND_SETS, record["sounds"]) ?? defaults.sounds };
}

/** Whether the notification hint counts as seen: as saved, or true for a file an older version wrote (a user who has used the app). */
function hintShown(root: Record<string, unknown>): boolean {
  if (typeof root["notificationHintShown"] === "boolean") return root["notificationHintShown"];
  const old = root["notifications"];
  return isRecord(old) && NOTE_KINDS.some((kind) => typeof old[kind] === "boolean");
}

/** The due versions in `value` that are valid; undefined when none is. */
function whatsNewDue(value: unknown): WhatsNewDue | undefined {
  if (!isRecord(value)) return undefined;
  const { card, chip } = value;
  if (!isVersion(card) && !isVersion(chip)) return undefined;
  return { ...(isVersion(card) ? { card } : {}), ...(isVersion(chip) ? { chip } : {}) };
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
  const lastRun = root["lastRunVersion"];
  const due = whatsNewDue(root["whatsNewDue"]);
  return {
    window: { ...(placed === undefined ? {} : { bounds: placed }), maximized: win["maximized"] === true, fullscreen: win["fullscreen"] === true },
    sidebar: { width: width(sidebar["width"], SIDEBAR_WIDTH), collapsed: sidebar["collapsed"] === true },
    drawer: { width: width(drawer["width"], DRAWER_WIDTH) },
    collapsedSections: SECTIONS.filter((name) => sections.includes(name)),
    lastView: lastView(root["lastView"]),
    lastFilter: lastFilter(root["lastFilter"]),
    getStarted: getStarted(root["getStarted"]),
    notifications: notifications(root["notifications"]),
    notificationHintShown: hintShown(root),
    ...(typeof folder === "string" && folder !== "" && folder.length <= MAX_TEXT ? { lastRepoFolder: folder } : {}),
    askAfterCrash: root["askAfterCrash"] !== false,
    ...(isVersion(lastRun) ? { lastRunVersion: lastRun } : {}),
    ...(due === undefined ? {} : { whatsNewDue: due }),
  };
}

/** `state` with the parts of `patch` that are valid; anything else in the patch is ignored. */
export function applyLayoutPatch(state: DesktopState, patch: unknown): DesktopState {
  if (!isRecord(patch)) return state;
  const merged = parseDesktopState({ ...state, ...Object.fromEntries(LAYOUT_KEYS.filter((key) => key in patch).map((key) => [key, patch[key]])) });
  return { ...state, sidebar: merged.sidebar, drawer: merged.drawer, collapsedSections: merged.collapsedSections, lastView: merged.lastView, lastFilter: merged.lastFilter, getStarted: merged.getStarted };
}

/** `state` with the modes and sound set of `patch` that are valid; any other field or value is ignored. */
export function applyNotificationsPatch(state: DesktopState, patch: unknown): DesktopState {
  if (!isRecord(patch)) return state;
  const modes = NOTE_KINDS.filter((kind) => oneOf(NOTE_MODES, patch[kind]) !== undefined).map((kind) => [kind, patch[kind]]);
  const sounds = oneOf(SOUND_SETS, patch["sounds"]) === undefined ? [] : [["sounds", patch["sounds"]]];
  return { ...state, notifications: notifications({ ...state.notifications, ...Object.fromEntries([...modes, ...sounds]) }) };
}
