import { describe, expect, it } from "vitest";
import { compareVersions } from "./index.js";

describe("compareVersions", () => {
  it("orders versions by number, not by text", () => {
    expect(compareVersions("2.1.331", "2.1.331")).toBe(0);
    expect(compareVersions("2.1.40", "2.1.331")).toBeLessThan(0);
    expect(compareVersions("2.10.0", "2.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.172.0", "0.171.9")).toBeGreaterThan(0);
  });
});
