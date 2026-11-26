import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SOUND_NAMES } from "../../shared/desktop-state.js";
import { soundFileName, soundsDir } from "./files.js";

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
