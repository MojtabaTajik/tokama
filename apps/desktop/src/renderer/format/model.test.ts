import { describe, expect, it } from "vitest";
import { shortModel } from "./model.js";

describe("shortModel", () => {
  it("drops the vendor prefix and the date and keeps the version", () => {
    expect(["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5", "claude-sonnet-4-5-20250929", "claude-opus-5", "claude-3-5-haiku-20241022", "claude-3-opus-20240229"].map(shortModel)).toEqual([
      "sonnet 5.5",
      "opus 5.5",
      "haiku 5.5",
      "sonnet 4.5",
      "opus 5",
      "haiku 3.5",
      "opus 3",
    ]);
  });

  it("leaves any other name as it is", () => {
    expect(["gpt-5-codex", "gpt-5", "qwen3-coder:30b", "sonnet", "opus", "claude"].map(shortModel)).toEqual(["gpt-5-codex", "gpt-5", "qwen3-coder:30b", "sonnet", "opus", "claude"]);
  });
});
