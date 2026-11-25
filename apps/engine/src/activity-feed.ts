// The live activity of running items, for clients: the latest per item, and pushed at most once
// a second per item. The first change goes out at once; changes within the second after it go
// out as one, with the latest state, when the second is over. The second counts across a clear
// (an agent call ends, a check starts), so fast checks never send more. In memory only.
import type { Clock, ItemActivity, ItemId, TimerHandle } from "@tokama/core";

export const ACTIVITY_INTERVAL_MS = 1_000;

export class ActivityFeed {
  private readonly latest = new Map<ItemId, ItemActivity>();
  private readonly sentAt = new Map<ItemId, number>();
  private readonly timers = new Map<ItemId, TimerHandle>();
  private closed = false;

  constructor(
    private readonly clock: Clock,
    private readonly publish: (activity: ItemActivity) => void,
    private readonly intervalMs = ACTIVITY_INTERVAL_MS,
  ) {}

  /** What the item does now; `undefined` once nothing runs, which sends nothing. */
  update(itemId: ItemId, activity: ItemActivity | undefined): void {
    if (activity === undefined) {
      this.latest.delete(itemId);
      this.cancel(itemId);
      return;
    }
    if (this.closed) return;
    this.latest.set(itemId, activity);
    if (this.timers.has(itemId)) return;
    const wait = (this.sentAt.get(itemId) ?? -Infinity) + this.intervalMs - this.clock.now();
    if (wait <= 0) return this.send(itemId);
    this.timers.set(
      itemId,
      this.clock.setTimeout(() => {
        this.timers.delete(itemId);
        this.send(itemId);
      }, wait),
    );
  }

  /** The item's latest activity, not throttled: for a client that opens the item mid-run. */
  get(itemId: ItemId): ItemActivity | null {
    return this.latest.get(itemId) ?? null;
  }

  /** Stops every pending push, and takes no more. */
  close(): void {
    this.closed = true;
    for (const itemId of [...this.timers.keys()]) this.cancel(itemId);
    this.latest.clear();
    this.sentAt.clear();
  }

  private send(itemId: ItemId): void {
    const activity = this.latest.get(itemId);
    if (activity === undefined) return;
    this.sentAt.set(itemId, this.clock.now());
    this.publish(activity);
  }

  private cancel(itemId: ItemId): void {
    const timer = this.timers.get(itemId);
    if (timer !== undefined) this.clock.clearTimeout(timer);
    this.timers.delete(itemId);
  }
}
