import { describe, expect, it } from "vitest";
import { shownAttempt, sizeOf, summaryLine } from "./OutputTab.js";

describe("summaryLine", () => {
  it("is 'approve' for an approving verdict", () => {
    expect(summaryLine({ kind: "verdict", verdict: "approve", mustFix: [], more: 0, lines: ["Looks good."] })).toBe("approve");
  });

  it("counts the must-fix items, those carried and those past them, and names the first file and line", () => {
    const mustFix = [{ text: "the card shifts" }, { ref: "src/x.ts:12", text: "no test" }];
    expect(summaryLine({ kind: "verdict", verdict: "changes", mustFix, more: 1, lines: [] })).toBe("changes · 3 must-fix · src/x.ts:12");
    expect(summaryLine({ kind: "verdict", verdict: "changes", mustFix: [], more: 0, lines: [] })).toBe("changes");
  });

  it("is the first line of an output without a verdict, and nothing for an empty or unread one", () => {
    expect(summaryLine({ kind: "lines", format: "none", lines: ["Add GET /orders/export.", "Reuse the list query."] })).toBe("Add GET /orders/export.");
    expect(summaryLine({ kind: "empty" })).toBeUndefined();
    expect(summaryLine(undefined)).toBeUndefined();
  });
});

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
