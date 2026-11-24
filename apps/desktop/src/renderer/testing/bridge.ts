// A bridge over the test data for renderer tests: `setup`, `board` and `item` answer from it, and
// connection changes and events are pushed by hand inside React's act().
import type { ItemRecord } from "@tokama/core";
import { act } from "react";
import { vi } from "vitest";
import type { BridgeEvent, ConnectionState, TokamaBridge } from "../../shared/bridge.js";
import { items, setup } from "./sample.js";

export type Reply = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

export const CONNECTED: ConnectionState = { status: "connected", engineId: "e-1" };

export function fakeBridge(initial: ConnectionState, options: { boardItems?: ItemRecord[]; reply?: (query: { type: string }) => Reply | Promise<Reply> | undefined; commandReply?: (command: { type: string }) => Reply } = {}) {
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
  const command = bridge.command as unknown as ReturnType<typeof vi.fn>;
  const retryConnection = bridge.retryConnection as unknown as ReturnType<typeof vi.fn>;
  return { bridge, query, command, retryConnection, setConnection, pushItem, stops };
}
