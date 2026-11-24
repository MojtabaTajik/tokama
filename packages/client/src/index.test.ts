import { describe, expect, it } from "vitest";
import { builtOn, packageName } from "./index.js";

describe("@tokama/client", () => {
  it("resolves @tokama/core through its package exports", () => {
    expect(packageName).toBe("@tokama/client");
    expect(builtOn).toBe("@tokama/core");
  });
});
