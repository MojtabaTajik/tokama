import { describe, expect, it } from "vitest";
import { appName, hosts } from "./index.js";

describe("@tokama/engine", () => {
  it("imports @tokama/core", () => {
    expect(appName).toBe("@tokama/engine");
    expect(hosts).toBe("@tokama/core");
  });
});
