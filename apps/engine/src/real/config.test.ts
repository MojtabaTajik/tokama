import { describe, expect, it } from "vitest";
import { roleLine } from "./config.js";

describe("roleLine", () => {
  it("is the first line with text, trimmed", () => {
    expect(roleLine("\n  \n  You review a diff.  \nThen more.")).toBe("You review a diff.");
  });

  it("is undefined for a role with no text", () => {
    expect(roleLine(" \n\t\n")).toBeUndefined();
  });

  it("cuts a long line to the 200 characters the setup allows, ending in an ellipsis", () => {
    const line = roleLine("x".repeat(300));
    expect(line).toHaveLength(200);
    expect(line?.endsWith("…")).toBe(true);
  });
});
