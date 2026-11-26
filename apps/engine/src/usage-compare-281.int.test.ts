// Temporary: compares the usage_calls table with the rows read from the items. Removed in the next commit.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ItemIndex } from "./item-index.js";
import { USAGE_NOW, writeUsageItems } from "./testing/usage-fixture.js";
import { usageRowsOf } from "./usage.js";

it("the table and the items give the same rows for several `since`", () => {
  const home = mkdtempSync(join(tmpdir(), "tokama-compare-281-"));
  try {
    const items = writeUsageItems(home);
    const index = ItemIndex.open(join(home, "tokama.db"));
    try {
      index.rebuild(items);
      const DAY = 24 * 60 * 60_000;
      const equalTimes = USAGE_NOW - 2 * 60 * 60_000;
      for (const since of [0, USAGE_NOW - 100 * DAY, USAGE_NOW - 90 * DAY, USAGE_NOW - 30 * DAY, USAGE_NOW - 14 * DAY, USAGE_NOW - 3 * DAY, USAGE_NOW - 3 * DAY + 1, equalTimes, USAGE_NOW - 60 * 60_000, USAGE_NOW - 60 * 60_000 + 1, USAGE_NOW + 1]) {
        expect(usageRowsOf(items, since), `since ${USAGE_NOW - since}`).toStrictEqual(index.usageRows(since));
      }
      const all = index.usageRows(0);
      expect(all.length).toBeGreaterThan(8);
      expect(all.some((row) => row.repoId === undefined)).toBe(true);
      expect(items.some((item) => item.deleted)).toBe(true);
      expect(new Set(all.map((row) => row.call.endedAt)).size).toBeLessThan(all.length);
    } finally {
      index.close();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
