import { describe, expect, it } from "vitest";
import { changelogSection, feedUrlFor, tagVersion } from "./release-check.js";

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
