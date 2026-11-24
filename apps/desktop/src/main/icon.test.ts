import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appIcons } from "./icon.js";

const build = join(import.meta.dirname, "..", "..", "build");
const read = (...path: string[]) => readFileSync(join(build, ...path));
const PNG_SIGNATURE = "89504e470d0a1a0a";

/** Width and height from a PNG's IHDR chunk; throws when the bytes are not a PNG. */
function pngSize(bytes: Buffer): [number, number] {
  expect(bytes.subarray(0, 8).toString("hex")).toBe(PNG_SIGNATURE);
  expect(bytes.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe("appIcons", () => {
  const dir = join("/app", "desktop");
  it("gives Linux its window icon as a PNG and Windows its as an .ico", () => {
    expect(appIcons("linux", dir, false)).toEqual({ window: join(dir, "build", "icon.png"), dock: undefined });
    expect(appIcons("win32", dir, false)).toEqual({ window: join(dir, "build", "icon.ico"), dock: undefined });
  });

  it("sets the dock icon on macOS in dev only, with no window icon", () => {
    expect(appIcons("darwin", dir, false)).toEqual({ window: undefined, dock: join(dir, "build", "icon.png") });
    expect(appIcons("darwin", dir, true)).toEqual({ window: undefined, dock: undefined });
  });
});

describe("the generated icon files", () => {
  it.each([16, 24, 32, 48, 64, 128, 256, 512, 1024])("has a %i px PNG", (size) => {
    expect(pngSize(read("icons", `${size}x${size}.png`))).toEqual([size, size]);
  });

  it("has icon.png at 1024 px, the same image as the 1024 px PNG", () => {
    expect(pngSize(read("icon.png"))).toEqual([1024, 1024]);
    expect(read("icon.png").equals(read("icons", "1024x1024.png"))).toBe(true);
  });

  it("has an .ico whose directory lists PNG images of 16 to 256 px", () => {
    const ico = read("icon.ico");
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1]);
    const count = ico.readUInt16LE(4);
    const sizes: number[] = [];
    for (let index = 0; index < count; index++) {
      const at = 6 + index * 16;
      const size = ico.readUInt32LE(at + 8);
      const offset = ico.readUInt32LE(at + 12);
      const [width, height] = pngSize(ico.subarray(offset, offset + size));
      expect([ico.readUInt8(at) || 256, ico.readUInt8(at + 1) || 256]).toEqual([width, height]);
      sizes.push(width);
    }
    expect(sizes).toEqual([16, 24, 32, 48, 64, 128, 256]);
  });

  it("has an .icns whose length field matches the file and whose entries are PNGs of 16 to 1024 px", () => {
    const icns = read("icon.icns");
    expect(icns.subarray(0, 4).toString("ascii")).toBe("icns");
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    const sizes: number[] = [];
    for (let at = 8; at < icns.length; ) {
      const length = icns.readUInt32BE(at + 4);
      const [width] = pngSize(icns.subarray(at + 8, at + length));
      sizes.push(width);
      at += length;
    }
    expect(Math.min(...sizes)).toBe(16);
    expect(Math.max(...sizes)).toBe(1024);
  });
});
