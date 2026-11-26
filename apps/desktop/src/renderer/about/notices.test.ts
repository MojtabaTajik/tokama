import { readFileSync } from "node:fs";
import { join } from "node:path";
import { version as reactVersion } from "react";
import { describe, expect, it } from "vitest";
import { notices } from "./notices.js";

describe("notices", () => {
  const file = readFileSync(join(import.meta.dirname, "..", "..", "..", "THIRD_PARTY_NOTICES.md"), "utf8");

  it("lists every part that THIRD_PARTY_NOTICES.md lists, and no other", () => {
    const headings = [...file.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(notices("45.4.1").map((notice) => notice.name)).toEqual(headings);
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
