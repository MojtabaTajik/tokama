import { describe, expect, it } from "vitest";
import { hostedRepo, overSsh, recordableRemote, withoutUserInfo } from "./remote.js";

describe("recordableRemote", () => {
  it("keeps network URLs, without a password or an HTTPS user", () => {
    expect(recordableRemote("https://github.com/acme/orders-api.git")).toBe("https://github.com/acme/orders-api.git");
    expect(recordableRemote("https://x-access-token:ghp_secret@github.com/acme/orders-api")).toBe("https://github.com/acme/orders-api");
    expect(recordableRemote("https://ghp_secret@github.com/acme/orders-api")).toBe("https://github.com/acme/orders-api");
    expect(recordableRemote("ssh://git:pw@github.com:22/acme/orders-api.git")).toBe("ssh://git@github.com:22/acme/orders-api.git");
    expect(recordableRemote("git@github.com:acme/orders-api.git")).toBe("git@github.com:acme/orders-api.git");
  });

  it("refuses URLs that can read as another host: a fragment, a query, a backslash, a second @", () => {
    for (const url of [
      "https://evil.example#@github.com/acme/orders-api.git",
      "https://127.0.0.1:9999?@github.com/acme/orders-api.git",
      "https://evil.example\\@github.com/acme/orders-api.git",
      "https://a@evil.example@github.com/acme/orders-api.git",
      "git@evil@github.com:acme/orders-api.git",
      "https://github.com/acme/orders-api.git#main",
    ]) {
      expect(recordableRemote(url), url).toBeUndefined();
    }
  });

  it("reads host, port and path as a URL parser does, so equal targets compare equal", () => {
    expect(recordableRemote("https://GitHub.com/acme/orders-api.git")).toBe("https://github.com/acme/orders-api.git");
    expect(recordableRemote("https://github.com:443/acme/orders-api.git")).toBe("https://github.com/acme/orders-api.git");
    expect(recordableRemote("https://github.com:8443/acme/orders-api.git")).toBe("https://github.com:8443/acme/orders-api.git");
    expect(recordableRemote("git@GitHub.com:acme/orders-api.git")).toBe("git@github.com:acme/orders-api.git");
  });

  it("refuses local paths, file URLs, transport helpers and odd text", () => {
    for (const url of ["/srv/git/orders-api.git", "./orders-api", "../x", "file:///srv/x.git", "ext::sh -c touch% /tmp/x", "fd::3", "-uhelp", "", "https://a b", "C:/repo"]) {
      expect(recordableRemote(url), url).toBeUndefined();
    }
  });
});

describe("hostedRepo", () => {
  it("reads host, owner and repo", () => {
    expect(hostedRepo("https://github.com/acme/orders-api.git")).toEqual({ host: "github.com", owner: "acme", name: "orders-api" });
    expect(hostedRepo("git@GitHub.com:acme/orders-api.git")).toEqual({ host: "github.com", owner: "acme", name: "orders-api" });
    expect(hostedRepo("ssh://git@ghe.example.com:2222/acme/orders-api")).toEqual({ host: "ghe.example.com", owner: "acme", name: "orders-api" });
  });

  it("refuses paths that are not owner/repo", () => {
    expect(hostedRepo("https://gitlab.com/group/sub/repo.git")).toBeUndefined();
    expect(hostedRepo("https://github.com/acme")).toBeUndefined();
    expect(hostedRepo("https://github.com/acme/../x")).toBeUndefined();
    expect(hostedRepo("https://github.com/../x")).toBeUndefined();
  });
});

it("overSsh: ssh URLs and scp-like addresses, not HTTPS or local paths", () => {
  for (const url of ["git@github.com:acme/x.git", "ssh://git@github.com/acme/x", "git+ssh://github.com/acme/x"]) expect(overSsh(url), url).toBe(true);
  for (const url of ["https://github.com/acme/x.git", "/srv/x.git", "file:///srv/x.git"]) expect(overSsh(url), url).toBe(false);
});

it("withoutUserInfo removes credentials from every URL in a message", () => {
  expect(withoutUserInfo("fatal: unable to access 'https://user:tok@github.com/a/b/': 403")).toBe("fatal: unable to access 'https://github.com/a/b/': 403");
});
