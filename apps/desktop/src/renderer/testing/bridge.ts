// A bridge over the test data for renderer tests: `setup`, `board` and `item` answer from it, and
// connection changes and events are pushed by hand inside React's act().
import type { ItemRecord } from "@tokama/core";
import { act } from "react";
import { vi } from "vitest";
import type { AboutInfo, BridgeEvent, ConnectionState, OpenResult, TokamaBridge } from "../../shared/bridge.js";
import { DEFAULT_DESKTOP_STATE, type DesktopState } from "../../shared/desktop-state.js";
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

export function fakeBridge(initial: ConnectionState, options: { boardItems?: ItemRecord[]; reply?: (query: { type: string }) => Reply | Promise<Reply> | undefined; commandReply?: (command: { type: string }) => Reply; pickFolder?: () => Promise<string | null>; openTemplateFile?: () => Promise<OpenResult>; about?: AboutInfo; copyBuildInfo?: () => Promise<void>; showDataFolder?: () => Promise<OpenResult>; desktopState?: DesktopState } = {}) {
  let connectionListener: ((state: ConnectionState) => void) | undefined;
  // Every subscriber hears every event: the app and the open drawer both listen.
  const eventListeners = new Set<(event: BridgeEvent) => void>();
  const stops = { connection: vi.fn(), event: vi.fn() };
  const boardItems = options.boardItems ?? items;
  const query = vi.fn(async (q: { type: string; itemId?: string }): Promise<Reply> => {
    const custom = options.reply?.(q);
    if (custom) return custom;
    if (q.type === "setup") return { ok: true, data: setup };
    if (q.type === "board") return { ok: true, data: { items: boardItems } };
    const item = q.type === "item" ? boardItems.find((candidate) => candidate.id === q.itemId) : undefined;
    if (item) return { ok: true, data: { item } };
    return { ok: false, error: { code: "not_implemented", message: q.type } };
  });
  const bridge = {
    getConnection: vi.fn(async () => initial),
    retryConnection: vi.fn(async () => undefined),
    onConnection: vi.fn((listener: (state: ConnectionState) => void) => {
      connectionListener = listener;
      return stops.connection;
    }),
    query,
    command: vi.fn(async (c: { type: string }): Promise<Reply> => options.commandReply?.(c) ?? { ok: false, error: { code: "not_implemented", message: c.type } }),
    pickFolder: vi.fn(options.pickFolder ?? (async () => null)),
    openTemplateFile: vi.fn(options.openTemplateFile ?? (async (): Promise<OpenResult> => ({ ok: true }))),
    getAboutInfo: vi.fn(async () => options.about ?? ABOUT_INFO),
    copyBuildInfo: vi.fn(options.copyBuildInfo ?? (async () => undefined)),
    showDataFolder: vi.fn(options.showDataFolder ?? (async (): Promise<OpenResult> => ({ ok: true }))),
    getDesktopState: vi.fn(async () => options.desktopState ?? DEFAULT_DESKTOP_STATE),
    saveLayout: vi.fn(async () => undefined),
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
  return { bridge, query, saveLayout, copyBuildInfo, showDataFolder, command, retryConnection, openTemplateFile, setConnection, pushItem, pushEvent, stops };
}
