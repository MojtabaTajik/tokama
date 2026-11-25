import { type ItemActivity, type ItemId, manualClock } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { ActivityFeed } from "./activity-feed.js";

const ITEM = "item_01JDZ0000000000000000000AA" as ItemId;
const at = (lastEventAt: number, label = "thinking"): ItemActivity => ({
  itemId: ITEM,
  stepIndex: 0,
  attempt: 1,
  by: "agent",
  lastAction: { kind: "think", label },
  lastEventAt,
  toolRunning: null,
});

function feed() {
  const clock = manualClock(10_000);
  const sent: ItemActivity[] = [];
  return { clock, sent, feed: new ActivityFeed(clock, (activity) => sent.push(activity)) };
}

describe("activity feed", () => {
  it("sends the first change at once and at most one a second after it, with the latest state", () => {
    const { clock, sent, feed: activity } = feed();
    activity.update(ITEM, at(10_000, "a"));
    expect(sent.map((s) => s.lastAction.label)).toEqual(["a"]);
    clock.advance(200);
    activity.update(ITEM, at(10_200, "b"));
    clock.advance(200);
    activity.update(ITEM, at(10_400, "c"));
    expect(sent).toHaveLength(1);
    clock.advance(599);
    expect(sent).toHaveLength(1);
    clock.advance(1);
    expect(sent.map((s) => s.lastAction.label)).toEqual(["a", "c"]);
    // A change long after the last push goes out at once again.
    clock.advance(5_000);
    activity.update(ITEM, at(16_000, "d"));
    expect(sent.map((s) => s.lastAction.label)).toEqual(["a", "c", "d"]);
  });

  it("serves the latest state unthrottled, and nothing once the item stopped running", () => {
    const { clock, sent, feed: activity } = feed();
    activity.update(ITEM, at(10_000, "a"));
    activity.update(ITEM, at(10_100, "b"));
    expect(activity.get(ITEM)?.lastAction.label).toBe("b");
    activity.update(ITEM, undefined);
    expect(activity.get(ITEM)).toBeNull();
    clock.advance(2_000);
    // The pending push was dropped with the activity.
    expect(sent).toHaveLength(1);
  });

  it("throttles each item on its own", () => {
    const { sent, feed: activity } = feed();
    const other = "item_01JDZ0000000000000000000BB" as ItemId;
    activity.update(ITEM, at(10_000));
    activity.update(other, { ...at(10_000), itemId: other });
    expect(sent.map((s) => s.itemId)).toEqual([ITEM, other]);
  });

  it("sends nothing more after close", () => {
    const { clock, sent, feed: activity } = feed();
    activity.update(ITEM, at(10_000, "a"));
    activity.update(ITEM, at(10_100, "b"));
    activity.close();
    clock.advance(5_000);
    expect(sent).toHaveLength(1);
    expect(activity.get(ITEM)).toBeNull();
  });
});
