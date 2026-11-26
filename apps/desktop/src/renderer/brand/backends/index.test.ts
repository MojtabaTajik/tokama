import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKEND_IDS, backendOf } from "./index.js";

describe("backendOf", () => {
  // The bundler inlines the SVGs in tests, so only the URL being a distinct, non-empty string is checked.
  it("gives Claude Code and Codex an icon and a name", () => {
    const claude = backendOf("claude-code");
    const codex = backendOf("codex-cli");
    expect(claude.name).toBe("Claude Code");
    expect(codex.name).toBe("Codex CLI");
    expect(typeof claude.iconUrl === "string" && claude.iconUrl.length > 0).toBe(true);
    expect(typeof codex.iconUrl === "string" && codex.iconUrl.length > 0).toBe(true);
    expect(claude.iconUrl).not.toBe(codex.iconUrl);
  });

  it("keeps the neutral monogram for a CLI without an icon", () => {
    expect(backendOf("ollama")).toEqual({ name: "Ollama", monogram: "OL", iconUrl: undefined, iconScale: 1 });
  });

  it("lists every CLI once, so the names come from this one place", () => {
    expect([...BACKEND_IDS].sort()).toEqual(["claude-code", "codex-cli", "ollama"]);
  });
});

describe("the icon files", () => {
  const files = readdirSync(import.meta.dirname).filter((file) => file.endsWith(".svg"));

  it("are the two publisher files", () => {
    expect(files.sort()).toEqual(["claude-code.svg", "openai.svg"]);
  });

  it.each(files)("%s is a plain SVG with no script", (file) => {
    const svg = readFileSync(join(import.meta.dirname, file), "utf8");
    expect(svg).toMatch(/^<svg /);
    expect(svg).not.toMatch(/<script|on[a-z]+=/i);
  });
});
