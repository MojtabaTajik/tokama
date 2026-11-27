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
});
