import { readFileSync } from "node:fs";
import { join } from "node:path";
import { version as reactVersion } from "react";
import { describe, expect, it } from "vitest";
import { notices } from "./notices.js";

describe("notices", () => {
  const file = readFileSync(join(import.meta.dirname, "..", "..", "..", "THIRD_PARTY_NOTICES.md"), "utf8");

  it("lists every part that THIRD_PARTY_NOTICES.md lists, and no other", () => {
    // The licence texts below the notices hold lines of their own that start with "## ".
    const headings = [...(file.split(/^# Licence texts$/m)[0] ?? "").matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(notices("45.4.1").map((notice) => notice.name)).toEqual(headings);
  });

  /** The body of one `## ` section of the Markdown file, above the licence texts. */
  const section = (name: string) => (file.split(/^# Licence texts$/m)[0] ?? "").split(/^## /m).find((part) => part.startsWith(`${name}\n`)) ?? "";
  const text = (id: string) => notices("45.4.1").find((notice) => notice.id === id)?.text ?? "";

  it("names every file and folder that the Markdown file puts in backticks for Electron, Chromium and Node.js", () => {
    for (const [id, name] of [["electron", "Electron"], ["chromium", "Chromium"], ["node", "Node.js"]] as const) {
      const names = [...section(name).matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
      expect(names.length, name).toBeGreaterThan(0);
      for (const entry of names) expect(text(id), `${name}: ${entry}`).toContain(entry);
    }
  });

  it("says for Node.js and the updater what the Markdown file says: macOS and Linux, and the system installs the update", () => {
    expect(section("Node.js")).toContain("macOS (arm64) and Linux (x64)");
    expect(text("node")).toContain("macOS (arm64) and Linux (x64)");
    for (const words of [section("electron-updater and its dependencies"), text("electron-updater")]) {
      expect(words).toContain("hands it to the system to install");
      expect(words).not.toContain("hands it to macOS");
    }
  });

  it("lists the dependencies of electron-updater that the Markdown file lists", () => {
    const body = section("electron-updater and its dependencies");
    const inMarkdown = [...body.matchAll(/^- (?:MIT|ISC|BlueOak-1\.0\.0): ([\s\S]*?)\.$/gm)].flatMap((match) => (match[1] ?? "").split(/,\s+/)).map((name) => name.trim());
    const listed = /main process with: (.*?)\. Licences:/.exec(text("electron-updater"))?.[1] ?? "";
    const inApp = listed.split(/,\s+|\s+and\s+/).map((name) => name.trim());
    expect(inMarkdown.length).toBeGreaterThan(10);
    expect([...inApp].sort()).toEqual([...inMarkdown].sort());
  });

  it("takes Electron's and React's versions from the running app", () => {
    const list = notices("45.4.1");
    expect(list.find((notice) => notice.id === "electron")?.version).toBe("45.4.1");
    expect(list.find((notice) => notice.id === "chromium")?.version).toBe("in Electron 45");
    expect(list.find((notice) => notice.id === "react")?.version).toBe(reactVersion);
  });

  it("names the yaml and zod versions that core depends on", () => {
    const core = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "..", "packages", "core", "package.json"), "utf8")) as { dependencies: Record<string, string> };
    const list = notices("45.4.1");
    expect(list.find((notice) => notice.id === "yaml")?.version).toBe(core.dependencies["yaml"]);
    expect(list.find((notice) => notice.id === "zod")?.version).toBe(core.dependencies["zod"]);
  });

  it("names the electron-updater version the app is built with", () => {
    const desktop = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "package.json"), "utf8")) as { devDependencies: Record<string, string> };
    expect(notices("45.4.1").find((notice) => notice.id === "electron-updater")?.version).toBe(desktop.devDependencies["electron-updater"]);
  });

  it("names the Node.js version the packaged app ships", () => {
    const pinned: unknown = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "packaging", "node-runtime.json"), "utf8"));
    expect(notices("45.4.1").find((notice) => notice.id === "node")?.version).toBe((pinned as { version: string }).version);
  });

  it("gives every notice a licence, a copyright line and a text", () => {
    for (const notice of notices("45.4.1")) expect([notice.licence, notice.copyright, notice.text].every((part) => part !== "")).toBe(true);
  });
});
