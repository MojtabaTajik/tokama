import { describe, expect, it } from "vitest";
import type { UpdateState } from "../../shared/update.js";
import { updatesRow } from "./update-row.js";

const at = (hour: number, minute: number, day = 24) => new Date(2026, 10, day, hour, minute).getTime();
const NOW = at(11, 0);
const row = (state: UpdateState, running = 0) => updatesRow(state, "0.1.0", running, NOW);

describe("updatesRow", () => {
  it("says Up to date with the check time of today", () => {
    expect(row({ status: "idle", checkedAt: at(9, 12) })).toEqual({
      mark: "✓",
      tone: "pass",
      main: "Up to date",
      sub: "Version 0.1.0 · checked today at 09:12",
      action: { label: "Check now", kind: "check", primary: false, disabled: false },
    });
  });

  it("names the day of an older check", () => {
    expect(row({ status: "idle", checkedAt: at(9, 12, 22) })?.sub).toBe("Version 0.1.0 · checked 22 Nov at 09:12");
  });

  it("does not claim Up to date before the first check", () => {
    expect(row({ status: "idle" })).toMatchObject({ main: "Not checked yet", sub: "Version 0.1.0" });
  });

  it("checks with Check now off", () => {
    expect(row({ status: "checking" })).toMatchObject({ mark: "●", main: "Checking tokama.dev…", sub: "Version 0.1.0", action: { label: "Check now", disabled: true } });
  });

  it("shows the download with its percent, megabytes and a bar", () => {
    expect(row({ status: "downloading", version: "0.2.0", percent: 40, transferred: 38 * 1024 * 1024, total: 96 * 1024 * 1024 })).toMatchObject({
      mark: "↓",
      notes: "0.2.0",
      main: "Downloading 0.2.0 · 40%",
      sub: "38 of 96 MB · you can keep working",
      progress: { percent: 40, label: "Downloading Tokama 0.2.0" },
      action: { label: "Check now", disabled: true },
    });
  });

  it("offers Restart now for a ready update with nothing running", () => {
    expect(row({ status: "ready", version: "0.2.0" })).toEqual({
      mark: "↻",
      tone: "link",
      notes: "0.2.0",
      main: "0.2.0 is ready",
      sub: "Restart now, or Tokama installs it when you quit with nothing running. It never restarts by itself.",
      action: { label: "Restart now", kind: "restart", primary: true, disabled: false },
    });
  });

  it("keeps Restart now off while items run, in the plural and the singular", () => {
    expect(row({ status: "ready", version: "0.2.0" }, 2)).toMatchObject({ sub: "2 items are running. Restart once they finish. Tokama never restarts by itself.", action: { disabled: true } });
    expect(row({ status: "ready", version: "0.2.0" }, 1)?.sub).toBe("1 item is running. Restart once it finishes. Tokama never restarts by itself.");
  });

  it("says it cannot tell what runs, with Restart now off, when the engine refused without a count", () => {
    const refused = updatesRow({ status: "ready", version: "0.2.0" }, "0.1.0", 0, NOW, {});
    expect(refused?.sub).toBe("Tokama can't tell what's running right now. Try again in a moment. Tokama never restarts by itself.");
    expect(refused?.action).toMatchObject({ label: "Restart now", disabled: true });
    expect(updatesRow({ status: "ready", version: "0.2.0" }, "0.1.0", 0, NOW, { running: 2 })?.sub).toBe("2 items are running. Restart once they finish. Tokama never restarts by itself.");
  });

  it("shows the restart as a status without a button", () => {
    expect(row({ status: "installing", version: "0.2.0" })).toMatchObject({ main: "Restarting to update…" });
    expect(row({ status: "installing", version: "0.2.0" })?.action).toBeUndefined();
  });

  it("words each failed stage, with the fixed text and never the raw error", () => {
    expect(row({ status: "error", stage: "check", at: 1 })).toMatchObject({ mark: "✕", main: "Couldn’t check for updates", sub: "tokama.dev did not answer. Check your connection, then try again.", action: { label: "Try again" } });
    expect(row({ status: "error", stage: "download", at: 1 })?.main).toBe("Couldn’t download the update");
    expect(row({ status: "error", stage: "install", at: 1 })).toMatchObject({ main: "Couldn’t install the update", sub: "Tokama kept this version. Try again later.", action: { label: "Try again" } });
  });

  it("offers the notes link only while an update downloads or is ready", () => {
    const states: UpdateState[] = [{ status: "idle", checkedAt: 1 }, { status: "checking" }, { status: "installing", version: "0.2.0" }, { status: "error", stage: "check", at: 1 }];
    for (const state of states) expect(row(state)?.notes).toBeUndefined();
    expect(row({ status: "ready", version: "0.2.0" })?.notes).toBe("0.2.0");
  });

  it("is manual on an unsupported system and shows nothing for a development build or a copy outside Applications", () => {
    expect(row({ status: "unavailable", reason: "platform" })).toMatchObject({ main: "Updates are manual on this system." });
    expect(row({ status: "unavailable", reason: "development" })).toBeUndefined();
    expect(row({ status: "unavailable", reason: "not_in_applications" })).toBeUndefined();
  });
});
