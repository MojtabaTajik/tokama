import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bundledPackages, noticeSections, noticesDifference, pnpmFolder } from "./notices-check.js";

const appDir = resolve(import.meta.dirname, "..");
const repoDir = resolve(appDir, "..", "..");
const notices = readFileSync(join(appDir, "THIRD_PARTY_NOTICES.md"), "utf8");

/** Packages that ship no licence file at all; their entry says so instead of quoting a text. */
const WITHOUT_LICENCE_FILE = ["lazy-val"];

const sections = () => noticeSections(notices);

/** The licence file of one installed package, found in pnpm's store by name and exact version. */
function licenceOf(name: string, version: string): string {
  const store = join(repoDir, "node_modules", ".pnpm");
  const wanted = pnpmFolder({ name, version });
  const folder = readdirSync(store).find((entry) => entry === wanted || entry.startsWith(`${wanted}_`));
  if (folder === undefined) throw new Error(`${name}@${version} is not installed`);
  const dir = join(store, folder, "node_modules", name);
  const file = readdirSync(dir).find((entry) => /^licen[cs]e(\.md)?$/i.test(entry));
  if (file === undefined) throw new Error(`${name}@${version} has no licence file`);
  return readFileSync(join(dir, file), "utf8");
}

describe("bundledPackages", () => {
  it("reads a package and its version from each path in pnpm's store, with or without a peer suffix, and a scoped one with its scope", () => {
    const code = [
      "//#region ../../node_modules/.pnpm/react@19.3.1/node_modules/react/index.js",
      "//#region ../../node_modules/.pnpm/electron-updater@6.8.12_supports-color@7.2.0/node_modules/electron-updater/out/main.js",
      "//#region ../../node_modules/.pnpm/@scope+tool@2.0.0-beta.1_react@19.3.1/node_modules/@scope/tool/index.js",
      "//#region ../../node_modules/.pnpm/react@19.3.1/node_modules/react/jsx-runtime.js",
      "//#region ../../node_modules/.pnpm/react@18.0.0/node_modules/react/index.js",
    ].join("\n");
    expect(bundledPackages(code)).toEqual([
      { name: "@scope/tool", version: "2.0.0-beta.1" },
      { name: "electron-updater", version: "6.8.12" },
      { name: "react", version: "18.0.0" },
      { name: "react", version: "19.3.1" },
    ]);
  });

  it("finds nothing in code that holds no path from the store", () => {
    expect(bundledPackages("const a = 1;\n// the .pnpm folder")).toEqual([]);
  });
});

describe("pnpmFolder", () => {
  it("writes a scoped package with a plus for its slash", () => {
    expect(pnpmFolder({ name: "@scope/tool", version: "1.2.3" })).toBe("@scope+tool@1.2.3");
    expect(pnpmFolder({ name: "react", version: "19.3.1" })).toBe("react@19.3.1");
  });
});

describe("noticesDifference", () => {
  const noticed = [{ name: "react", version: "19.3.1" }, { name: "@scope/tool", version: "1.0.0" }];

  it("is empty when the bundle and the notices hold the same packages", () => {
    expect(noticesDifference([...noticed].reverse(), noticed)).toEqual({ missing: [], stale: [] });
  });

  it("names a package that moved to a new version while the old one stays installed for another package, and a new transitive package", () => {
    const bundled = [{ name: "react", version: "19.4.0" }, { name: "@scope/tool", version: "1.0.0" }, { name: "left-pad", version: "1.3.0" }];
    expect(noticesDifference(bundled, noticed)).toEqual({ missing: ["left-pad 1.3.0", "react 19.4.0"], stale: ["react 19.3.1"] });
  });

  it("names a scoped package that the notices lack", () => {
    expect(noticesDifference([{ name: "@scope/tool", version: "1.0.0" }], [])).toEqual({ missing: ["@scope/tool 1.0.0"], stale: [] });
  });
});

describe("THIRD_PARTY_NOTICES.md", () => {
  it("is not given packages outside the bundles: the desktop package.json has no runtime dependencies", () => {
    const desktop = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")) as { dependencies?: unknown };
    expect(desktop.dependencies).toBeUndefined();
  });

  it("names the licence files that Electron, Chromium and Node.js ship next to the app", () => {
    for (const file of ["`LICENSE-electron`", "`LICENSES.chromium.html`", "`engine/LICENSE-node`"]) expect(notices, file).toContain(file);
  });

  it("describes the Node.js binary and the update step for Linux as well as macOS", () => {
    const section = (title: string) => notices.slice(notices.indexOf(`## ${title}\n`)).split("\n## ")[0] ?? "";
    expect(section("Node.js")).toMatch(/macOS \(arm64\) and Linux \(x64\)/);
    expect(section("electron-updater and its dependencies")).not.toMatch(/hands it to macOS/);
  });

  it("is shipped as an app resource by electron-builder.yml", () => {
    const config = readFileSync(join(appDir, "electron-builder.yml"), "utf8");
    expect(config).toMatch(/^ {2}- from: THIRD_PARTY_NOTICES\.md\n {4}to: THIRD_PARTY_NOTICES\.md$/m);
  });

  it("holds the full licence text of every package it names, equal to the package's own file", () => {
    const found = sections();
    expect(found).toHaveLength([...notices.matchAll(/^### /gm)].length);
    expect(found.length).toBeGreaterThan(0);
    for (const { name, version, text } of found) {
      if (WITHOUT_LICENCE_FILE.includes(name)) {
        expect(text, name).toBeUndefined();
        continue;
      }
      expect(text, name).toBeDefined();
      expect(text?.trimEnd(), `${name} ${version}`).toBe(licenceOf(name, version).trimEnd());
    }
  });

  it("has a text for each package built into the app that the notices list", () => {
    const listed = [...notices.matchAll(/^- (?:MIT|ISC|BlueOak-1\.0\.0): ([\s\S]*?)\.$/gm)].flatMap((match) => (match[1] ?? "").split(/,\s+/));
    const wanted = ["react", "react-dom", "scheduler", "lucide-react", "electron-updater", "yaml", "zod", ...listed.map((name) => name.trim())];
    expect(listed.length).toBeGreaterThan(10);
    const named = sections().map((section) => section.name);
    expect(wanted.filter((name) => !named.includes(name))).toEqual([]);
  });
});
