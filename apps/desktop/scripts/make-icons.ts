// Makes the app icon files from the icon art in src/renderer/brand, so replacing the icon is a file
// swap followed by `pnpm --filter @tokama/desktop icons`. Each icon file is a whole icon (tile and
// head) on the 1024 unit grid, drawn by hand for a range of sizes: icon-512.svg (full art) for 128 px
// and up, icon-64.svg (reduced, no scales) for 48 and 64 px, icon-32.svg (flat) for 24 and 32 px, and
// icon-16.svg (flat, the tile fills the canvas) for 16 px. The art is rendered at the output size, never
// scaled from a larger PNG. The output is committed (Linux CI and the window icon need it) and goes to
// `build/`, where a packager looks:
//   build/icon.png            1024 px, the dock icon in dev
//   build/icon.icns           macOS, PNG entries 16 to 1024 px
//   build/icon.ico            Windows, PNG entries 16 to 256 px
//   build/icons/<n>x<n>.png   every size, 16 to 1024 px
// Nothing here needs a macOS tool, and the same input gives the same bytes.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const appDir = join(import.meta.dirname, "..");
const build = join(appDir, "build");

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024] as const;
/** `.ico` entries: a size of 256 is stored as 0 in the directory; larger sizes do not fit. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256] as const;
/** `.icns` entry types and the pixel size each holds (the @2x types hold twice the nominal size). */
const ICNS_TYPES = [
  ["icp4", 16],
  ["icp5", 32],
  ["icp6", 64],
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
  ["ic11", 32],
  ["ic12", 64],
  ["ic13", 256],
  ["ic14", 512],
] as const;

const brand = join(appDir, "src", "renderer", "brand");
/** The icon art that is drawn for `size` px. */
const artFile = (size: number): string => (size >= 128 ? "icon-512.svg" : size >= 48 ? "icon-64.svg" : size >= 24 ? "icon-32.svg" : "icon-16.svg");

// The art has no text, so no fonts are loaded; the output must not depend on the machine.
const png = new Map<number, Buffer>(
  SIZES.map((size) => [
    size,
    Buffer.from(new Resvg(readFileSync(join(brand, artFile(size)), "utf8"), { fitTo: { mode: "width", value: size }, font: { loadSystemFonts: false } }).render().asPng()),
  ]),
);
const pngOf = (size: number): Buffer => {
  const found = png.get(size);
  if (found === undefined) throw new Error(`no ${size} px render`);
  return found;
};

function ico(): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(ICO_SIZES.length, 4);
  const directory = Buffer.alloc(16 * ICO_SIZES.length);
  let offset = header.length + directory.length;
  ICO_SIZES.forEach((size, index) => {
    const data = pngOf(size);
    const at = index * 16;
    directory.writeUInt8(size === 256 ? 0 : size, at);
    directory.writeUInt8(size === 256 ? 0 : size, at + 1);
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, directory, ...ICO_SIZES.map(pngOf)]);
}

function icns(): Buffer {
  const entries = ICNS_TYPES.map(([type, size]) => {
    const data = pngOf(size);
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([head, data]);
  });
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(8 + entries.reduce((sum, entry) => sum + entry.length, 0), 4);
  return Buffer.concat([head, ...entries]);
}

mkdirSync(join(build, "icons"), { recursive: true });
for (const size of SIZES) writeFileSync(join(build, "icons", `${size}x${size}.png`), pngOf(size));
writeFileSync(join(build, "icon.png"), pngOf(1024));
writeFileSync(join(build, "icon.icns"), icns());
writeFileSync(join(build, "icon.ico"), ico());
process.stdout.write(`wrote ${SIZES.length} PNGs, icon.png, icon.icns and icon.ico to ${build}\n`);
