import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { errnoCode, hasCode } from "./index.js";

describe("errnoCode", () => {
  it("reads the code of a real system error", () => {
    const dir = mkdtempSync(join(tmpdir(), "tokama-errno-"));
    try {
      let thrown: unknown;
      try {
        readFileSync(join(dir, "missing"));
      } catch (error) {
        thrown = error;
      }
      expect(errnoCode(thrown)).toBe("ENOENT");
      expect(hasCode(thrown, "ENOENT")).toBe(true);
      expect(hasCode(thrown, "EEXIST")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is undefined for values without a string code", () => {
    for (const value of [undefined, null, "ENOENT", 2, new Error("plain"), { code: 1 }, { code: undefined }]) {
      expect(errnoCode(value)).toBeUndefined();
      expect(hasCode(value, "ENOENT")).toBe(false);
    }
    expect(errnoCode({ code: "EPERM" })).toBe("EPERM");
  });
});
