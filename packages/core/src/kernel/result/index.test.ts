import { describe, expect, it } from "vitest";
import { err, ok } from "./index.js";

describe("result", () => {
  it("ok and err build the two variants", () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
    expect(err("bad")).toEqual({ ok: false, error: "bad" });
  });
});
