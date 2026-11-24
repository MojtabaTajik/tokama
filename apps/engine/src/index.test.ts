import { describe, expect, it } from "vitest";
import { appName, hosts } from "./index.js";

describe("@tokama/engine", () => {
  it("resolves @tokama/core through its package exports", () => {
    expect(appName).toBe("@tokama/engine");
    expect(hosts).toBe("@tokama/core");
  });
});
