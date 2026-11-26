// A bridge over the test data for renderer tests: `setup` and `item` answer from it, and `board`
// (open items and counts) and `item_list` from it plus the items pushed since (a simple stand-in for the engine's index: group,
// start day, repo, template and a title search). Connection changes and events are pushed by hand
// inside React's act().
import type { BoardCount, ItemRecord } from "@tokama/core";
import { act } from "react";
import { vi } from "vitest";
import type { AboutInfo, BridgeEvent, ConnectionState, DiagnosticsLoad, DiagnosticsSaveResult, DiagnosticsSendResult, OpenResult, TokamaBridge } from "../../shared/bridge.js";
import { DEFAULT_DESKTOP_STATE, type DesktopState } from "../../shared/desktop-state.js";
import { localDay } from "../format/time.js";
import { bucketOf, isOpen } from "../model.js";
import { items, setup } from "./sample.js";

export type Reply = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

export const ABOUT_INFO: AboutInfo = {
  app: { version: "1.2.3", built: "2026-11-24", commit: "85a75e3" },
  engine: { version: "1.2.3", apiVersion: 4, pid: 48211 },
  dataFolder: "~/.tokama",
  runtime: { electron: "45.4.1", node: "24.1.0" },
  platform: "macOS · arm64",
};

export const CONNECTED: ConnectionState = { status: "connected", engineId: "e-1" };

export function fakeBridge(initial: ConnectionState, options: { boardItems?: ItemRecord[]; reply?: (query: { type: string }) => Reply | Promise<Reply> | undefined; commandReply?: (command: { type: string }) => Reply; pickFolder?: () => Promise<string | null>; openTemplateFile?: () => Promise<OpenResult>; openAttemptFile?: () => Promise<OpenResult>; about?: AboutInfo; copyBuildInfo?: () => Promise<void>; showDataFolder?: () => Promise<OpenResult>; desktopState?: DesktopState; loadDiagnostics?: () => Promise<DiagnosticsLoad>; sendDiagnostics?: (ids: readonly string[]) => Promise<DiagnosticsSendResult>; saveDiagnostics?: (ids: readonly string[]) => Promise<DiagnosticsSaveResult> } = {}) {
  let connectionListener: ((state: ConnectionState) => void) | undefined;
  let openListener: ((itemId: string) => void) | undefined;
  // Every subscriber hears every event: the app and the open drawer both listen.
  const eventListeners = new Set<(event: BridgeEvent) => void>();
  const stops = { connection: vi.fn(), event: vi.fn() };
  const boardItems = options.boardItems ?? items;
  const listed = new Map(boardItems.map((item) => [item.id, item]));
  const query = vi.fn(async (q: { type: string; itemId?: string }): Promise<Reply> => {
    const custom = options.reply?.(q);
    if (custom) return custom;
    if (q.type === "setup") return { ok: true, data: setup };
    if (q.type === "board") return { ok: true, data: board([...listed.values()]) };
    if (q.type === "item_list") return { ok: true, data: itemList([...listed.values()], q as unknown as ListQuery) };
    const item = q.type === "item" ? boardItems.find((candidate) => candidate.id === q.itemId) : undefined;
    if (item) return { ok: true, data: { item } };
    return { ok: false, error: { code: "not_implemented", message: q.type } };
  });
  const bridge = {
    getConnection: vi.fn(async () => initial),
    retryConnection: vi.fn(async () => undefined),
    restartEngine: vi.fn(async () => undefined),
    waitForEngine: vi.fn(async () => undefined),
    onConnection: vi.fn((listener: (state: ConnectionState) => void) => {
      connectionListener = listener;
      return stops.connection;
    }),
    query,
    command: vi.fn(async (c: { type: string }): Promise<Reply> => options.commandReply?.(c) ?? { ok: false, error: { code: "not_implemented", message: c.type } }),
    pickFolder: vi.fn(options.pickFolder ?? (async () => null)),
    openTemplateFile: vi.fn(options.openTemplateFile ?? (async (): Promise<OpenResult> => ({ ok: true }))),
    openAttemptFile: vi.fn(options.openAttemptFile ?? (async (): Promise<OpenResult> => ({ ok: true }))),
    getAboutInfo: vi.fn(async () => options.about ?? ABOUT_INFO),
    copyBuildInfo: vi.fn(options.copyBuildInfo ?? (async () => undefined)),
    showDataFolder: vi.fn(options.showDataFolder ?? (async (): Promise<OpenResult> => ({ ok: true }))),
    getDesktopState: vi.fn(async () => options.desktopState ?? DEFAULT_DESKTOP_STATE),
    saveLayout: vi.fn(async () => undefined),
    reportError: vi.fn(async () => undefined),
    countUsage: vi.fn(async () => undefined),
    saveNotifications: vi.fn(async () => undefined),
    setViewedItem: vi.fn(async () => undefined),
    onOpenItem: vi.fn((listener: (itemId: string) => void) => {
      openListener = listener;
      return () => {
        openListener = undefined;
      };
    }),
    loadDiagnostics: vi.fn(options.loadDiagnostics ?? (async (): Promise<DiagnosticsLoad> => ({ ok: true, items: [] }))),
    sendDiagnostics: vi.fn(options.sendDiagnostics ?? (async (): Promise<DiagnosticsSendResult> => ({ ok: false, reason: "nothing", count: 0 }))),
    saveDiagnostics: vi.fn(options.saveDiagnostics ?? (async (): Promise<DiagnosticsSaveResult> => ({ ok: false, reason: "cancelled" }))),
    stopCrashPrompt: vi.fn(async () => undefined),
    onEvent: vi.fn((listener: (event: BridgeEvent) => void) => {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
        stops.event();
      };
    }),
  } as unknown as TokamaBridge;
  const setConnection = (state: ConnectionState) => act(async () => connectionListener?.(state));
  let seq = 0;
  const pushItem = (item: ItemRecord) => act(async () => {
      listed.set(item.id, item);
      for (const listener of eventListeners) listener({ kind: "event", seq: seq++, event: { type: "item_updated", item } });
    });
  const pushEvent = (event: BridgeEvent["event"]) => act(async () => {
      for (const listener of eventListeners) listener({ kind: "event", seq: seq++, event });
    });
  const command = bridge.command as unknown as ReturnType<typeof vi.fn>;
  const retryConnection = bridge.retryConnection as unknown as ReturnType<typeof vi.fn>;
  const openTemplateFile = bridge.openTemplateFile as unknown as ReturnType<typeof vi.fn>;
  const copyBuildInfo = bridge.copyBuildInfo as unknown as ReturnType<typeof vi.fn>;
  const showDataFolder = bridge.showDataFolder as unknown as ReturnType<typeof vi.fn>;
  const saveLayout = bridge.saveLayout as unknown as ReturnType<typeof vi.fn>;
  const saveNotifications = bridge.saveNotifications as unknown as ReturnType<typeof vi.fn>;
  const setViewedItem = bridge.setViewedItem as unknown as ReturnType<typeof vi.fn>;
  /** A click on a notification: the main process asks the window to open the item. */
  const openItem = (itemId: string) => act(async () => openListener?.(itemId));
  return { bridge, query, saveLayout, saveNotifications, setViewedItem, openItem, copyBuildInfo, showDataFolder, command, retryConnection, openTemplateFile, setConnection, pushItem, pushEvent, stops };
}

export interface ListQuery {
  readonly group: string;
  readonly since?: string;
  readonly repo?: string;
  readonly template?: string;
  readonly q?: string;
  readonly before?: string;
  readonly limit: number;
}

/** The engine's board answer over these items: the open ones, and the finished ones counted by day, template and repos. */
export function board(all: readonly ItemRecord[]): { items: ItemRecord[]; counts: BoardCount[] } {
  const counts = new Map<string, BoardCount>();
  for (const item of all) {
    const bucket = bucketOf(item);
    if (bucket !== "done" && bucket !== "failed") continue;
    const day = localDay(item.createdAt);
    const key = JSON.stringify([day, item.templateId, item.repoIds]);
    const row = counts.get(key) ?? { day, templateId: item.templateId, repoIds: item.repoIds, done: 0, failed: 0 };
    counts.set(key, { ...row, [bucket]: row[bucket] + 1 });
  }
  return { items: all.filter(isOpen), counts: [...counts.values()] };
}

/** The engine's item_list answer over these items. */
export function itemList(all: readonly ItemRecord[], query: ListQuery) {
  const groupOf = (item: ItemRecord) => (bucketOf(item) === "active" ? "running" : bucketOf(item));
  const text = (query.q ?? "").trim().toLowerCase();
  const finished = query.group === "done" || query.group === "failed";
  const matching = all
    .filter((item) => groupOf(item) === query.group)
    .filter((item) => !finished || query.since === undefined || localDay(item.createdAt) >= query.since)
    .filter((item) => query.repo === undefined || (item.repoIds as readonly string[]).includes(query.repo))
    .filter((item) => query.template === undefined || item.templateId === query.template)
    .filter((item) => text === "" || item.title.toLowerCase().includes(text))
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  const key = (item: ItemRecord) => `${item.createdAt}:${item.id}`;
  const start = query.before === undefined ? 0 : matching.findIndex((item) => key(item) === query.before) + 1;
  const page = matching.slice(start, start + query.limit);
  const more = start + query.limit < matching.length;
  const onPage = [...new Set(page.map((item) => localDay(item.createdAt)))];
  return {
    items: page,
    nextCursor: more ? key(page.at(-1)!) : null,
    total: matching.length,
    days: finished ? onPage.map((day) => ({ day, count: matching.filter((item) => localDay(item.createdAt) === day).length })) : [],
  };
}
