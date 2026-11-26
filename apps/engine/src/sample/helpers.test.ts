import { type EngineEvent, manualClock } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { SampleHelpers } from "./helpers.js";

const start = (helpers: SampleHelpers, folder: string) => {
  const reply = helpers.command({ type: "run_helper", run: { helperId: "suggest-checks", input: { path: `/work/${folder}` } }, cloud: "accepted" });
  if (!reply.ok) throw new Error(reply.error.message);
  return (reply.value as { runId: string }).runId;
};

describe("sample helpers", () => {
  it("keeps at most 50 ended runs, dropping the oldest", () => {
    const helpers = new SampleHelpers(manualClock(1_000));
    const ids: string[] = [];
    for (let i = 0; i < 55; i++) {
      const runId = start(helpers, "slow-api");
      ids.push(runId);
      expect(helpers.command({ type: "cancel_helper", runId: runId as never }).ok).toBe(true);
    }
    expect(ids.slice(0, 5).map((id) => helpers.helperRun(id).ok)).toEqual([false, false, false, false, false]);
    expect(ids.slice(5).every((id) => helpers.helperRun(id).ok)).toBe(true);
  });

  it("sends nothing after close", () => {
    const clock = manualClock(1_000);
    const events: EngineEvent[] = [];
    const helpers = new SampleHelpers(clock, (event) => events.push(event));
    start(helpers, "orders-api");
    helpers.close();
    clock.advance(120_000);
    expect(events).toEqual([]);
  });
});
