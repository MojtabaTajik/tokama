import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fakeUpdateEngine, fakeUpdateMode } from "./update.js";

describe("fakeUpdateMode", () => {
  it("takes the three modes and nothing else", () => {
    expect(fakeUpdateMode("ready")).toBe("ready");
    expect(fakeUpdateMode("ready-critical")).toBe("ready-critical");
    expect(fakeUpdateMode("error")).toBe("error");
    expect(fakeUpdateMode(undefined)).toBeUndefined();
    expect(fakeUpdateMode("1")).toBeUndefined();
  });
});

describe("fakeUpdateEngine", () => {
  it("finds and downloads an update after a check, and marks the important one with a minimum version", async () => {
    const engine = fakeUpdateEngine("ready-critical", { outDir: tmpdir(), quit: () => undefined });
    const downloaded = vi.fn();
    engine.onDownloaded(downloaded);
    expect(await engine.check()).toEqual({ available: true });
    await vi.waitFor(() => expect(downloaded).toHaveBeenCalledWith({ version: "0.2.2", minSafeVersion: "0.2.0" }));
  });

  it("fails the check in error mode", async () => {
    await expect(fakeUpdateEngine("error", { outDir: tmpdir(), quit: () => undefined }).check()).rejects.toThrow();
  });

  it("writes what the installer would do, then quits", () => {
    const dir = mkdtempSync(join(tmpdir(), "tk-fake-update-227-"));
    try {
      const quit = vi.fn();
      fakeUpdateEngine("ready", { outDir: dir, quit }).quitAndInstall(false);
      expect(JSON.parse(readFileSync(join(dir, "update-installed"), "utf8"))).toEqual({ version: "0.2.0", relaunch: false });
      expect(quit).toHaveBeenCalledOnce();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
