import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { devServerUrl, isAppUrl, secureWebPreferences } from "./policy.js";

describe("secureWebPreferences", () => {
  it("isolates and sandboxes the renderer, with no Node", () => {
    expect(secureWebPreferences("/app/preload/index.cjs")).toMatchObject({
      preload: "/app/preload/index.cjs",
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    });
  });
});

describe("devServerUrl", () => {
  it("accepts an http loopback URL in an unpackaged app only", () => {
    expect(devServerUrl("http://localhost:5173/", false)?.host).toBe("localhost:5173");
    expect(devServerUrl("http://127.0.0.1:5173/", false)?.host).toBe("127.0.0.1:5173");
    expect(devServerUrl("http://localhost:5173/", true)).toBeUndefined();
    expect(devServerUrl(undefined, false)).toBeUndefined();
  });

  it("refuses remote hosts, other schemes and garbage", () => {
    for (const value of ["http://example.com/", "https://localhost:5173/", "file:///tmp/index.html", "not a url"]) {
      expect(devServerUrl(value, false), value).toBeUndefined();
    }
  });
});

describe("isAppUrl", () => {
  const rendererDir = "/app/dist/renderer";
  const file = (path: string) => pathToFileURL(path).href;

  it("allows built renderer files only, without a dev server", () => {
    expect(isAppUrl(file("/app/dist/renderer/index.html"), rendererDir, undefined)).toBe(true);
    expect(isAppUrl(file("/app/dist/renderer/assets/mark.svg"), rendererDir, undefined)).toBe(true);
    expect(isAppUrl(file("/app/dist/main/index.js"), rendererDir, undefined)).toBe(false);
    expect(isAppUrl(`${file(rendererDir)}/../../secret`, rendererDir, undefined)).toBe(false);
    expect(isAppUrl(file("/etc/passwd"), rendererDir, undefined)).toBe(false);
  });

  it("refuses remote content", () => {
    for (const url of ["https://example.com/x.js", "http://localhost:5173/", "data:text/html,hi", "javascript:alert(1)", "nope"]) {
      expect(isAppUrl(url, rendererDir, undefined), url).toBe(false);
    }
  });

  it("allows only the dev server (http and ws) when there is one", () => {
    const dev = new URL("http://localhost:5173/");
    expect(isAppUrl("http://localhost:5173/src/main.tsx", rendererDir, dev)).toBe(true);
    expect(isAppUrl("ws://localhost:5173/?token=x", rendererDir, dev)).toBe(true);
    expect(isAppUrl("http://localhost:5174/", rendererDir, dev)).toBe(false);
    expect(isAppUrl("https://example.com/", rendererDir, dev)).toBe(false);
    expect(isAppUrl(file("/app/dist/renderer/index.html"), rendererDir, dev)).toBe(false);
  });

  it("allows DevTools pages", () => {
    expect(isAppUrl("devtools://devtools/bundled/devtools_app.html", rendererDir, undefined)).toBe(true);
  });
});

describe("renderer Content-Security-Policy", () => {
  const html = readFileSync(join(import.meta.dirname, "..", "renderer", "index.html"), "utf8");
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? "";
  const directives = new Map(
    csp
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .map(([name = "", ...values]) => [name, values]),
  );

  it("denies by default and allows only the app's own files", () => {
    expect(directives.get("default-src")).toEqual(["'none'"]);
    for (const name of ["script-src", "style-src", "img-src", "font-src", "connect-src"]) {
      expect(directives.get(name), name).toEqual(["'self'"]);
    }
    expect(directives.get("object-src")).toEqual(["'none'"]);
    expect(directives.get("base-uri")).toEqual(["'none'"]);
  });

  it("allows no inline code, eval or remote hosts", () => {
    expect(csp).not.toMatch(/unsafe-|https?:|data:|blob:|\*/);
  });
});
