import { describe, expect, it } from "vitest";
import { createFocusProbe } from "./focus.js";

describe("createFocusProbe", () => {
  it("reports locked while the screen is locked", async () => {
    expect(await createFocusProbe({ idleState: () => "locked" }).state()).toBe("locked");
  });

  it("reports unknown otherwise, because no platform gives a readable Focus state", async () => {
    for (const idle of ["active", "idle", "unknown"] as const) expect(await createFocusProbe({ idleState: () => idle }).state()).toBe("unknown");
  });
});
