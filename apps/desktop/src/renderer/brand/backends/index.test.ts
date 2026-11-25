import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { backendOf } from "./index.js";

describe("backendOf", () => {
  it("gives Claude Code and Codex an icon and a name", () => {
    expect(backendOf("claude-code")).toMatchObject({ name: "Claude Code", iconUrl: expect.stringContaining("claude-code") });
    expect(backendOf("codex-cli")).toMatchObject({ name: "Codex CLI", iconUrl: expect.stringContaining("openai") });
  });

  it("keeps the neutral monogram for a CLI without an icon", () => {
    expect(backendOf("ollama")).toEqual({ name: "Ollama", monogram: "OL", iconUrl: undefined });
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
