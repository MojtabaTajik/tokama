import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { expect, it } from "vitest";
import { parseNote } from "./whats-new.js";

const repo = join(import.meta.dirname, "..", "..", "..", "..");
const NOTES = join(repo, "whats-new");
const FIXTURES = join(repo, "apps", "desktop", "e2e", "fixtures", "whats-new");

/** Every note file below `dir`: the files named `<x.y.z>.md`. */
const notesIn = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((path) => /^\d+\.\d+\.\d+\.md$/.test(basename(path)))
    .map((path) => join(dir, path));

it("every note in the repo and every e2e fixture parses and carries its own file name as its version", () => {
  const problems = [...notesIn(NOTES), ...notesIn(FIXTURES)].flatMap((file) => {
    const result = parseNote(readFileSync(file, "utf8"), basename(file));
    return result.ok ? [] : result.problems.map((problem) => `${relative(repo, file)}: ${problem}`);
  });
  expect(problems).toEqual([]);
});

it("finds the e2e fixtures, so the check above is not empty", () => {
  expect(notesIn(FIXTURES).map((file) => relative(FIXTURES, file)).sort()).toEqual(["fixes/0.0.1.md", "highlights/0.0.0.md", "highlights/0.0.1.md"]);
});
