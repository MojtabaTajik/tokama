import { describe, expect, it } from "vitest";
import { simpleCommandProblem } from "./index.js";

describe("simpleCommandProblem", () => {
  it.each(["pnpm test", "cargo test --workspace", "node -e 'a > b && c'", "make -C build check"])("accepts %j", (command) => {
    expect(simpleCommandProblem(command)).toBeUndefined();
  });

  it.each([
    ["pnpm lint && pnpm test", "must be one command, with no &&, ||, ; or |"],
    ["x | sh", "must be one command, with no &&, ||, ; or |"],
    ["ls; rm x", "must be one command, with no &&, ||, ; or |"],
    ["ls $(rm x)", "can't use command substitution ($(...) or backticks)"],
    ["ls `rm x`", "can't use command substitution ($(...) or backticks)"],
    ["make > out", "can't use a redirect (>, <)"],
    ["make &", "can't use a background &"],
    ["(make)", "can't use a subshell ( ... )"],
    ["make\nmake", "can't use a line break"],
    ['make "x', "can't use an unclosed quote"],
    ["", "has no command words"],
  ])("refuses %j", (command, problem) => {
    expect(simpleCommandProblem(command)).toBe(problem);
  });

  // A command that reads as `npm test` but holds a character nobody can see.
  it.each([["a Hangul filler", "npmㅤtest"], ["a variation selector", "npm test️"], ["a zero-width space", "npm​test"], ["a right-to-left override", "npm ‮test"], ["a combining grapheme joiner", "npm test͏"], ["a control character", "npm test\u0001"], ["a tab", "npm\ttest"]])("refuses %s", (_name, command) => {
    expect(simpleCommandProblem(command)).toBe("has a control, invisible or line-break character");
  });
});
