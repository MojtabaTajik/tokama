// The only file that imports electron-updater. The feed is the `app-update.yml` that the build
// wrote into the app's Resources: no URL comes from the window, the environment or a setting.
import { basename } from "node:path";
import type { Session } from "electron";
import { DebUpdater, MacUpdater, RpmUpdater } from "electron-updater";
import { fetchFeedFiles, LINUX_UPDATE_PUBLIC_KEY, sha512OfFile, sha512OfFileStream, verifyFeed } from "./feed-signature.js";
import type { FeedInfo, UpdateEngine } from "./port.js";
import { updaterRequestAllowed } from "./session.js";

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
 * What stands between a download and the installer where the package has no publisher signature
 * (Linux): the download counts as ready only after `verify` passes, and the install happens only
 * if the file still has the digest that was verified.
 */
export interface DownloadGate {
  /** Resolves when the signed feed names a package of this version with this base64 sha512; rejects with the reason when not. */
  verify(download: { readonly version: string; readonly sha512: string; readonly name: string }): Promise<void>;
  /** The base64 sha512 of the file, read in pieces without holding up the app. */
  hash(file: string): Promise<string>;
  /** The same digest, at once: the install path is synchronous. */
  hashNow(file: string): string;
}

/**
 * Wraps an updater as the app's port and sets it up. The download stays on disk and nothing is
 * handed to the installer by itself: `autoInstallOnAppQuit` stays off, because an update that the
 * installer already holds would be installed on any quit, running work or not. Downgrades and
 * pre-releases are off. With a `gate`, a download is held back until the gate passes it; a failure
 * is reported as the updater's own error, and the install refuses a file that changed since.
 */
export function updateEngineFor(updater: UpdaterLike, gate?: DownloadGate): UpdateEngine {
  const errorListeners: ((error: Error) => void)[] = [];
  /** The file the gate passed, and its digest then. Cleared by any download the gate does not pass. */
  let verified: { readonly file: string; readonly sha512: string } | undefined;
  /** Counts the updater's downloads: a check that started for an earlier one never counts for a later one. */
  let generation = 0;
  /** The file of the latest download, as the updater named it. The install takes only this one. */
  let latestFile: string | undefined;
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
        if (info === undefined) return;
        if (gate === undefined) return listener(info);
        verified = undefined;
        const mine = ++generation;
        const file = isRecord(payload) ? payload["downloadedFile"] : undefined;
        latestFile = typeof file === "string" ? file : undefined;
        void (async () => {
          if (typeof file !== "string") throw new Error("the updater named no downloaded file");
          const sha512 = await gate.hash(file);
          await gate.verify({ version: info.version, sha512, name: basename(file) });
          // A newer download came while this one was checked: its own check decides.
          if (mine !== generation) return false;
          verified = { file, sha512 };
          return true;
        })().then(
          (current) => {
            if (current) listener(info);
          },
          (error: unknown) => {
            if (mine !== generation) return;
            const failure = error instanceof Error ? error : new Error("update verification failed");
            for (const report of errorListeners) report(failure);
          },
        );
      }),
    onError: (listener) => {
      errorListeners.push(listener);
      updater.on("error", (error) => listener(error instanceof Error ? error : new Error("update error")));
    },
    quitAndInstall: (relaunch) => {
      // The updater installs the file it holds; a change since the gate passed it (a disk is shared with the user's other programs) ends the install.
      // It must also be the file of the latest download: that is the one the updater holds and installs.
      if (gate !== undefined && (verified === undefined || verified.file !== latestFile || gate.hashNow(verified.file) !== verified.sha512)) throw new Error("the downloaded update is not the one that was verified");
      updater.autoRunAppAfterInstall = relaunch;
      updater.quitAndInstall();
    },
  };
}

/**
 * The updater of a Linux package (`deb` or `rpm`, as the build recorded in the package) and its
 * network session. The .deb and .rpm carry no publisher signature and are installed as root, so
 * a download is ready only when the feed file, signed by the release key, names it. The
 * package-specific class is chosen here and never by the library's own `autoUpdater`, which falls
 * back to an AppImage updater.
 */
export function linuxUpdateEngine(kind: "deb" | "rpm", feedUrl: string): { readonly engine: UpdateEngine; readonly session: () => Session } {
  const updater = kind === "deb" ? new DebUpdater() : new RpmUpdater();
  const gate: DownloadGate = {
    hash: sha512OfFileStream,
    hashNow: sha512OfFile,
    verify: async ({ version, sha512, name }) => {
      const { yml, sig } = await fetchFeedFiles((url, init) => updater.netSession.fetch(url, init), feedUrl, (url) => updaterRequestAllowed(url, feedUrl));
      const verdict = verifyFeed({ yml, sig, publicKey: LINUX_UPDATE_PUBLIC_KEY, format: kind, downloadedSha512: sha512, downloadedVersion: version, downloadedName: name });
      if (!verdict.ok) throw new Error(verdict.reason);
    },
  };
  return { engine: updateEngineFor(updater as unknown as UpdaterLike, gate), session: () => updater.netSession };
}

/** The Mac updater and its network session, which the app locks down before the first check. */
export function macUpdateEngine(): { readonly engine: UpdateEngine; readonly session: () => Session } {
  const updater = new MacUpdater();
  return { engine: updateEngineFor(updater as unknown as UpdaterLike), session: () => updater.netSession };
}
