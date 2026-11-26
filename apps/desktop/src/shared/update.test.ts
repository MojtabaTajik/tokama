import { describe, expect, it } from "vitest";
import { updateAction, updateChip, updatePanelText } from "./update.js";

describe("updateChip", () => {
  it("shows no chip unless an update is ready or installing", () => {
    for (const state of [
      { status: "unavailable", reason: "development" },
      { status: "idle" },
      { status: "checking" },
      { status: "downloading", version: "0.2.0", percent: 40, transferred: 38, total: 96 },
      { status: "error", stage: "check", at: 1 },
    ] as const) {
      expect(updateChip(state, 0)).toBeUndefined();
    }
  });

  it("says Update for a ready update with nothing running", () => {
    expect(updateChip({ status: "ready", version: "0.2.0" }, 0)).toEqual({
      kind: "ready",
      version: "0.2.0",
      critical: false,
      label: "Update",
      title: "Tokama 0.2.0 is ready",
      action: "Click to update, then confirm the restart",
      accessibleName: "Update: Tokama 0.2.0 is ready. Click to update, then confirm the restart.",
      running: 0,
    });
  });

  it("names the running items in the action line, in the singular and the plural", () => {
    expect(updateChip({ status: "ready", version: "0.2.0" }, 2)?.action).toBe("2 items are running. You can restart when they finish");
    expect(updateChip({ status: "ready", version: "0.2.0" }, 1)?.action).toBe("1 item is running. You can restart when it finishes");
    expect(updateChip({ status: "ready", version: "0.2.0" }, 2)?.accessibleName).toBe("Update: Tokama 0.2.0 is ready. 2 items are running. You can restart when they finish.");
  });

  it("marks an important update with the word, the reason and a title that starts with it", () => {
    const view = updateChip({ status: "ready", version: "0.2.2", critical: { reason: "Fixes a security problem. Update soon." } }, 0);
    expect(view).toMatchObject({
      critical: true,
      label: "Important update",
      title: "Important update · 0.2.2",
      reason: "Fixes a security problem. Update soon.",
      accessibleName: "Important update: Tokama 0.2.2. Fixes a security problem. Update soon. Click to update, then confirm the restart.",
    });
  });

  it("says the update did not install when the installer is silent", () => {
    expect(updateChip({ status: "stalled", version: "0.2.0" }, 0)).toMatchObject({
      kind: "stalled",
      label: "Update didn't install",
      accessibleName: "Update didn't install. Tokama will try again when you quit.",
    });
  });

  it("shows the status line while it installs", () => {
    expect(updateChip({ status: "installing", version: "0.2.0" }, 0)).toMatchObject({ kind: "installing", label: "Restarting to update…", accessibleName: "Restarting to update…" });
  });
});

describe("update texts", () => {
  it("builds the action line and the panel text", () => {
    expect(updateAction(0)).toBe("Click to update, then confirm the restart");
    expect(updatePanelText(2)).toBe("2 items are still running. You can restart when they finish.");
    expect(updatePanelText(1)).toBe("1 item is still running. You can restart when it finishes.");
  });
});
