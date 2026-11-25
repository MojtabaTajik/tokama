import { describe, expect, it } from "vitest";
import { saidOf, stoppedLink, thenLine } from "./stopped-view.js";

const steps = [{ name: "Build" }, { name: "Review" }];
const loaded = (text: string, summary?: object) => ({ kind: "loaded", output: { attempt: 1, text, truncated: false, ...(summary !== undefined && { summary }) } }) as Parameters<typeof saidOf>[0];

describe("thenLine", () => {
  it("names the failed checks of the attempt itself", () => {
    expect(thenLine({ kind: "checks_failed", failed: ["pnpm test", "pnpm typecheck"], total: 5 }, steps, undefined)).toEqual({ symbol: "✕", tone: "fail", text: "Checks failed: 2 of 5 (pnpm test, pnpm typecheck)." });
  });

  it("says how the later attempt of another step ended, with a symbol for each", () => {
    const later = (result: "passed" | "failed" | "run_failed" | "stopped", checks?: { passed: number; total: number }) => thenLine({ kind: "later", stepIndex: 0, attempt: 2, result, ...(checks && { checks }) }, steps, undefined);
    expect(later("passed")).toEqual({ symbol: "✓", tone: "pass", text: "Build fixed it in attempt 2." });
    expect(later("failed", { passed: 3, total: 5 })).toEqual({ symbol: "✕", tone: "fail", text: "Build failed in attempt 2 (checks failed: 2 of 5)." });
    expect(later("run_failed").text).toBe("The run of Build failed in attempt 2.");
    expect(later("stopped").text).toBe("Build was stopped in attempt 2.");
  });

  it("says nothing ran after it", () => {
    expect(thenLine({ kind: "none" }, steps, undefined)).toEqual({ symbol: "–", tone: "muted", text: "Nothing ran after it." });
  });
});

describe("saidOf", () => {
  it("shows the first 2 lines when the engine sent no summary", () => {
    expect(saidOf(loaded("one\n\ntwo\nthree"), "Builder", "Build")).toEqual({ kind: "lines", lines: ["one", "two"], note: "First lines of the output. Build has no verdict format." });
  });

  it("an attempt with no saved output reads as empty, and its link goes to the Log", () => {
    const missing = { kind: "missing" } as const;
    expect(saidOf(missing, "Architect", "Plan")).toEqual({ kind: "note", text: "Nothing. The call ended before Architect wrote any output." });
    expect(stoppedLink(missing, "Architect")).toEqual({ to: "Log", text: "See the log →" });
    expect(stoppedLink(loaded("Done."), "Architect")).toEqual({ to: "Output", text: "See Architect’s notes →" });
    expect(stoppedLink(loaded("Done."), undefined).to).toBe("Log");
  });
});
