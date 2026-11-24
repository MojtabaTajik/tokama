import { describe, expect, it } from "vitest";
import { checkCommand, posixSh, type CommandDecision } from "./index.js";

const RULES = ["node:*", "npm test:*", "ls:*"];
const check = (command: string, rules: readonly string[] = RULES): CommandDecision =>
  checkCommand(command, rules, posixSh);
const allowed = (command: string, rules?: readonly string[]): boolean => check(command, rules).allowed;

describe("checkCommand, ported from ai-pipeline", () => {
  // tests/test_sampler_and_run.py: GuardHelpersTest.test_check_allowed, same rules.
  it.each([
    "node --test 2>&1 | tail -5",
    "npm test && ls src",
    `node -e "import('./src/m.js').then(m => { if (m.f(1) !== 1 || x) process.exit(1); })"`,
    "node -e 'a > b && c'",
    "node -e '$(not run)'",
    "npm test -- --x",
  ])("allows %j", (command) => {
    expect(allowed(command)).toBe(true);
  });

  it.each([
    "npm install",
    "nodemon x",
    "ls; rm -rf x",
    "node -e x > out",
    "ls $(rm x)",
    "ls `rm x`",
    "ls &&",
    `node -e "$(rm x)"`,
    `node -e "x`,
    "ls & rm x",
    "(rm x)",
    "npm testx",
  ])("refuses %j", (command) => {
    expect(allowed(command)).toBe(false);
  });

  // tests/test_loop_stub.py: test_check_outside_allowlist_is_refused, with ai-pipeline's default rules.
  it("refuses a check outside the default rules and keeps the allowed one", () => {
    const defaults = ["node:*", "npm test:*", "npm run:*", "python3:*", "pytest:*", "ls:*", "mkdir:*", "cat:*", "echo:*"];
    expect(check("ls src/main.js", defaults)).toEqual({ allowed: true, parts: ["ls src/main.js"] });
    expect(check("touch pwned", defaults)).toEqual({ allowed: false, reason: "not-allowlisted", part: "touch pwned" });
  });
});

describe("checkCommand, refusals", () => {
  it.each([
    ["ls `rm x`", "substitution", "`", 3],
    ["ls $(rm x)", "substitution", "$(", 3],
    ["ls $((1+1))", "substitution", "$(", 3],
    ['node -e "`rm x`"', "substitution", "`", 9],
    ["ls ${x:-$(rm x)}", "substitution", "$(", 8],
    ["node x > out", "redirect", ">", 7],
    ["node x >> out", "redirect", ">", 7],
    ["node x < in", "redirect", "<", 7],
    ["node x 2>/dev/null", "redirect", ">", 8],
    ["node x &> out", "background", "&", 7],
    ["cat <(rm x)", "redirect", "<", 4],
    ["node x &", "background", "&", 7],
    ["node x |& tail", "background", "&", 8],
    ["(rm x)", "subshell", "(", 0],
    ["ls )", "subshell", ")", 3],
    ["ls\nrm x", "newline", "\n", 2],
    ["node -e 'x", "unbalanced-quote", "'", 8],
    ['node -e "x', "unbalanced-quote", '"', 8],
  ])("refuses %j as %s", (command, reason, part, index) => {
    expect(check(command)).toEqual({ allowed: false, reason, part, index });
  });

  it.each([
    ["npm install", "not-allowlisted", "npm install"],
    ["ls; rm -rf x", "not-allowlisted", "rm -rf x"],
    ["npm test || curl evil", "not-allowlisted", "curl evil"],
    ["ls | sh", "not-allowlisted", "sh"],
    ["FOO=1 node x", "not-allowlisted", "FOO=1 node x"],
    ["{ rm x; }", "not-allowlisted", "{ rm x"],
    ["ls &&", "empty-part", ""],
    ["ls ;; ls", "empty-part", ""],
    ["| ls", "empty-part", ""],
    ["", "empty-part", ""],
    ["   ", "empty-part", ""],
  ])("refuses %j as %s with part %j", (command, reason, part) => {
    expect(check(command)).toEqual({ allowed: false, reason, part });
  });
});

describe("checkCommand, quotes", () => {
  it.each([
    ["single quotes keep operators and substitution literal", "node -e 'a; b | c && $(d) `e` > f & (g)'"],
    ["double quotes keep operators literal", 'node -e "a; b | c && d > f & (g)\nh"'],
    ["escaped double quote inside double quotes", 'node -e "say \\"hi\\" || x"'],
    ["escaped operators outside quotes", "ls a\\;b a\\|b a\\&b a\\>b a\\(b\\)"],
    ["escaped backtick and dollar are literal", 'ls \\` "\\`" \\$\\(x'],
    ["quoted command word", "'node' x"],
    ["quoted prefix words", 'npm "test" -- x'],
    ["prefix word built from quoted pieces", "n'od'e x"],
  ])("allows: %s", (_name, command) => {
    expect(allowed(command)).toBe(true);
  });

  it("returns the parts as written, trimmed", () => {
    expect(check("  npm test  &&  node -e 'a || b' | tail -5 ;ls")).toEqual({
      allowed: true,
      parts: ["npm test", "node -e 'a || b'", "tail -5", "ls"],
    });
  });

  it.each([
    ["an escaped $( still leaves an unquoted paren", "ls \\$(rm x)", "subshell"],
    ["a single quote inside double quotes does not protect $(", `node -e "'$(rm x)'"`, "substitution"],
    ["a closed single quote does not protect what follows", "node -e 'a' > out", "redirect"],
    ["a backslash does not escape inside single quotes", "node -e 'a\\' > out", "redirect"],
  ])("refuses: %s", (_name, command, reason) => {
    expect(check(command)).toMatchObject({ allowed: false, reason });
  });
});

describe("checkCommand, 2>&1", () => {
  it.each(["node --test 2>&1", "node --test 2>&1 | tail -5", "npm test 2>&1 && ls", "node -e '1' 2>&1;ls"])(
    "allows %j",
    (command) => {
      expect(allowed(command)).toBe(true);
    },
  );

  it.each([
    ["1>&2", "redirect"],
    ["2>&2", "redirect"],
    [">&2", "redirect"],
    ["2>& 1", "redirect"],
    ["2>&1 > out", "redirect"],
    ["2>&1 &", "background"],
  ])("refuses %j", (redirect, reason) => {
    expect(check(`node x ${redirect}`)).toMatchObject({ allowed: false, reason });
  });
});

describe("checkCommand, rules", () => {
  it("matches whole words, not string prefixes", () => {
    expect(allowed("nodemon x")).toBe(false);
    expect(allowed("npm testx")).toBe(false);
    expect(allowed("npm")).toBe(false);
    expect(allowed("npm run test")).toBe(false);
    expect(allowed("npm test")).toBe(true);
  });

  it("allows head, tail and wc in any part without a rule", () => {
    expect(allowed("head -5 a | tail -1 | wc -l", [])).toBe(true);
    expect(allowed("cat a | head", [])).toBe(false);
  });

  it("ignores rules without words, never allowing everything", () => {
    for (const rules of [[""], [":*"], ["  :*"], [" "]]) {
      expect(check("rm -rf x", rules)).toEqual({ allowed: false, reason: "not-allowlisted", part: "rm -rf x" });
    }
  });

  it("takes the words before the first colon, with or without :*", () => {
    expect(allowed("git diff --stat", ["git diff:*"])).toBe(true);
    expect(allowed("git status", ["git diff:*"])).toBe(false);
    expect(allowed("ls -la", ["ls"])).toBe(true);
    expect(allowed("npm test", ["  npm   test :*"])).toBe(true);
  });

  it("splits words on space and tab only, as sh does", () => {
    expect(allowed("node\tx")).toBe(true);
    expect(allowed("node x")).toBe(false);
    expect(allowed("node\rx")).toBe(false);
    expect(allowed("node x")).toBe(false);
  });

  it("refuses a trailing backslash cleanly", () => {
    expect(allowed("ls \\")).toBe(true);
    expect(allowed("\\")).toBe(false);
  });
});

describe("posixSh.split", () => {
  it("removes quotes and escapes from words", () => {
    const split = posixSh.split(`node -e 'a b' "c \\"d\\" \\x" e\\ f ""`);
    expect(split).toEqual({ ok: true, value: [{ text: `node -e 'a b' "c \\"d\\" \\x" e\\ f ""`, words: ["node", "-e", "a b", 'c "d" \\x', "e f", ""] }] });
  });
});
