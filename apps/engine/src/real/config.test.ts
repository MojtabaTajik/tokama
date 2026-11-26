import { loadBuiltins } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { roleLine, templateSummary } from "./config.js";

describe("templateSummary", () => {
  it("passes the warnings of the template's load on, after the problems found here", async () => {
    const load = (await loadBuiltins(new Map([["builder", { cloud: false }]]))).find((candidate) => candidate.ok);
    if (!load?.ok) throw new Error("no built-in template loaded");
    const note = 'Line 14: Step "review": "if_failed" has no effect on a reviewer step; use "if_changes_requested".';
    const summary = templateSummary(load.template, { agents: [], broken: [], problems: [] }, [note]);
    expect(summary.warnings.at(-1)).toBe(note);
  });
});

describe("roleLine", () => {
  it("is the first line with text, trimmed", () => {
    expect(roleLine("\n  \n  You review a diff.  \nThen more.")).toBe("You review a diff.");
  });

  it("is undefined for a role with no text", () => {
    expect(roleLine(" \n\t\n")).toBeUndefined();
  });

  it("cuts a long line to the 200 characters the setup allows, ending in an ellipsis", () => {
    const line = roleLine("x".repeat(300));
    expect(line).toHaveLength(200);
    expect(line?.endsWith("…")).toBe(true);
  });
});
