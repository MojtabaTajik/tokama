// The only file that imports electron-updater. The feed is the `app-update.yml` that the build
// wrote into the app's Resources: no URL comes from the window, the environment or a setting.
import type { Session } from "electron";
import { MacUpdater } from "electron-updater";
import type { FeedInfo, UpdateEngine } from "./port.js";

/** The part of an updater that this file uses, so a test can hand in a fake. */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  autoRunAppAfterInstall: boolean;
  allowDowngrade: boolean;
  allowPrerelease: boolean;
  logger: { info(): void; warn(): void; error(): void; debug(): void } | null;
  /** What an event carries comes from the network, so it is read as unknown. */
  on(event: string, listener: (payload: unknown) => void): unknown;
  checkForUpdates(): Promise<{ readonly isUpdateAvailable: boolean; readonly downloadPromise?: Promise<unknown> | null } | null>;
  quitAndInstall(): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** The version, and the minimum safe version the release names under `vendor.tokama`; nothing else of the feed is read. */
function feedInfo(payload: unknown): FeedInfo | undefined {
  if (!isRecord(payload) || typeof payload["version"] !== "string") return undefined;
  const vendor = payload["vendor"];
  const tokama = isRecord(vendor) ? vendor["tokama"] : undefined;
  const minSafeVersion = isRecord(tokama) ? tokama["minSafeVersion"] : undefined;
  return { version: payload["version"], ...(minSafeVersion !== undefined && { minSafeVersion }) };
}

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * Wraps an updater as the app's port and sets it up. The download stays on disk and nothing is
 * handed to the installer by itself: `autoInstallOnAppQuit` stays off, because an update that the
 * installer already holds would be installed on any quit, running work or not. Downgrades and
 * pre-releases are off.
 */
export function updateEngineFor(updater: UpdaterLike): UpdateEngine {
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = false;
  updater.allowDowngrade = false;
  updater.allowPrerelease = false;
  // The updater logs URLs and headers; failures reach the app through its error event.
  updater.logger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
  return {
    async check() {
      const result = await updater.checkForUpdates();
      // The download's own failure arrives through the error event; the promise is only kept from going unhandled.
      void result?.downloadPromise?.catch(() => undefined);
      return { available: result?.isUpdateAvailable === true };
    },
    onAvailable: (listener) =>
      updater.on("update-available", (payload) => {
        const info = feedInfo(payload);
        if (info !== undefined) listener(info);
      }),
    onProgress: (listener) =>
      updater.on("download-progress", (payload) => {
        if (isRecord(payload)) listener({ percent: number(payload["percent"]), transferred: number(payload["transferred"]), total: number(payload["total"]) });
      }),
    onDownloaded: (listener) =>
      updater.on("update-downloaded", (payload) => {
        const info = feedInfo(payload);
        if (info !== undefined) listener(info);
      }),
    onError: (listener) => updater.on("error", (error) => listener(error instanceof Error ? error : new Error("update error"))),
    quitAndInstall: (relaunch) => {
      updater.autoRunAppAfterInstall = relaunch;
      updater.quitAndInstall();
    },  };
}

/** The Mac updater and its network session, which the app locks down before the first check. */
export function macUpdateEngine(): { readonly engine: UpdateEngine; readonly session: () => Session } {
  const updater = new MacUpdater();
  return { engine: updateEngineFor(updater as unknown as UpdaterLike), session: () => updater.netSession };
}
