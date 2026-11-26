import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appVersion, checkEngineVersion, compareVersions, engineManifest, feedUrlProblem, minSafeVersionProblem, releaseInfoFor } from "./package.js";

let root: string;
beforeEach(() => void (root = mkdtempSync(join(tmpdir(), "tk-package-test-"))));
afterEach(() => rmSync(root, { recursive: true, force: true }));

function folder(name: string, version: string): string {
  const dir = join(root, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
  return dir;
}

describe("feedUrlProblem", () => {
  it.each(["https://updates.tokama.dev/mac/", "https://example.test/", "https://example.test/a/b-c_d.e~f/", "https://localhost/mac/"])("accepts %s", (url) => {
    expect(feedUrlProblem(url)).toBeUndefined();
  });

  it.each([
    "http://example.test/mac/",
    "https://example.test/mac",
    "https://example.test",
    "https://../",
    "https://.example.test/",
    "https://example..test/",
    "https://example.test/../",
    "https://example.test/./mac/",
    "https://example.test/mac//",
    "https://example.test/mac/?x=1",
    "https://example.test/mac/#x",
    "https://user@example.test/mac/",
    "https://example.test:8443/mac/",
    "https://exa mple.test/",
    "https://example.test/mac/\n",
    "",
  ])("refuses %j", (url) => {
    expect(feedUrlProblem(url)).toMatch(/feed URL must be https/);
  });
});

describe("feedUrlProblem with a local feed", () => {
  it.each(["http://127.0.0.1:8765/", "http://127.0.0.1:1024/", "http://127.0.0.1:65535/"])("accepts %s only when asked", (url) => {
    expect(feedUrlProblem(url, true)).toBeUndefined();
    expect(feedUrlProblem(url)).toMatch(/feed URL must be https/);
    expect(feedUrlProblem(url, false)).toMatch(/feed URL must be https/);
  });

  it.each([
    "http://localhost/",
    "http://localhost:8765/",
    "http://127.0.0.1/",
    "http://127.0.0.1:80/",
    "http://127.0.0.1:1023/",
    "http://127.0.0.1:65536/",
    "http://127.0.0.1:08765/",
    "http://127.0.0.1:8765",
    "http://127.0.0.1:8765/mac/",
    "http://127.0.0.2:8000/",
    "http://127.0.0.1:8765/?x=1",
    "http://user@127.0.0.1:8765/",
    "https://127.0.0.1:8765/x",
    "http://0.0.0.0:8765/",
    "http://[::1]:8765/",
  ])("refuses %s even when a local feed is allowed", (url) => {
    expect(feedUrlProblem(url, true)).toMatch(/feed URL must be https/);
  });

  it("still accepts https with the flag", () => {
    expect(feedUrlProblem("https://updates.tokama.dev/mac/", true)).toBeUndefined();
  });
});

describe("compareVersions", () => {
  it("compares by number, not as text", () => {
    expect(compareVersions("0.0.10", "0.0.9")).toBeGreaterThan(0);
    expect(compareVersions("0.9.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
  });
});

describe("minSafeVersionProblem", () => {
  it("accepts a plain version up to the build's own", () => {
    expect(minSafeVersionProblem("0.0.2", "0.0.3")).toBeUndefined();
    expect(minSafeVersionProblem("0.0.3", "0.0.3")).toBeUndefined();
    expect(minSafeVersionProblem("0.2.0", "0.10.0")).toBeUndefined();
  });

  it("refuses a version above the build's own, compared by number", () => {
    expect(minSafeVersionProblem("0.0.4", "0.0.3")).toMatch(/above this build/);
    expect(minSafeVersionProblem("0.0.10", "0.0.9")).toMatch(/above this build/);
  });

  it.each(["", "1.2", "v1.2.3", "1.2.3-rc.1", "1.2.3 ", "two\nlines", "bell\u0007", `line${String.fromCharCode(0x2028)}break`, "raw break", "x".repeat(161)])("refuses %j", (value) => {
    expect(minSafeVersionProblem(value, "9.9.9")).toMatch(/plain x\.y\.z/);
  });
});

describe("releaseInfoFor", () => {
  it("sets no release info without a lowest safe version", () => {
    expect(releaseInfoFor(undefined)).toEqual({});
  });

  it("puts the lowest safe version under vendor.tokama of the release info", () => {
    expect(releaseInfoFor("0.0.2")).toEqual({ releaseInfo: { vendor: { tokama: { minSafeVersion: "0.0.2" } } } });
  });
});

describe("engineManifest", () => {
  it("holds the app's version and marks the bundle's files as ES modules", () => {
    const manifest = JSON.parse(engineManifest(appVersion(join(import.meta.dirname, "..")))) as Record<string, unknown>;
    expect(manifest).toEqual({ name: "tokama-engine", private: true, version: appVersion(join(import.meta.dirname, "..")), type: "module" });
  });
});

describe("appVersion", () => {
  it("accepts a plain x.y.z", () => {
    expect(appVersion(folder("plain", "0.1.0"))).toBe("0.1.0");
  });

  it.each(["0.1.0-alpha.1", "1.0", "v1.0.0", "1.0.0+build", ""])("refuses %j, which the engine would read back as 0.0.0", (version) => {
    expect(() => appVersion(folder(`bad-${version || "empty"}`, version))).toThrow(/plain x\.y\.z/);
  });
});

describe("checkEngineVersion", () => {
  it("passes when the engine folder has the app's version, as the manifest writes it", () => {
    const engine = join(root, "engine");
    mkdirSync(engine);
    writeFileSync(join(engine, "package.json"), engineManifest("1.4.0"));
    expect(() => checkEngineVersion(folder("app", "1.4.0"), engine)).not.toThrow();
  });

  it("throws when the engine's version is lower or higher than the app's", () => {
    const app = folder("app", "1.4.0");
    expect(() => checkEngineVersion(app, folder("older", "1.3.9"))).toThrow(/1\.3\.9.*1\.4\.0/);
    expect(() => checkEngineVersion(app, folder("newer", "1.4.1"))).toThrow(/1\.4\.1.*1\.4\.0/);
  });
});
