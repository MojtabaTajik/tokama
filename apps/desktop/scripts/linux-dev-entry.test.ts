import { describe, expect, it } from "vitest";
import { applicationsDir, devEntry } from "./linux-dev-entry.js";
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

describe("applicationsDir", () => {
  it("uses XDG_DATA_HOME when it is absolute, else ~/.local/share", () => {
    expect(applicationsDir({ XDG_DATA_HOME: "/data" }, "/home/u")).toBe("/data/applications");
    expect(applicationsDir({ XDG_DATA_HOME: "relative" }, "/home/u")).toBe("/home/u/.local/share/applications");
    expect(applicationsDir({}, "/home/u")).toBe("/home/u/.local/share/applications");
  });
});
