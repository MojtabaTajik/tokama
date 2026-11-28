import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SOUND_NAMES } from "../../shared/desktop-state.js";
import { fileUnder, soundFileName, soundsDir } from "./files.js";

describe("fileUnder", () => {
  it("returns the real path of a file inside the root, and nothing for a missing file, the root itself or a link that leaves the root", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "tokama-theme-")));
    try {
      const root = join(base, "theme");
      mkdirSync(root);
      writeFileSync(join(root, "a.oga"), "x");
      writeFileSync(join(base, "outside.oga"), "x");
      symlinkSync(join(base, "outside.oga"), join(root, "out.oga"));
      symlinkSync(join(root, "a.oga"), join(root, "in.oga"));
      expect(fileUnder(root, join(root, "a.oga"))).toBe(join(root, "a.oga"));
      expect(fileUnder(root, join(root, "in.oga"))).toBe(join(root, "a.oga"));
      expect(fileUnder(root, join(root, "out.oga"))).toBeUndefined();
      expect(fileUnder(root, join(root, "missing.oga"))).toBeUndefined();
      expect(fileUnder(root, root)).toBeUndefined();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("soundFileName", () => {
  it("prefixes the name in a packaged app only", () => {
    expect(soundFileName("needsYou", true)).toBe("tokama-needs-you.wav");
    expect(soundFileName("tokayCall", true)).toBe("tokama-tokay-call.wav");
    expect(soundFileName("failed", false)).toBe("failed.wav");
  });
});

describe("soundsDir", () => {
  it("is the resources folder when packaged and the brand folder in development", () => {
    expect(soundsDir({ packaged: true, resourcesPath: "/r", appPath: "/a" })).toBe("/r");
    expect(soundsDir({ packaged: false, resourcesPath: "/r", appPath: "/a" })).toBe(join("/a", "src", "renderer", "brand", "sounds"));
  });

  it("finds every development file in the repo", () => {
    const appPath = join(import.meta.dirname, "..", "..", "..");
    for (const name of SOUND_NAMES) expect(existsSync(join(soundsDir({ packaged: false, resourcesPath: "", appPath }), soundFileName(name, false)))).toBe(true);
  });
});
