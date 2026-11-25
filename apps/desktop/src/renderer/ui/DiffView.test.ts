import { describe, expect, it } from "vitest";
import { type DiffRow, pairRows } from "./DiffView.js";

const row = (kind: DiffRow["kind"], a: string, b: string, text: string): DiffRow => ({ kind, a, b, text });

describe("pairRows", () => {
  it("puts unchanged lines on both sides and each removed run next to the added run after it", () => {
    expect(
      pairRows([
        row("hunk", "", "", "@@ -1,4 +1,3 @@"),
        row("unchanged", "1", "1", "keep"),
        row("removed", "2", "", "old one"),
        row("removed", "3", "", "old two"),
        row("added", "", "2", "new one"),
        row("unchanged", "4", "3", "end"),
      ]),
    ).toEqual([
      { kind: "hunk", text: "@@ -1,4 +1,3 @@" },
      { kind: "pair", left: { kind: "unchanged", n: "1", text: "keep" }, right: { kind: "unchanged", n: "1", text: "keep" } },
      { kind: "pair", left: { kind: "removed", n: "2", text: "old one" }, right: { kind: "added", n: "2", text: "new one" } },
      { kind: "pair", left: { kind: "removed", n: "3", text: "old two" }, right: undefined },
      { kind: "pair", left: { kind: "unchanged", n: "4", text: "end" }, right: { kind: "unchanged", n: "3", text: "end" } },
    ]);
  });

  it("leaves the left side empty for added lines with nothing removed, and keeps notes across both sides", () => {
    expect(pairRows([row("added", "", "1", "only"), row("added", "", "2", "more"), row("note", "", "", "\\ No newline at end of file")])).toEqual([
      { kind: "pair", left: undefined, right: { kind: "added", n: "1", text: "only" } },
      { kind: "pair", left: undefined, right: { kind: "added", n: "2", text: "more" } },
      { kind: "note", text: "\\ No newline at end of file" },
    ]);
  });

  it("does not pair an added run with a removed run after it", () => {
    expect(pairRows([row("added", "", "1", "new"), row("removed", "1", "", "old")])).toEqual([
      { kind: "pair", left: undefined, right: { kind: "added", n: "1", text: "new" } },
      { kind: "pair", left: { kind: "removed", n: "1", text: "old" }, right: undefined },
    ]);
  });

  it("returns nothing for no rows", () => {
    expect(pairRows([])).toEqual([]);
  });
});
