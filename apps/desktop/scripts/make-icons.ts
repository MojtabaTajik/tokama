// Makes the app icon files from the brand marks in src/renderer/brand (mark.svg, and the pixel
// glyphs mark-32.svg and mark-16.svg for the small sizes), so replacing the logo is a file swap
// followed by `pnpm --filter @tokama/desktop icons`. Each size is the mark on a night rounded-square
// tile: the master mark from 128 px up, the 32 px glyph at 33 to 64 px, the 16 px glyph below that,
// and at 16 px a full-bleed tile, because a tile would leave a glyph of only 8 px. The output is committed
// (Linux CI and the window icon need it) and goes to `build/`, where a packager looks:
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
/** The inside of an SVG file: its shapes, without the outer `<svg>` element. */
const inner = (file: string): string => readFileSync(join(brand, file), "utf8").replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
const master = inner("mark.svg");
// The pixel glyphs only look right with hard edges.
const glyph32 = `<g shape-rendering="crispEdges">${inner("mark-32.svg")}</g>`;
const glyph16 = `<g shape-rendering="crispEdges">${inner("mark-16.svg")}</g>`;

const NIGHT = "#0B0F17";
const TILE_EDGE = "#2A3443";

/** The app icon at `size` px as SVG: the tile and the mark that belongs to that size. */
function iconSvg(size: number): string {
  const open = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"`;
  if (size >= 128) {
    // Tile and mark on the 1024 grid; the mark's 64 unit box sits at 256 to 768.
    return `${open} viewBox="0 0 1024 1024"><rect x="100" y="100" width="824" height="824" rx="185" fill="${NIGHT}" stroke="${TILE_EDGE}" stroke-width="6"/><g transform="translate(256 256) scale(8)">${master}</g></svg>`;
  }
  // A pixel glyph is `glyphSize` units wide; the tile is 0.8125 of the icon, the glyph half of it.
  const glyphSize = size > 32 ? 32 : 16;
  const glyph = glyphSize === 32 ? glyph32 : glyph16;
  if (size === 16) {
    return `${open} viewBox="0 0 16 16"><rect width="16" height="16" rx="3.5" fill="${NIGHT}"/>${glyph}</svg>`;
  }
  const inset = (size * 3) / 32;
  const scale = size / 2 / glyphSize;
  return `${open} viewBox="0 0 ${size} ${size}"><rect x="${inset}" y="${inset}" width="${size - 2 * inset}" height="${size - 2 * inset}" rx="${(size * 3) / 16}" fill="${NIGHT}"/><g transform="translate(${size / 4} ${size / 4}) scale(${scale})">${glyph}</g></svg>`;
}

const png = new Map<number, Buffer>(SIZES.map((size) => [size, Buffer.from(new Resvg(iconSvg(size), { font: { loadSystemFonts: false } }).render().asPng())]));
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
