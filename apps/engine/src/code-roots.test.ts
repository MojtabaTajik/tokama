import { redactText } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { engineCodeRoots } from "./code-roots.js";

const none = { paths: [], repoNames: [] };

describe("engineCodeRoots", () => {
  it("is the engine folder in an app bundle", () => {
    expect(engineCodeRoots("/A/Tokama.app/Contents/Resources/engine/dist", () => false)).toEqual(["/A/Tokama.app/Contents/Resources/engine"]);
  });

  it("is the checkout when the entry sits at apps/engine/dist of one", () => {
    expect(engineCodeRoots("/c/apps/engine/dist", (path) => path === "/c/pnpm-workspace.yaml")).toEqual(["/c"]);
  });

  it("is the engine folder when a bundle sits inside a checkout", () => {
    const dir = "/c/apps/desktop/release/mac-arm64/Tokama.app/Contents/Resources/engine/dist";
    expect(engineCodeRoots(dir, (path) => path === "/c/pnpm-workspace.yaml")).toEqual(["/c/apps/desktop/release/mac-arm64/Tokama.app/Contents/Resources/engine"]);
  });

  it("is the engine folder when the layout looks like a checkout but has no workspace file", () => {
    expect(engineCodeRoots("/c/apps/engine/dist", () => false)).toEqual(["/c/apps/engine"]);
  });

  it("lets diagnostics name the bundle's own file in a stack", () => {
    const codeRoots = engineCodeRoots("/A/Tokama.app/Contents/Resources/engine/dist", () => false);
    expect(redactText("at run (/A/Tokama.app/Contents/Resources/engine/dist/main.js:1:2)", { ...none, codeRoots })).toBe("at run (<app>/dist/main.js:1:2)");
  });
});
