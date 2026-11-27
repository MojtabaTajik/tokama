import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appDir = resolve(import.meta.dirname, "..");
const repoDir = resolve(appDir, "..", "..");
const notices = readFileSync(join(appDir, "THIRD_PARTY_NOTICES.md"), "utf8");

/** Packages that ship no licence file at all; their entry says so instead of quoting a text. */
const WITHOUT_LICENCE_FILE = ["lazy-val"];

/** The licence texts: `### <package> <version>` and then a fenced block, or a plain line for a package without a licence file. */
function sections(): Array<{ name: string; version: string; text: string | undefined }> {
  const texts = notices.slice(notices.indexOf("\n# Licence texts\n"));
  return [...texts.matchAll(/^### (\S+) (\S+)\n\n(?:```text\n([\s\S]*?)\n```|(.+))$/gm)].map((match) => ({ name: match[1] ?? "", version: match[2] ?? "", text: match[3] }));
}

/** The licence file of one installed package, found in pnpm's store by name and exact version. */
function licenceOf(name: string, version: string): string {
  const store = join(repoDir, "node_modules", ".pnpm");
  const folder = readdirSync(store).find((entry) => entry === `${name}@${version}` || entry.startsWith(`${name}@${version}_`));
  if (folder === undefined) throw new Error(`${name}@${version} is not installed`);
  const dir = join(store, folder, "node_modules", name);
  const file = readdirSync(dir).find((entry) => /^licen[cs]e(\.md)?$/i.test(entry));
  if (file === undefined) throw new Error(`${name}@${version} has no licence file`);
  return readFileSync(join(dir, file), "utf8");
}

describe("THIRD_PARTY_NOTICES.md", () => {
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
