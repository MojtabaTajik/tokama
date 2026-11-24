import { describe, expect, it } from "vitest";
import { builtOn, packageName } from "./index.js";

describe("@tokama/client", () => {
  it("imports @tokama/core", () => {
    expect(packageName).toBe("@tokama/client");
    expect(builtOn).toBe("@tokama/core");
  });
});
