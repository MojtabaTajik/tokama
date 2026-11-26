import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appVersion, checkEngineVersion, engineManifest, feedUrlProblem } from "./package.js";

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
