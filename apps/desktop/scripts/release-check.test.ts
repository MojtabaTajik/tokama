import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { changelogSection, feedUrlFor, releaseNotesFor, tagVersion } from "./release-check.js";

describe("tagVersion", () => {
  it("reads the version of a v<x.y.z> tag", () => {
    expect(tagVersion("refs/tags/v0.1.0")).toBe("0.1.0");
    expect(tagVersion("refs/tags/v10.20.30")).toBe("10.20.30");
  });

  it.each(["refs/heads/main", "refs/tags/0.1.0", "refs/tags/v0.1", "refs/tags/v0.1.0-rc.1", "refs/tags/v0.1.0.1", "refs/tags/vx.y.z", "v0.1.0", ""])("refuses %j and says how to run the workflow", (ref) => {
    expect(() => tagVersion(ref)).toThrow(/gh workflow run release\.yml --ref vX\.Y\.Z/);
  });
});

describe("changelogSection", () => {
  const log = `# Changelog

## Unreleased

Not yet.

## 0.1.0 (2026-12-01)

First line.

- Second line.

## 0.0.10

Ten.

## 0.0.1

One.
`;

  it("takes the body of a section in the middle, up to the next heading", () => {
    expect(changelogSection(log, "0.1.0")).toBe("First line.\n\n- Second line.");
  });

  it("takes the first and the last section", () => {
    expect(changelogSection(`## 0.2.0\nNew.\n\n## 0.1.0\nOld.\n`, "0.2.0")).toBe("New.");
    expect(changelogSection(log, "0.0.1")).toBe("One.");
  });

  it("does not match 0.0.1 to 0.0.10, or the other way round", () => {
    expect(changelogSection(log, "0.0.10")).toBe("Ten.");
    expect(changelogSection(log, "0.0.1")).toBe("One.");
    expect(() => changelogSection("## 0.0.10\nTen.\n", "0.0.1")).toThrow(/no "## 0\.0\.1" section/);
    expect(() => changelogSection("## 0.0.1\nOne.\n", "0.0.10")).toThrow(/no "## 0\.0\.10" section/);
  });

  it("does not let a dot in the version match any character", () => {
    expect(() => changelogSection("## 0x0x1\nOdd.\n", "0.0.1")).toThrow(/no "## 0\.0\.1" section/);
  });

  it("ignores Unreleased", () => {
    expect(() => changelogSection("## Unreleased\nSoon.\n", "0.1.0")).toThrow(/no "## 0\.1\.0" section/);
  });

  it("refuses an empty section, even one with blank lines", () => {
    expect(() => changelogSection("## 0.1.0\n\n  \n## 0.0.1\nOne.\n", "0.1.0")).toThrow(/is empty/);
    expect(() => changelogSection("## 0.1.0\n", "0.1.0")).toThrow(/is empty/);
  });

  it("keeps a deeper heading inside the section", () => {
    expect(changelogSection("## 0.1.0\n### Fixed\n\nA fix.\n\n## 0.0.1\nOne.\n", "0.1.0")).toBe("### Fixed\n\nA fix.");
  });
});

describe("feedUrlFor", () => {
  const DEFAULT = "https://updates.tokama.dev/mac/";

  it("is the default for a tag push, whatever the input holds", () => {
    expect(feedUrlFor("push", undefined)).toBe(DEFAULT);
    expect(feedUrlFor("push", "https://other.example.test/mac/")).toBe(DEFAULT);
  });

  it("is the default for a manual run without an input", () => {
    expect(feedUrlFor("workflow_dispatch", "")).toBe(DEFAULT);
    expect(feedUrlFor("workflow_dispatch", undefined)).toBe(DEFAULT);
  });

  it("takes the input of a manual run", () => {
    expect(feedUrlFor("workflow_dispatch", "https://example.test/updates/mac/")).toBe("https://example.test/updates/mac/");
  });

  it.each(["http://example.test/mac/", "https://example.test/mac", "https://exa mple.test/", "https://example.test/mac/\nx=y/", "file:///etc/", "https://example.test/mac/?a=b"])("refuses the input %j", (input) => {
    expect(() => feedUrlFor("workflow_dispatch", input)).toThrow(/feed URL/);
  });
});

describe("releaseNotesFor", () => {
  const NOTE = "---\nversion: 0.2.0\ndate: 2026-12-03\n---\n\n## Sounds\n\nA soft chirp.\n\n+ 2 smaller fixes\n";
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  /** A checkout with a changelog and these files in `whats-new/`. */
  const checkout = (files: Record<string, string>, changelog = "# Changelog\n\n## 0.2.0\n\nFrom the changelog.\n"): string => {
    const dir = mkdtempSync(join(tmpdir(), "tk-notes-240-"));
    dirs.push(dir);
    writeFileSync(join(dir, "CHANGELOG.md"), changelog);
    mkdirSync(join(dir, "whats-new"));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, "whats-new", name), text);
    return dir;
  };

  it("takes the note, as the release body, when there is one", () => {
    expect(releaseNotesFor(checkout({ "0.2.0.md": NOTE }), "0.2.0")).toEqual({ notes: "### Sounds\n\nA soft chirp.\n\n+ 2 smaller fixes", source: "whats-new/0.2.0.md" });
  });

  it("takes the changelog section when there is no note for the version", () => {
    expect(releaseNotesFor(checkout({ "0.1.0.md": NOTE.replace("0.2.0", "0.1.0") }), "0.2.0")).toEqual({ notes: "From the changelog.", source: "CHANGELOG.md" });
  });

  it("takes the changelog section when the repo has no whats-new folder", () => {
    const dir = checkout({});
    rmSync(join(dir, "whats-new"), { recursive: true });
    expect(releaseNotesFor(dir, "0.2.0").source).toBe("CHANGELOG.md");
  });

  it("does not need a changelog section when there is a note", () => {
    expect(releaseNotesFor(checkout({ "0.2.0.md": NOTE }, "# Changelog\n"), "0.2.0").source).toBe("whats-new/0.2.0.md");
  });

  it("refuses a note with problems, naming the file and every problem, and does not fall back to the changelog", () => {
    const bad = NOTE.replace("date: 2026-12-03", "date: 2026-02-30").replace("A soft chirp.", "<b>chirp</b>");
    expect(() => releaseNotesFor(checkout({ "0.2.0.md": bad }), "0.2.0")).toThrow(/^whats-new\/0\.2\.0\.md: date "2026-02-30" is not a real YYYY-MM-DD day; line 8: markup characters .* are not allowed in a highlight's sentence$/);
  });

  it("refuses a note whose version is not its file name", () => {
    expect(() => releaseNotesFor(checkout({ "0.2.0.md": NOTE.replace("version: 0.2.0", "version: 0.2.1") }), "0.2.0")).toThrow(/does not match the file name 0\.2\.0\.md/);
  });

  it("refuses a note over 8 KiB without reading it, and a note that is not a plain file", () => {
    expect(() => releaseNotesFor(checkout({ "0.2.0.md": `${NOTE}${" ".repeat(9000)}` }), "0.2.0")).toThrow(/^whats-new\/0\.2\.0\.md: the file is \d+ bytes, at most 8192$/);
    const dir = checkout({ "real.md": NOTE });
    symlinkSync(join(dir, "whats-new", "real.md"), join(dir, "whats-new", "0.2.0.md"));
    expect(() => releaseNotesFor(dir, "0.2.0")).toThrow(/is not a plain file/);
  });

  it("still fails with the changelog's own message when there is neither", () => {
    expect(() => releaseNotesFor(checkout({}, "# Changelog\n"), "0.2.0")).toThrow(/CHANGELOG\.md has no "## 0\.2\.0" section/);
  });
});
