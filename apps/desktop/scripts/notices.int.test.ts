import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleEngine } from "../../engine/scripts/bundle.js";
import { bundledPackages, noticeSections, noticesDifference, type PackageVersion } from "./notices-check.js";

const appDir = resolve(import.meta.dirname, "..");
const notices = readFileSync(join(appDir, "THIRD_PARTY_NOTICES.md"), "utf8");

let scratch: string;
beforeAll(() => void (scratch = mkdtempSync(join(tmpdir(), "tk-notices-"))));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/**
 * The packages in the JavaScript files of a folder, found by their paths in pnpm's store. Each file
 * of `mustHold` has to give at least one package: a bundle that stops marking where its code comes
 * from would otherwise pass with no packages at all.
 */
function packagesIn(dir: string, mustHold: readonly string[]): PackageVersion[] {
  if (!existsSync(dir)) throw new Error(`${dir} is missing: run "pnpm build" first`);
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((file) => /\.(?:c|m)?js$/.test(file));
  for (const file of mustHold) expect(files, dir).toContain(file);
  const found = files.map((file) => ({ file, packages: bundledPackages(readFileSync(join(dir, file), "utf8")) }));
  for (const { file, packages } of found) if (mustHold.includes(file)) expect(packages.length, `${join(dir, file)} names no package: does the bundle still mark where its code comes from?`).toBeGreaterThan(0);
  return found.flatMap(({ packages }) => packages);
}

describe("THIRD_PARTY_NOTICES.md against the built app", () => {
  it("holds a licence text for exactly the packages built into the app, at the versions built in", async () => {
    const engine = join(scratch, "engine");
    await bundleEngine(engine);
    const dist = join(appDir, "dist");
    // The preload script holds no package. The renderer's file name carries a hash, so it is found by its folder.
    const renderer = join(dist, "renderer", "assets");
    const rendererFile = existsSync(renderer) ? readdirSync(renderer).find((file) => /^index-.*\.js$/.test(file)) : undefined;
    const built = [
      ...packagesIn(engine, ["main.js", "hook.js"]),
      ...packagesIn(join(dist, "main"), ["index.js"]),
      ...packagesIn(join(dist, "preload"), []),
      ...packagesIn(renderer, rendererFile === undefined ? ["index-<hash>.js"] : [rendererFile]),
    ];
    expect(built.length).toBeGreaterThan(10);
    const noticed = noticeSections(notices);
    // On failure, `missing` is a package or version without a text, `stale` a text for a package that is not built in any more.
    expect(noticesDifference(built, noticed)).toEqual({ missing: [], stale: [] });
  }, 120_000);
});
