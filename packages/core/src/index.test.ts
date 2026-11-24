import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@tokama/core", () => {
  it("exposes its public entry", () => {
    expect(packageName).toBe("@tokama/core");
  });
});
