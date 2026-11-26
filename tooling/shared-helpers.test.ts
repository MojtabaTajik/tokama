// Small helpers exist once, in the kernel: cutText, displayPath and scrubPaths (kernel/text),
// sha256Hex (kernel/hash), errnoCode and hasCode (kernel/errno), and utcDay (diagnostics). This scan
// flags new local copies of them in source code. The createHash ban is a lint rule.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

interface Copy {
  readonly name: string;
  readonly pattern: RegExp;
  readonly use: string;
  /** Files where the pattern is the helper itself. */
  readonly home?: RegExp;
}

const COPIES: readonly Copy[] = [
  { name: "text cut with an ellipsis", pattern: /\.slice\([^\n]*?\)\}(?:…|\$\{CUT_MARK\})|(?:…|\$\{CUT_MARK\})\$\{[^}\n]*\.slice\(/, use: "cutText from kernel/text", home: /^packages\/core\/src\/kernel\/text\// },
  { name: "errno helper", pattern: /\b(?:function|const|let)\s+(?:hasCode|errnoCode)\b/, use: "hasCode or errnoCode from kernel/errno", home: /^packages\/core\/src\/kernel\/errno\// },
  { name: "inline errno read", pattern: /ErrnoException\)\.code|"code" in error\b/, use: "hasCode or errnoCode from kernel/errno", home: /^packages\/core\/src\/kernel\/errno\// },
  { name: "sha256 helper", pattern: /\b(?:function|const|let)\s+sha256\w*\s*[=(]/, use: "sha256Hex from kernel/hash", home: /^packages\/core\/src\/kernel\/hash\// },
  { name: "UTC day string", pattern: /toISOString\(\)\.slice\(0, 10\)/, use: "utcDay from the diagnostics slice", home: /^packages\/core\/src\/slices\/diagnostics\/store\.ts$/ },
];

// Tests and their helpers build data directly. The sample fixture generators keep their own small
// math. The renderer cannot import core values; it has renderer/format.
const SKIPPED = [/\.test\.tsx?$/, /\/testing\//, /^apps\/engine\/src\/sample\//, /^apps\/desktop\/src\/renderer\//];

const sources = (): string[] =>
  execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", ":(glob)packages/*/src/**", ":(glob)apps/*/src/**"], { cwd: repoRoot, encoding: "utf8" })
    .split("\0")
    .filter((path) => /\.tsx?$/.test(path) && !SKIPPED.some((skip) => skip.test(path)));

describe("shared helpers: no local copies", () => {
  const files = sources().map((path) => ({ path, text: readFileSync(join(repoRoot, path), "utf8") }));

  it("scans the source files", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(COPIES.map((copy) => [copy.name, copy] as const))("no %s outside its home", (_name, copy) => {
    const found = files
      .filter(({ path }) => copy.home === undefined || !copy.home.test(path))
      .flatMap(({ path, text }) => text.split("\n").flatMap((line, index) => (copy.pattern.test(line) ? [`${path}:${index + 1}: use ${copy.use}`] : [])));
    expect(found).toEqual([]);
  });

  // The patterns catch the copies this scan replaced.
  it.each([
    ["text cut with an ellipsis", "return line.length > max ? `${line.slice(0, max - 1)}…` : line;"],
    ["text cut with an ellipsis", "const cut = chars.length > MAX ? `${chars.slice(0, MAX).join(\"\")}…` : value;"],
    ["text cut with an ellipsis", "return `…${line.slice(line.length - MAX + 1)}`;"],
    ["text cut with an ellipsis", "return `${line.slice(0, max - 1)}${CUT_MARK}`;"],
    ["errno helper", "function hasCode(error: unknown, code: string): boolean {"],
    ["inline errno read", "if ((error as NodeJS.ErrnoException).code !== \"EEXIST\") return true;"],
    ["inline errno read", "if (!(error instanceof Error && \"code\" in error && error.code === \"ENOENT\"))"],
    ["sha256 helper", "const sha256 = (text: string) => createHash(\"sha256\").update(text).digest(\"hex\");"],
    ["UTC day string", "const day = today.toISOString().slice(0, 10);"],
  ])("flags a %s: %s", (name, line) => {
    expect(COPIES.find((copy) => copy.name === name)?.pattern.test(line)).toBe(true);
  });
});
