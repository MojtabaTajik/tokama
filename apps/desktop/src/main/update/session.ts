// The network session the updater downloads with. It is locked down like the window's: no
// permission is ever granted, and only https leaves it. Hosts are not listed: the release
// downloads redirect to storage hosts that change, and what protects the user is the feed's
// digest of the download plus the installer's check that the new app is signed by the same team.
import { readFileSync } from "node:fs";
import type { Session } from "electron";

/** A local test feed: `http://127.0.0.1:<port>/`, the one plain-http address a build may bake in. */
const LOOPBACK_FEED = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/$/;

/** Whether the updater may send this request. A loopback feed also allows its own address, and nothing else on http. */
export function updaterRequestAllowed(url: string, feedUrl: string | undefined): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  const loopback = feedUrl === undefined ? null : LOOPBACK_FEED.exec(feedUrl);
  return loopback !== null && parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && parsed.port === loopback[1];
}

/** The feed URL in the `app-update.yml` next to the app's resources; undefined when it cannot be read. */
export function bakedFeedUrl(configPath: string, read: (path: string) => string = (path) => readFileSync(path, "utf8")): string | undefined {
  try {
    const match = /^url:\s*['"]?(\S+?)['"]?\s*$/m.exec(read(configPath));
    return match?.[1];
  } catch {
    return undefined;
  }
}

/** Denies every permission and cancels every request `updaterRequestAllowed` refuses. */
export function lockDownUpdaterSession(session: Pick<Session, "setPermissionRequestHandler" | "setPermissionCheckHandler" | "webRequest">, feedUrl: string | undefined): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !updaterRequestAllowed(details.url, feedUrl) }));
}
