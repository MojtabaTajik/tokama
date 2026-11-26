import { describe, expect, it, vi } from "vitest";
import { checksEnabled } from "./gate.js";

describe("checksEnabled", () => {
  it("never checks in a development build", () => {
    const inApplications = vi.fn(() => true);
    expect(checksEnabled({ platform: "darwin", isPackaged: false, inApplications })).toEqual({ ok: false, reason: "development" });
    expect(inApplications).not.toHaveBeenCalled();
  });

  it.each<NodeJS.Platform>(["linux", "win32"])("leaves updates manual on %s, and never asks about Applications", (platform) => {
    const inApplications = vi.fn(() => true);
    expect(checksEnabled({ platform, isPackaged: true, inApplications })).toEqual({ ok: false, reason: "platform" });
    expect(inApplications).not.toHaveBeenCalled();
  });

  it("does not check from outside Applications", () => {
    expect(checksEnabled({ platform: "darwin", isPackaged: true, inApplications: () => false })).toEqual({ ok: false, reason: "not_in_applications" });
  });

  it("checks for a packaged Mac app in Applications", () => {
    expect(checksEnabled({ platform: "darwin", isPackaged: true, inApplications: () => true })).toEqual({ ok: true });
  });
});
