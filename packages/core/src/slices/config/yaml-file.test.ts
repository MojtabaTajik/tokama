import { describe, expect, it } from "vitest";
import { suggestion } from "./yaml-file.js";

describe("suggestion", () => {
  it("suggests a close option or a prefix", () => {
    expect(suggestion("claud-code", ["claude-code", "codex-cli", "ollama"])).toBe(" Did you mean claude-code?");
    expect(suggestion("codex", ["claude-code", "codex-cli", "ollama"])).toBe(" Did you mean codex-cli?");
    expect(suggestion("Ollama", ["claude-code", "codex-cli", "ollama"])).toBe(" Did you mean ollama?");
  });

  it("suggests nothing for a far-off value", () => {
    expect(suggestion("gemini", ["claude-code", "codex-cli", "ollama"])).toBe("");
    expect(suggestion("", ["edit"])).toBe("");
  });
});
