import { describe, expect, it, vi } from "vitest";
import { bakedFeedUrl, lockDownUpdaterSession, updaterRequestAllowed } from "./session.js";

const FEED = "https://updates.tokama.dev/mac/";
const LOOPBACK = "http://127.0.0.1:8765/";

describe("updaterRequestAllowed", () => {
  it("allows https, whatever the host: release downloads redirect to changing hosts", () => {
    expect(updaterRequestAllowed("https://updates.tokama.dev/mac/latest-mac.yml", FEED)).toBe(true);
    expect(updaterRequestAllowed("https://objects.example.test/a.zip?sig=1", FEED)).toBe(true);
  });

  it("refuses plain http, other schemes and nonsense", () => {
    for (const url of ["http://updates.tokama.dev/mac/", "http://127.0.0.1:8765/latest-mac.yml", "file:///etc/passwd", "ftp://x.test/", "data:text/plain,hi", "not a url", ""]) {
      expect(updaterRequestAllowed(url, FEED)).toBe(false);
    }
  });

  it("allows only the loopback feed's own address and port when the baked feed is loopback", () => {
    expect(updaterRequestAllowed("http://127.0.0.1:8765/latest-mac.yml", LOOPBACK)).toBe(true);
    expect(updaterRequestAllowed("http://127.0.0.1:8765/Tokama-0.0.3-arm64-mac.zip", LOOPBACK)).toBe(true);
    expect(updaterRequestAllowed("http://127.0.0.1:9000/x", LOOPBACK)).toBe(false);
    expect(updaterRequestAllowed("http://localhost:8765/x", LOOPBACK)).toBe(false);
    expect(updaterRequestAllowed("http://127.0.0.2:8765/x", LOOPBACK)).toBe(false);
    expect(updaterRequestAllowed("https://updates.tokama.dev/x", LOOPBACK)).toBe(true);
  });

  it("allows no http without a loopback feed, also when the feed is unknown", () => {
    expect(updaterRequestAllowed("http://127.0.0.1:8765/x", undefined)).toBe(false);
  });
});

describe("bakedFeedUrl", () => {
  it("reads the url of app-update.yml", () => {
    const yml = "provider: generic\nurl: 'http://127.0.0.1:8765/'\nupdaterCacheDirName: tokama-updater\n";
    expect(bakedFeedUrl("/x/app-update.yml", () => yml)).toBe("http://127.0.0.1:8765/");
    expect(bakedFeedUrl("/x/app-update.yml", () => "url: https://updates.tokama.dev/mac/\n")).toBe("https://updates.tokama.dev/mac/");
  });

  it("is undefined when the file is missing or has no url", () => {
    expect(bakedFeedUrl("/x", () => { throw new Error("ENOENT"); })).toBeUndefined();
    expect(bakedFeedUrl("/x", () => "provider: generic\n")).toBeUndefined();
  });
});

describe("lockDownUpdaterSession", () => {
  it("denies permissions and cancels what the filter refuses", () => {
    let onRequest: (details: { url: string }, callback: (response: { cancel: boolean }) => void) => void = () => undefined;
    let permission: (...args: unknown[]) => unknown = () => undefined;
    let check: () => boolean = () => true;
    const session = {
      setPermissionRequestHandler: (handler: unknown) => void (permission = handler as typeof permission),
      setPermissionCheckHandler: (handler: unknown) => void (check = handler as typeof check),
      webRequest: { onBeforeRequest: (handler: unknown) => void (onRequest = handler as typeof onRequest) },
    };
    lockDownUpdaterSession(session as never, FEED);
    const granted = vi.fn();
    permission({}, "media", granted);
    expect(granted).toHaveBeenCalledWith(false);
    expect(check()).toBe(false);
    const answer = vi.fn();
    onRequest({ url: "http://evil.test/" }, answer);
    onRequest({ url: "https://updates.tokama.dev/mac/latest-mac.yml" }, answer);
    expect(answer.mock.calls).toEqual([[{ cancel: true }], [{ cancel: false }]]);
  });
});
