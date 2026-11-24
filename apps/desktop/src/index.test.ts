import { describe, expect, it } from "vitest";
import { appName } from "./index.js";

describe("@tokama/desktop", () => {
  it("has a placeholder entry", () => {
    expect(appName).toBe("@tokama/desktop");
  });
});
