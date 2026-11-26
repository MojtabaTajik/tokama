import { describe, expect, it } from "vitest";
import { criticalOf, IMPORTANT_REASON, minSafeVersionOf } from "./critical.js";

describe("criticalOf", () => {
  it("is important when the app is below the feed's minSafeVersion, with the fixed reason", () => {
    expect(criticalOf("0.2.0", "0.1.0")).toEqual({ reason: IMPORTANT_REASON });
    expect(criticalOf("0.10.0", "0.9.9")).toEqual({ reason: IMPORTANT_REASON });
  });

  it("is not important at or above it", () => {
    expect(criticalOf("0.2.0", "0.2.0")).toBeUndefined();
    expect(criticalOf("0.2.0", "0.3.0")).toBeUndefined();
  });

  it("is not important for a development build", () => {
    expect(criticalOf("0.2.0", "0.0.0")).toBeUndefined();
  });

  it.each([undefined, null, 2, {}, "", "0.2", "v0.2.0", "0.2.0-beta", "1.2.3.4", "0.2.0\n"])("is not important for the feed value %j", (value) => {
    expect(criticalOf(value, "0.1.0")).toBeUndefined();
  });

  it("never takes text from the feed", () => {
    expect(JSON.stringify(criticalOf("0.2.0", "0.1.0"))).not.toContain("0.2.0");
  });
});

describe("minSafeVersionOf", () => {
  it("accepts only a plain x.y.z", () => {
    expect(minSafeVersionOf("1.2.3")).toBe("1.2.3");
    expect(minSafeVersionOf("1.2")).toBeUndefined();
    expect(minSafeVersionOf(123)).toBeUndefined();
  });
});
