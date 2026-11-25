import { describe, expect, it } from "vitest";
import type { AboutInfo } from "./bridge.js";
import { buildInfoText, buildRows } from "./build-info.js";

const info: AboutInfo = {
  app: { version: "0.1.0", built: "2026-11-24", commit: "85a75e3" },
  engine: { version: "0.1.0", apiVersion: 4, pid: 48211 },
  dataFolder: "~/.tokama",
  runtime: { electron: "45.4.1", node: "24.1.0" },
  platform: "macOS · arm64",
};

describe("build info", () => {
  it("names the engine as running when it is connected", () => {
    expect(buildRows(info, "connected")[1]).toEqual(["Engine", "0.1.0 · running · pid 48211"]);
  });

  it("shows the connection's own status otherwise, and no pid without a lock file", () => {
    const engine = { version: info.engine.version, apiVersion: info.engine.apiVersion };
    expect(buildRows({ ...info, engine }, "failed")[1]).toEqual(["Engine", "0.1.0 · failed"]);
  });

  it("copies one Label: value line per row, then the platform", () => {
    expect(buildInfoText(info, "connected")).toBe(
      ["App: 0.1.0 · 2026-11-24 · 85a75e3", "Engine: 0.1.0 · running · pid 48211", "Engine API: v4", "Data folder: ~/.tokama", "Runtime: Electron 45.4.1 · Node 24.1.0", "Platform: macOS · arm64"].join("\n"),
    );
  });
});
