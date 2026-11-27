import { describe, expect, it, vi } from "vitest";
import { type DownloadGate, updateEngineFor, type UpdaterLike } from "./electron-updater.js";

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

describe("updateEngineFor with a download gate", () => {
  /** A gate whose verdict and file digest the test sets. */
  function gated(verdict: () => Promise<void> = async () => undefined) {
    const digests = new Map([["/cache/Tokama-0.2.0-amd64.deb", "digest-1"]]);
    const verified: { version: string; sha512: string }[] = [];
    const gate: DownloadGate = {
      hash: async (file) => digests.get(file) ?? "missing",
      hashNow: (file) => digests.get(file) ?? "missing",
      verify: async (download) => {
        verified.push(download);
        await verdict();
      },
    };
    const base = fakeUpdater();
    const engine = updateEngineFor(base.updater, gate);
    const downloaded = vi.fn();
    const failed = vi.fn();
    engine.onDownloaded(downloaded);
    engine.onError(failed);
    const download = (payload: unknown = { version: "0.2.0", downloadedFile: "/cache/Tokama-0.2.0-amd64.deb" }) => {
      base.handlers.get("update-downloaded")?.(payload);
      return new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { ...base, engine, gate, digests, verified, downloaded, failed, download };
  }

  it("reports the download as ready only after the gate passed the file's digest and version", async () => {
    const { download, verified, downloaded, failed } = gated();
    await download();
    expect(verified).toEqual([{ version: "0.2.0", sha512: "digest-1", name: "Tokama-0.2.0-amd64.deb" }]);
    expect(downloaded).toHaveBeenCalledWith({ version: "0.2.0" });
    expect(failed).not.toHaveBeenCalled();
  });

  it("reports a refused download as an error, and never as ready", async () => {
    const { download, downloaded, failed } = gated(async () => {
      throw new Error("not signed");
    });
    await download();
    expect(downloaded).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: "not signed" }));
  });

  it("refuses a download that names no file", async () => {
    const { download, downloaded, failed, verified } = gated();
    await download({ version: "0.2.0" });
    expect(verified).toEqual([]);
    expect(downloaded).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledOnce();
  });

  it("refuses a download whose file cannot be read", async () => {
    const { download, downloaded, failed, gate } = gated();
    gate.hash = () => Promise.reject(new Error("ENOENT"));
    await download();
    expect(downloaded).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledOnce();
  });

  it("installs a file that still has the verified digest", async () => {
    const { download, engine, order } = gated();
    await download();
    engine.quitAndInstall(true);
    expect(order).toEqual(["quit:true"]);
  });

  it("does not install a file that changed after it was verified", async () => {
    const { download, engine, order, digests } = gated();
    await download();
    digests.set("/cache/Tokama-0.2.0-amd64.deb", "digest-2");
    expect(() => engine.quitAndInstall(true)).toThrow(/not the one that was verified/);
    expect(order).toEqual([]);
  });

  it("does not install before any download was verified", () => {
    const { engine, order } = gated();
    expect(() => engine.quitAndInstall(false)).toThrow();
    expect(order).toEqual([]);
  });

  it("does not install after a later download was refused: the updater holds that file now", async () => {
    let refuse = false;
    const { download, engine, order } = gated(async () => {
      if (refuse) throw new Error("not signed");
    });
    await download();
    refuse = true;
    await download();
    expect(() => engine.quitAndInstall(true)).toThrow();
    expect(order).toEqual([]);
  });

  it("ignores a check that was still running when a newer download came, even if it passes late", async () => {
    let release: () => void = () => undefined;
    let calls = 0;
    const { download, engine, order, downloaded, failed } = gated(async () => {
      calls += 1;
      // The first check waits; the second is refused at once.
      if (calls === 1) await new Promise<void>((resolve) => (release = resolve));
      else throw new Error("not signed");
    });
    await download();
    await download({ version: "0.3.0", downloadedFile: "/cache/Tokama-0.3.0-amd64.deb" });
    expect(failed).toHaveBeenCalledOnce();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(downloaded).not.toHaveBeenCalled();
    expect(() => engine.quitAndInstall(true)).toThrow(/not the one that was verified/);
    expect(order).toEqual([]);
  });

  it("does not report a refusal of a check that a newer download replaced", async () => {
    let release: () => void = () => undefined;
    let calls = 0;
    const { download, failed, downloaded } = gated(async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => (release = resolve));
        throw new Error("late refusal");
      }
    });
    await download();
    await download({ version: "0.3.0", downloadedFile: "/cache/Tokama-0.3.0-amd64.deb" });
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failed).not.toHaveBeenCalled();
    expect(downloaded).toHaveBeenCalledOnce();
  });
});

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
