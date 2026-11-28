import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applicationsDir, devEntry, isSymlink } from "./linux-dev-entry.js";
import { parseDesktopEntry } from "./verify-package-linux.js";

describe("devEntry", () => {
  const entry = parseDesktopEntry(devEntry("/work/tokama/apps/desktop/build/icons/512x512.png"));

  it("matches the dev window: its app_id is the desktop name without .desktop", () => {
    expect(entry.get("StartupWMClass")).toBe("tokama-dev");
  });

  it("shows the checkout's PNG, starts nothing and stays out of the app grid", () => {
    expect(entry.get("Icon")).toBe("/work/tokama/apps/desktop/build/icons/512x512.png");
    expect(entry.get("Exec")).toBe("true");
    expect(entry.get("NoDisplay")).toBe("true");
    expect(entry.get("Type")).toBe("Application");
  });
});

describe("devEntry paths", () => {
  it.each([["a backslash", "/work/a\\b.png"], ["a newline", "/work/a\nExec=evil.png"]])("refuses an icon path with %s", (_name, path) => {
    expect(() => devEntry(path)).toThrow(/backslash or a control character/);
  });
});

describe("isSymlink", () => {
  it("is true for a symbolic link, false for a file and for a missing path", () => {
    const dir = mkdtempSync(join(tmpdir(), "tk-dev-entry-"));
    try {
      writeFileSync(join(dir, "real"), "");
      symlinkSync(join(dir, "real"), join(dir, "link"));
      expect(isSymlink(join(dir, "link"))).toBe(true);
      expect(isSymlink(join(dir, "real"))).toBe(false);
      expect(isSymlink(join(dir, "none"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("applicationsDir", () => {
  it("uses XDG_DATA_HOME when it is absolute, else ~/.local/share", () => {
    expect(applicationsDir({ XDG_DATA_HOME: "/data" }, "/home/u")).toBe("/data/applications");
    expect(applicationsDir({ XDG_DATA_HOME: "relative" }, "/home/u")).toBe("/home/u/.local/share/applications");
    expect(applicationsDir({}, "/home/u")).toBe("/home/u/.local/share/applications");
  });
});
