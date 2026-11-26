// Tests only: a stand-in for the updater, so the UI flow tests can walk through an update without a
// feed. `TOKAMA_E2E_UPDATE` picks what the feed says: `ready` (version 0.2.0 is downloaded
// once the first check runs), `ready-critical` (0.2.2, marked important) or `error` (the feed
// does not answer). It is switched on only by a test run, never in a packaged app. Where the real
// installer would swap the app, it writes `update-installed` and quits.
import { join } from "node:path";
import { replaceTextSync } from "@tokama/core";
import type { FeedInfo, UpdateEngine } from "../update/port.js";

export type FakeUpdateMode = "ready" | "ready-critical" | "error";

/** The mode a test asked for; undefined for anything else. */
export function fakeUpdateMode(value: string | undefined): FakeUpdateMode | undefined {
  return value === "ready" || value === "ready-critical" || value === "error" ? value : undefined;
}

export interface FakeUpdateDeps {
  /** An existing folder where `update-installed` is written. */
  readonly outDir: string;
  readonly quit: () => void;
}

export function fakeUpdateEngine(mode: FakeUpdateMode, deps: FakeUpdateDeps): UpdateEngine {
  const info: FeedInfo =
    mode === "ready-critical"
      ? { version: "0.2.2", minSafeVersion: "0.2.0" }
      : { version: "0.2.0" };
  const listeners = { available: [] as ((info: FeedInfo) => void)[], downloaded: [] as ((info: FeedInfo) => void)[] };
  return {
    async check() {
      if (mode === "error") throw new Error("the fake feed does not answer");
      // After the check has answered, as the real updater does: found, then downloaded.
      setTimeout(() => {
        for (const listener of listeners.available) listener(info);
        for (const listener of listeners.downloaded) listener(info);
      }, 20);
      return { available: true };
    },
    onAvailable: (listener) => void listeners.available.push(listener),
    onProgress: () => undefined,
    onDownloaded: (listener) => void listeners.downloaded.push(listener),
    onError: () => undefined,    quitAndInstall: (relaunch) => {
      replaceTextSync(join(deps.outDir, "update-installed"), `${JSON.stringify({ version: info.version, relaunch })}\n`);
      deps.quit();
    },
  };
}
