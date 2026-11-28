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

/** The packages in the JavaScript files of a folder, found by their paths in pnpm's store. */
function packagesIn(dir: string): PackageVersion[] {
  if (!existsSync(dir)) throw new Error(`${dir} is missing: run "pnpm build" first`);
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((file) => /\.(?:c|m)?js$/.test(file));
  expect(files.length, dir).toBeGreaterThan(0);
  return bundledPackages(files.map((file) => readFileSync(join(dir, file), "utf8")).join("\n"));
}

describe("THIRD_PARTY_NOTICES.md against the built app", () => {
  it("holds a licence text for exactly the packages built into the app, at the versions built in", async () => {
    const engine = join(scratch, "engine");
    await bundleEngine(engine);
    const dist = join(appDir, "dist");
    const built = [...packagesIn(engine), ...packagesIn(join(dist, "main")), ...packagesIn(join(dist, "preload")), ...packagesIn(join(dist, "renderer"))];
    expect(built.length).toBeGreaterThan(10);
    const noticed = noticeSections(notices);
    // On failure, `missing` is a package or version without a text, `stale` a text for a package that is not built in any more.
    expect(noticesDifference(built, noticed)).toEqual({ missing: [], stale: [] });
  }, 120_000);
});
