import { describe, expect, it } from "vitest";
import type { AboutInfo, ToolsPathInfo } from "./bridge.js";
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

  it("shows no pid and no version for an engine that is not connected, whatever the lock file says", () => {
    for (const status of ["failed", "starting", "reconnecting"]) expect(buildRows(info, status)[1]).toEqual(["Engine", status]);
    expect(buildInfoText(info, "failed")).toContain("Engine: failed\n");
  });

  it("shows no pid for a connected engine without a lock file", () => {
    const engine = { version: info.engine.version, apiVersion: info.engine.apiVersion };
    expect(buildRows({ ...info, engine }, "connected")[1]).toEqual(["Engine", "0.1.0 · running"]);
  });

  it("adds a Tools PATH line for each source, never the PATH itself", () => {
    const line = (toolsPath: ToolsPathInfo) => buildInfoText(info, "connected", toolsPath).split("\n").at(-1);
    expect(line({ source: "login-shell", shell: "zsh" })).toBe("Tools PATH: login shell (zsh)");
    expect(line({ source: "inherited" })).toBe("Tools PATH: inherited");
    expect(line({ source: "engine-running" })).toBe("Tools PATH: not read (the engine was already running)");
    expect(line({ source: "inherited", shell: "zsh", problem: "Your login shell (zsh) did not answer within 5 s." })).toBe(
      "Tools PATH: inherited (login shell failed: Your login shell (zsh) did not answer within 5 s.)",
    );
    expect(buildInfoText(info, "connected")).not.toContain("Tools PATH");
  });

  it("copies one Label: value line per row, then the platform", () => {
    expect(buildInfoText(info, "connected")).toBe(
      ["App: 0.1.0 · 2026-11-24 · 85a75e3", "Engine: 0.1.0 · running · pid 48211", "Engine API: v4", "Data folder: ~/.tokama", "Runtime: Electron 45.4.1 · Node 24.1.0", "Platform: macOS · arm64"].join("\n"),
    );
  });
});
