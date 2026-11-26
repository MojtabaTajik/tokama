// What the rest of the main process knows of the updater. Nothing from electron-updater leaks past
// this file, so the update flow is tested with a fake.

/** What the feed says about the newest version. `minSafeVersion` is untrusted data from the network. */
export interface FeedInfo {
  readonly version: string;
  readonly minSafeVersion?: unknown;
}

export interface UpdateEngine {
  /** Asks the feed. Resolves with whether a newer version exists (its download starts by itself); rejects when the feed cannot be read. */
  check(): Promise<{ readonly available: boolean }>;
  onAvailable(listener: (info: FeedInfo) => void): void;
  onProgress(listener: (progress: { readonly percent: number; readonly transferred: number; readonly total: number }) => void): void;
  /** The download is on disk and its digest matched the feed. */
  onDownloaded(listener: (info: FeedInfo) => void): void;
  /** Any failure the updater reports: the feed, the download, or the native installer. */
  onError(listener: (error: Error) => void): void;
  /** Hands the downloaded update to the system installer and quits the app; `relaunch` starts the new version afterwards. */
  quitAndInstall(relaunch: boolean): void;}
