import { type ItemState, MAX_NOTE_CHARS as ENGINE_NOTE_CHARS, parseItemRecord, parseQueryResult, REQUEST_CHANGES_ID as ENGINE_REQUEST_CHANGES, type StepState } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { approved, committed, finishable, needsYou, stoppedReview, task, setup } from "../testing/drawer.js";
import { MAX_NOTE_CHARS, REQUEST_CHANGES_ID } from "./DecisionChoices.js";
import { attemptLine, hasEnded, itemMark, outcomeLine, stepAgent, stepMark, stepPosition, templateName, whereLine } from "./describe.js";

const { agents, connections } = setup;

describe("the decision note", () => {
  it("uses the engine's choice id and note limit", () => {
    expect(REQUEST_CHANGES_ID).toBe(ENGINE_REQUEST_CHANGES);
    expect(MAX_NOTE_CHARS).toBe(ENGINE_NOTE_CHARS);
  });
});

describe("drawer test data", () => {
  it("matches the engine schemas", () => {
    expect(parseQueryResult("setup", setup).ok).toBe(true);
    for (const item of [needsYou, approved, task, committed, finishable, stoppedReview]) expect(parseItemRecord(item)).toMatchObject({ ok: true });
  });
});

describe("marks", () => {
  it("gives every item and step state its own symbol and a word", () => {
    const itemStates: ItemState[] = ["queued", "running", "needs_you", "done", "failed", "stopped"];
    const stepStates: StepState[] = ["pending", "running", "needs_you", "passed", "failed", "stopped"];
    for (const states of [itemStates.map(itemMark), stepStates.map(stepMark)]) {
      expect(new Set(states.map((mark) => mark.symbol)).size).toBe(states.length);
      for (const mark of states) expect(mark.word).not.toBe("");
    }
    expect(itemMark("needs_you")).toEqual({ symbol: "⏸", word: "needs you", tone: "warn" });
    expect(itemMark("done")).toEqual({ symbol: "✓", word: "done", tone: "pass" });
    expect(stepMark("failed")).toEqual({ symbol: "✕", word: "failed", tone: "fail" });
  });
});

describe("stepPosition", () => {
  it("names the first step that has not passed", () => {
    expect(stepPosition(needsYou)).toBe("step 4 of 4 · Propose a fix");
    expect(stepPosition(task)).toBe("step 2 of 4 · Build");
  });

  it("says nothing once the item has ended", () => {
    expect(stepPosition({ ...task, state: "done" })).toBeUndefined();
    expect(hasEnded({ state: "stopped" })).toBe(true);
    expect(hasEnded({ state: "needs_you" })).toBe(false);
  });
});

describe("stepAgent", () => {
  it("gives the first three agents their join-order dot, later ones the neutral dot", () => {
    expect(stepAgent({ agentId: "architect" as never, data: "none" }, agents)).toEqual({ name: "Architect", dot: 1, runsOn: "cloud" });
    expect(stepAgent({ agentId: "reviewer" as never, data: "none" }, agents).dot).toBe(3);
    expect(stepAgent({ agentId: "local-builder" as never, data: "none" }, agents)).toEqual({ name: "Local builder", dot: "neutral", runsOn: "local" });
  });

  it("names Tokama for a step without an agent", () => {
    expect(stepAgent({ data: "none" }, agents)).toEqual({ name: "Tokama", dot: "neutral", runsOn: "local" });
  });

  it("falls back to the id and the data rule for an agent the setup does not list", () => {
    expect(stepAgent({ agentId: "gone" as never, data: "repo-and-diff" }, agents)).toEqual({ name: "gone", dot: "neutral", runsOn: "cloud" });
    expect(stepAgent({ agentId: "gone" as never, data: "none" }, agents).runsOn).toBe("local");
  });
});

describe("whereLine", () => {
  it("lists a local step's connections with their access", () => {
    expect(whereLine(needsYou.steps[1]!, agents, connections)).toBe("local · App Insights (query), Postgres (read-only)");
    expect(whereLine(needsYou.steps[0]!, agents, connections)).toBe("local");
  });

  it("says what a cloud step sees, by its data rule", () => {
    expect(whereLine(needsYou.steps[3]!, agents, connections)).toBe("cloud · sees your approved summary only");
    expect(whereLine(task.steps[0]!, agents, connections)).toBe("cloud · sees the repo and the diff");
  });

  it("shows a connection the setup does not list by its id", () => {
    expect(whereLine({ data: "none", uses: [{ connectionId: "grafana-prod" as never, access: "query" }] }, agents, connections)).toBe("local · grafana-prod (query)");
  });
});

describe("templateName", () => {
  it("uses the setup's template name, else the id", () => {
    expect(templateName(needsYou, setup)).toBe("Emergency investigator");
    expect(templateName({ templateId: "unknown" as never }, setup)).toBe("unknown");
    expect(templateName(needsYou, undefined)).toBe("builtin/emergency-investigator");
  });
});

describe("attempts and outcome", () => {
  it("says how each attempt ended, naming the failed check", () => {
    expect(attemptLine({ attempt: 1, result: "failed", checks: [{ command: "sh check.sh", passed: false, exitCode: 1 }] })).toEqual({
      mark: { symbol: "✕", word: "failed", tone: "fail" },
      text: "attempt 1 · failed · sh check.sh exit 1",
    });
    expect(attemptLine({ attempt: 2, result: "passed", checks: [{ command: "sh check.sh", passed: true, exitCode: 0 }] }).text).toBe("attempt 2 · passed · 1 check passed");
    expect(attemptLine({ attempt: 3, result: "run_failed", failure: "engine_restart", checks: [] }).text).toBe("attempt 3 · run failed · engine_restart");
    expect(attemptLine({ attempt: 4, checks: [] })).toMatchObject({ mark: { word: "running" }, text: "attempt 4 · running" });
  });

  it("shows the commit and branch of a done item, or how it ended", () => {
    expect(outcomeLine(committed)).toBe("commit 3f2a9c1 on tokama/0b9f3c1e");
    expect(outcomeLine({ outcome: { kind: "stopped", detail: "Stopped by the engineer." } })).toBe("Stopped by the engineer.");
    expect(outcomeLine(task)).toBeUndefined();
  });
});
