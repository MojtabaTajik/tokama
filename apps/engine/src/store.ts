// In-memory item store: the engine's state until the items slice exists. It holds no sample data;
// it is empty unless code puts items in it. Listeners hear about every change.
import type { ItemId, ItemRecord, WorkspaceId } from "@tokama/core";

export type ItemListener = (item: ItemRecord) => void;

export class MemoryItemStore {
  private readonly items = new Map<ItemId, ItemRecord>();
  private readonly listeners = new Set<ItemListener>();

  list(workspaceId: WorkspaceId): ItemRecord[] {
    return [...this.items.values()].filter((item) => item.workspaceId === workspaceId);
  }

  get(id: ItemId): ItemRecord | undefined {
    return this.items.get(id);
  }

  /** Adds or replaces an item and tells the listeners. */
  put(item: ItemRecord): void {
    this.items.set(item.id, item);
    for (const listener of this.listeners) listener(item);
  }

  /** Returns a function that removes the listener. */
  subscribe(listener: ItemListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
