import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appVersion, checkEngineVersion, engineManifest } from "./package.js";

let root: string;
beforeEach(() => void (root = mkdtempSync(join(tmpdir(), "tk-package-test-"))));
afterEach(() => rmSync(root, { recursive: true, force: true }));

function folder(name: string, version: string): string {
  const dir = join(root, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
  return dir;
}

describe("engineManifest", () => {
  it("holds the app's version and marks the bundle's files as ES modules", () => {
    const manifest = JSON.parse(engineManifest(appVersion(join(import.meta.dirname, "..")))) as Record<string, unknown>;
    expect(manifest).toEqual({ name: "tokama-engine", private: true, version: appVersion(join(import.meta.dirname, "..")), type: "module" });
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
