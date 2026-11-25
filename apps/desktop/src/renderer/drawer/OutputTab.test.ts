import { describe, expect, it } from "vitest";
import { shownAttempt, sizeOf } from "./OutputTab.js";

describe("shownAttempt", () => {
  it("is the latest ended attempt of an agent's step", () => {
    expect(
      shownAttempt({
        agentId: "builder",
        attempts: [
          { attempt: 1, result: "failed", checks: [] },
          { attempt: 2, result: "passed", checks: [] },
          { attempt: 3, checks: [] },
        ],
      } as never),
    ).toBe(2);
  });

  it("is undefined for a step without an agent or without an ended attempt", () => {
    expect(shownAttempt({ agentId: undefined, attempts: [{ attempt: 1, result: "passed", checks: [] }] } as never)).toBeUndefined();
    expect(shownAttempt({ agentId: "builder", attempts: [{ attempt: 1, checks: [] }] } as never)).toBeUndefined();
    expect(shownAttempt({ agentId: "builder" } as never)).toBeUndefined();
  });
});

describe("sizeOf", () => {
  it("counts UTF-8 bytes, in KB from 1024 on", () => {
    expect(sizeOf("abc")).toBe("3 B");
    expect(sizeOf("−")).toBe("3 B");
    expect(sizeOf("a".repeat(1945))).toBe("1.9 KB");
  });
});
