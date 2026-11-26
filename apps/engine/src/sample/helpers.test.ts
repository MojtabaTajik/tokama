import { type EngineEvent, manualClock } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { SAMPLE_SLOW_MS, SampleHelpers } from "./helpers.js";

const start = (helpers: SampleHelpers, folder: string, cloud = true) => {
  const reply = helpers.command({ type: "run_helper", run: { helperId: "suggest-checks", input: { path: `/work/${folder}` } }, ...(cloud && { cloud: "accepted" as const }) });
  if (!reply.ok) throw new Error(reply.error.message);
  return (reply.value as { runId: string }).runId;
};

const startTrial = (helpers: SampleHelpers, checks: string[]) => {
  const reply = helpers.command({ type: "try_checks", path: "/work/orders-api", checks });
  if (!reply.ok) throw new Error(reply.error.message);
  return (reply.value as { trialId: string }).trialId;
};

function fixture() {
  const clock = manualClock(1_000);
  const events: EngineEvent[] = [];
  return { clock, events, helpers: new SampleHelpers(clock, (event) => events.push(event)) };
}

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

  it("sends nothing for a refused run", () => {
    const { clock, events, helpers } = fixture();
    expect(helpers.command({ type: "run_helper", run: { helperId: "suggest-checks", input: { path: "/work/orders-api" } } })).toMatchObject({ ok: false, error: { code: "cloud_not_accepted" } });
    clock.advance(2 * SAMPLE_SLOW_MS);
    expect(events).toEqual([]);
  });

  it("sends nothing after close", () => {
    const { clock, events, helpers } = fixture();
    start(helpers, "orders-api");
    startTrial(helpers, ["pnpm test"]);
    helpers.close();
    clock.advance(2 * SAMPLE_SLOW_MS);
    expect(events).toEqual([]);
  });

  it("sends nothing more for a cancelled run", () => {
    const { clock, events, helpers } = fixture();
    const runId = start(helpers, "slow-api");
    clock.advance(500);
    expect(helpers.command({ type: "cancel_helper", runId: runId as never }).ok).toBe(true);
    const sent = events.length;
    expect(events.at(-1)).toMatchObject({ type: "helper_run_updated", run: { state: "cancelled" } });
    clock.advance(2 * SAMPLE_SLOW_MS);
    expect(events).toHaveLength(sent);
  });

  it("sends nothing more for a cancelled trial", () => {
    const { clock, events, helpers } = fixture();
    const trialId = startTrial(helpers, ["pnpm test", "pnpm slow-e2e"]);
    clock.advance(300 + 1_200 + 500);
    expect(helpers.command({ type: "cancel_check_trial", trialId: trialId as never }).ok).toBe(true);
    const sent = events.length;
    expect(events.at(-1)).toMatchObject({ type: "check_trial_updated", trial: { state: "cancelled" } });
    clock.advance(2 * SAMPLE_SLOW_MS);
    expect(events).toHaveLength(sent);
  });
});
