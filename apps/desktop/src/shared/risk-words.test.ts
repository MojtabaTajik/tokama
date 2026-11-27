import type { ChangeSummary, ItemRecord, Risk } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { changeText, riskBanner, riskWords, touchesText } from "./risk-words.js";

const rated = (risk: Risk | undefined, change?: ChangeSummary) => ({ risk, change }) as Pick<ItemRecord, "risk" | "change">;
const DEPENDENCIES: ChangeSummary = { files: 5, added: 61, removed: 40, touches: [{ kind: "dependencies", files: 2 }] };

describe("changeText", () => {
  it("says the files and the lines, and only the files when the lines were not counted", () => {
    expect(changeText({ files: 6, added: 214, removed: 12 })).toBe("6 files +214 −12");
    expect(changeText({ files: 1, added: 3, removed: 0 })).toBe("1 file +3 −0");
    expect(changeText({ files: 38, added: 1204, removed: 310 })).toBe("38 files +1,204 −310");
    expect(changeText({ files: 212, unreadable: "binary_only" })).toBe("212 files");
  });
});

describe("touchesText", () => {
  it("counts the files of each kind in words", () => {
    const change: ChangeSummary = {
      files: 9,
      added: 1,
      removed: 1,
      touches: [
        { kind: "dependencies", files: 1 },
        { kind: "migrations", files: 2 },
        { kind: "ci", files: 1 },
        { kind: "infrastructure", files: 2 },
        { kind: "secrets", files: 1 },
        { kind: "sign_in", files: 2 },
        { kind: "tests_added", files: 2 },
        { kind: "tests_edited", files: 1 },
      ],
    };
    expect(touchesText(change)).toEqual([
      "1 dependency file",
      "2 migrations",
      "1 CI file",
      "2 infrastructure files",
      "1 settings or secrets file",
      "2 sign-in files",
      "2 new test files",
      "1 edited test file",
    ]);
    expect(touchesText({ files: 1, added: 1, removed: 0 })).toEqual([]);
  });
});

describe("riskWords", () => {
  it("is plain Low with its reason", () => {
    expect(riskWords(rated({ level: "low", reasons: ["small_checked_reviewed"] }))).toEqual({
      level: "low",
      word: "Low",
      shown: ["small change, checks and a second agent's review passed"],
      more: [],
      first: undefined,
    });
    expect(riskWords(rated({ level: "low", reasons: ["small_checked"] }))?.shown).toEqual(["small change, checks passed"]);
  });

  it("names the sensitive kinds in a reason, and the first reason in a few words", () => {
    const words = riskWords(rated({ level: "high", reasons: ["no_review_sensitive"] }, DEPENDENCIES));
    expect(words).toMatchObject({ level: "high", word: "High", shown: ["changes dependencies and no second agent reviewed"], more: [], first: "changes dependencies, no review" });
    const several: ChangeSummary = { files: 3, added: 1, removed: 1, touches: [{ kind: "migrations", files: 1 }, { kind: "ci", files: 1 }, { kind: "tests_added", files: 1 }] };
    expect(riskWords(rated({ level: "high", reasons: ["no_review_sensitive"] }, several))?.first).toBe("changes database migrations and CI, no review");
  });

  it("shows two reasons in the order given, and the rest apart", () => {
    const words = riskWords(rated({ level: "high", reasons: ["no_checks", "no_review_sensitive", "very_large"] }, DEPENDENCIES))!;
    expect(words.shown).toEqual(["no checks ran on the committed files", "changes dependencies and no second agent reviewed"]);
    expect(words.more).toEqual(["more than 30 files or 800 changed lines"]);
    expect(words.first).toBe("no checks ran");
  });

  it("says every reason in words", () => {
    const reasons = ["no_checks", "review_asked_changes", "no_review_sensitive", "no_review_large", "no_review_last_attempt", "protected_change", "very_large"] as const;
    const words = riskWords(rated({ level: "high", reasons: [...reasons] }, DEPENDENCIES))!;
    expect([...words.shown, ...words.more]).toEqual([
      "no checks ran on the committed files",
      "the last review asked for changes",
      "changes dependencies and no second agent reviewed",
      "more than 150 changed lines and no second agent reviewed",
      "the checks passed only on the last allowed attempt and no second agent reviewed",
      "you approved a change to a protected file",
      "more than 30 files or 800 changed lines",
    ]);
    expect(reasons.map((reason) => riskWords(rated({ level: "high", reasons: [reason] }, DEPENDENCIES))?.first)).toEqual([
      "no checks ran",
      "review asked for changes",
      "changes dependencies, no review",
      "large change, no review",
      "checks passed on the last attempt, no review",
      "you approved a protected file",
      "very large change",
    ]);
  });

  it("says why a change was not rated, from the change itself", () => {
    const why = (change: ChangeSummary | undefined) => riskWords(rated({ level: "not_rated", reasons: ["unreadable_change"] }, change))?.shown[0];
    expect(why({ files: 212, unreadable: "binary_only" })).toBe("Tokama could not read the change: binary files only");
    expect(why({ files: 900, unreadable: "too_large" })).toBe("Tokama could not read the change: the change is too large to count");
    expect(why(undefined)).toBe("Tokama could not read the change: this item is from before risk was rated");
    expect(riskWords(rated({ level: "not_rated", reasons: ["unreadable_change"] }))).toMatchObject({ word: "Not rated", first: undefined });
  });

  it("has no words for an item with no risk", () => {
    expect(riskWords(rated(undefined))).toBeUndefined();
  });
});

describe("riskBanner", () => {
  it("says a high risk with its first reason and a risk that was not rated, and nothing for low or none", () => {
    expect(riskBanner(rated({ level: "high", reasons: ["no_review_sensitive", "no_checks"] }, DEPENDENCIES))).toBe("risk high: changes dependencies, no review");
    expect(riskBanner(rated({ level: "not_rated", reasons: ["unreadable_change"] }))).toBe("risk not rated");
    expect(riskBanner(rated({ level: "low", reasons: ["small_checked"] }))).toBeUndefined();
    expect(riskBanner(rated(undefined))).toBeUndefined();
  });
});
