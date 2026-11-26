import { describe, expect, it, vi } from "vitest";
import { updateEngineFor, type UpdaterLike } from "./electron-updater.js";

function fakeUpdater(over: Partial<UpdaterLike> = {}) {
  const handlers = new Map<string, (payload: unknown) => void>();
  const order: string[] = [];
  const updater: UpdaterLike = {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    autoRunAppAfterInstall: true,
    allowDowngrade: true,
    allowPrerelease: true,
    logger: null,
    on: (event, listener) => void handlers.set(event, listener),
    checkForUpdates: async () => ({ isUpdateAvailable: false }),
    quitAndInstall() {
      order.push(`quit:${String(this.autoRunAppAfterInstall)}`);
    },
    ...over,
  };
  return { updater, handlers, order };
}

describe("updateEngineFor", () => {
  it("downloads by itself and installs, downgrades and pre-releases never by itself", () => {
    const { updater } = fakeUpdater();
    updateEngineFor(updater);
    expect(updater).toMatchObject({ autoDownload: true, autoInstallOnAppQuit: false, allowDowngrade: false, allowPrerelease: false });
  });

  it("silences the updater's log, which holds URLs", () => {
    const { updater } = fakeUpdater();
    updateEngineFor(updater);
    expect(() => {
      updater.logger?.info();
      updater.logger?.error();
    }).not.toThrow();
  });

  it("sets whether the app starts again before it calls the installer", () => {
    const { updater, order } = fakeUpdater();
    const engine = updateEngineFor(updater);
    engine.quitAndInstall(false);
    engine.quitAndInstall(true);
    expect(order).toEqual(["quit:false", "quit:true"]);
  });

  it("says whether a newer version exists, and keeps a failed download from going unhandled", async () => {
    const downloadPromise = Promise.reject(new Error("net"));
    const { updater } = fakeUpdater({ checkForUpdates: async () => ({ isUpdateAvailable: true, downloadPromise }) });
    expect(await updateEngineFor(updater).check()).toEqual({ available: true });
    expect(await updateEngineFor(fakeUpdater().updater).check()).toEqual({ available: false });
    expect(await updateEngineFor(fakeUpdater({ checkForUpdates: async () => null }).updater).check()).toEqual({ available: false });
  });

  it("passes a failed check on", async () => {
    const { updater } = fakeUpdater({ checkForUpdates: async () => { throw new Error("feed"); } });
    await expect(updateEngineFor(updater).check()).rejects.toThrow("feed");
  });

  it("reads only the version and the minimum safe version of the feed, and only well-formed events", () => {
    const { updater, handlers } = fakeUpdater();
    const engine = updateEngineFor(updater);
    const available = vi.fn();
    const progress = vi.fn();
    const error = vi.fn();
    engine.onAvailable(available);
    engine.onProgress(progress);
    engine.onError(error);
    handlers.get("update-available")?.({ version: "0.2.0", vendor: { tokama: { minSafeVersion: "0.1.5" }, other: 1 }, minSafeVersion: "9.9.9", releaseNotes: "<script>", files: [] });
    handlers.get("update-available")?.({ nope: true });
    handlers.get("download-progress")?.({ percent: 12.5, transferred: 3, total: "x" });
    handlers.get("error")?.("not an error object");
    expect(available.mock.calls).toEqual([[{ version: "0.2.0", minSafeVersion: "0.1.5" }]]);
    expect(progress).toHaveBeenCalledWith({ percent: 12.5, transferred: 3, total: 0 });
    expect(error).toHaveBeenCalledWith(expect.any(Error));
  });
});
