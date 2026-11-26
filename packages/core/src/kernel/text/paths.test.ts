import { describe, expect, it } from "vitest";
import { displayPath, scrubPaths } from "./paths.js";

describe("displayPath", () => {
  it("writes the home folder as ~, and only a whole folder", () => {
    expect(displayPath("/Users/sam/code/orders-api", { home: "/Users/sam" })).toBe("~/code/orders-api");
    expect(displayPath("/Users/sam", { home: "/Users/sam" })).toBe("~");
    expect(displayPath("/Users/samuel/code/x", { home: "/Users/sam" })).toBe("/Users/samuel/code/x");
    expect(displayPath("/srv/repos/x", { home: "/Users/sam" })).toBe("/srv/repos/x");
  });

  it("leaves the path alone for a home of / or empty", () => {
    expect(displayPath("/x", { home: "/" })).toBe("/x");
    expect(displayPath("/x", { home: "" })).toBe("/x");
  });
});

describe("scrubPaths", () => {
  it("replaces every occurrence of each root, the longest first", () => {
    const roots: [string, string][] = [
      ["/home/dev", "~"],
      ["/home/dev/work/repo", "."],
    ];
    expect(scrubPaths("ENOENT: /home/dev/work/repo/x and /home/dev/y, /home/dev/work/repo", { roots })).toBe("ENOENT: ./x and ~/y, .");
  });

  it("skips roots of one character or less", () => {
    expect(scrubPaths("/a/b", { roots: [["/", "<root>"], ["", "<empty>"]] })).toBe("/a/b");
  });

  it("takes any iterable of pairs, a Map included", () => {
    expect(scrubPaths("/tmp/items/i1/log", { roots: new Map([["/tmp/items", "<items folder>"], ["/tmp/items/i1", "<item folder>"]]) })).toBe("<item folder>/log");
  });
});
