import { describe, expect, it } from "vitest";
import type { ChangeSummary } from "../../kernel/schemas/index.js";
import { LARGE_LINES, risk, type RiskFacts, VERY_LARGE_FILES, VERY_LARGE_LINES } from "./risk.js";

const small: ChangeSummary = { files: 3, added: 40, removed: 8 };
const GOOD: RiskFacts = { change: small, checked: true, lastVerdict: "approve", secondReview: true, lastAttempt: false, protectedApproved: false };
const rate = (facts: Partial<RiskFacts>) => risk({ ...GOOD, ...facts });
const lines = (total: number): ChangeSummary => ({ files: 2, added: total, removed: 0 });

describe("risk: low", () => {
  it("is low with a reason when checks passed and a second agent approved a small change", () => {
    expect(rate({})).toEqual({ level: "low", reasons: ["small_checked_reviewed"] });
  });

  it("is low without a review when the change is small, checked and touches nothing sensitive", () => {
    expect(rate({ secondReview: false, lastVerdict: undefined })).toEqual({ level: "low", reasons: ["small_checked"] });
  });

  it("does not count tests as sensitive", () => {
    const tests = { ...small, touches: [{ kind: "tests_added" as const, files: 2 }, { kind: "tests_edited" as const, files: 1 }] };
    expect(rate({ change: tests, secondReview: false, lastVerdict: undefined }).level).toBe("low");
  });
});

describe("risk: high, one rule at a time", () => {
  it("no_checks: no check passed on the tree being judged", () => {
    expect(rate({ checked: false })).toEqual({ level: "high", reasons: ["no_checks"] });
  });

  it("review_asked_changes: the last review asked for changes and the item ended anyway", () => {
    expect(rate({ lastVerdict: "changes", secondReview: false })).toEqual({ level: "high", reasons: ["review_asked_changes"] });
  });

  it("no_review_sensitive: a sensitive file and no second agent", () => {
    const change = { ...small, touches: [{ kind: "dependencies" as const, files: 1 }] };
    expect(rate({ change, secondReview: false })).toEqual({ level: "high", reasons: ["no_review_sensitive"] });
    // A second agent's review takes this reason away.
    expect(rate({ change }).level).toBe("low");
  });

  it.each(["dependencies", "migrations", "ci", "infrastructure", "secrets", "sign_in"] as const)("%s is sensitive", (kind) => {
    expect(rate({ change: { ...small, touches: [{ kind, files: 1 }] }, secondReview: false }).reasons).toEqual(["no_review_sensitive"]);
  });

  it("no_review_large: more than 150 changed lines and no second agent, counting added and removed together", () => {
    expect(rate({ change: lines(LARGE_LINES), secondReview: false }).level).toBe("low");
    expect(rate({ change: lines(LARGE_LINES + 1), secondReview: false })).toEqual({ level: "high", reasons: ["no_review_large"] });
    expect(rate({ change: { files: 2, added: 100, removed: 51 }, secondReview: false }).reasons).toEqual(["no_review_large"]);
    expect(rate({ change: lines(LARGE_LINES + 1) }).level).toBe("low");
  });

  it("no_review_last_attempt: the checks passed only on the last allowed attempt, and no second agent", () => {
    expect(rate({ lastAttempt: true, secondReview: false })).toEqual({ level: "high", reasons: ["no_review_last_attempt"] });
    expect(rate({ lastAttempt: true }).level).toBe("low");
  });

  it("protected_change: you approved a change to a protected file, reviewed or not", () => {
    expect(rate({ protectedApproved: true })).toEqual({ level: "high", reasons: ["protected_change"] });
  });

  it("very_large: more than 30 files or more than 800 lines, reviewed or not", () => {
    expect(rate({ change: { files: VERY_LARGE_FILES, added: 10, removed: 0 } }).level).toBe("low");
    expect(rate({ change: { files: VERY_LARGE_FILES + 1, added: 10, removed: 0 } })).toEqual({ level: "high", reasons: ["very_large"] });
    expect(rate({ change: lines(VERY_LARGE_LINES) }).level).toBe("low");
    expect(rate({ change: lines(VERY_LARGE_LINES + 1) })).toEqual({ level: "high", reasons: ["very_large"] });
    expect(rate({ change: { files: 2, added: 400, removed: 401 } }).reasons).toEqual(["very_large"]);
  });
});

describe("risk: reasons", () => {
  it("lists every reason that holds, in the order of the rules", () => {
    const change = { files: 40, added: 900, removed: 100, touches: [{ kind: "migrations" as const, files: 2 }, { kind: "ci" as const, files: 1 }] };
    const rated = rate({ change, checked: false, lastVerdict: "changes", secondReview: false, lastAttempt: true, protectedApproved: true });
    expect(rated).toEqual({
      level: "high",
      reasons: ["no_checks", "review_asked_changes", "no_review_sensitive", "no_review_large", "no_review_last_attempt", "protected_change", "very_large"],
    });
  });
});

describe("risk: not rated", () => {
  it("is not rated for a change of binary files only, or too large to count, and never guesses", () => {
    expect(rate({ change: { files: 212, unreadable: "binary_only" } })).toEqual({ level: "not_rated", reasons: ["unreadable_change"] });
    expect(rate({ change: { files: 800, unreadable: "too_large" }, checked: false })).toEqual({ level: "not_rated", reasons: ["unreadable_change"] });
  });

  it("is not rated for an item with no recorded change (from before this feature) or one logged with a file count only", () => {
    expect(rate({ change: undefined })).toEqual({ level: "not_rated", reasons: ["unreadable_change"] });
    expect(rate({ change: { files: 4 } })).toEqual({ level: "not_rated", reasons: ["unreadable_change"] });
  });
});
