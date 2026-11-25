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
    // The engine runs on the node found on PATH, not on Electron's own.
    expect(list.find((notice) => notice.id === "node")?.version).not.toContain("Electron");
  });

  it("gives every notice a licence, a copyright line and a text", () => {
    for (const notice of notices("45.4.1")) expect([notice.licence, notice.copyright, notice.text].every((part) => part !== "")).toBe(true);
  });
});
