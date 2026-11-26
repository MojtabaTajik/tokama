import { describe, expect, it } from "vitest";
import { CHIP_PRIORITY, pickChip, type SidebarChipCandidate } from "./sidebar-chip.js";

const candidate = (key: SidebarChipCandidate["key"], priority: number, node: string): SidebarChipCandidate => ({ key, priority, node });

describe("pickChip", () => {
  it("is nothing without candidates", () => {
    expect(pickChip([])).toBeUndefined();
  });

  it("takes the highest priority, whatever the order", () => {
    const updated = candidate("updated", CHIP_PRIORITY.updated, "Updated to");
    const update = candidate("update", CHIP_PRIORITY.update, "Update");
    expect(pickChip([updated, update])).toBe(update);
    expect(pickChip([update, updated])).toBe(update);
  });

  it("keeps the first of two with the same priority", () => {
    const first = candidate("updated", 1, "first");
    expect(pickChip([first, candidate("update", 1, "second")])).toBe(first);
  });

  it("lets a ready update win over the Updated to notice", () => {
    expect(CHIP_PRIORITY.update).toBeGreaterThan(CHIP_PRIORITY.updated);
  });
});
