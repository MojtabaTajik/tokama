// The templates and template_detail queries through the real client and socket.
import { connect, type EngineClient } from "@tokama/client";
import { afterEach, describe, expect, it } from "vitest";
import { startEngine } from "./engine.js";
import { tempEngineDir } from "./testing/helpers.js";

let cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
});

async function client(options: { sample?: boolean; home?: string } = {}): Promise<EngineClient> {
  const dir = tempEngineDir(cleanups);
  const started = await startEngine({ dir, ...options });
  if (!started.ok) throw new Error(started.error.message);
  cleanups.push(() => started.value.close());
  const connected = await connect({ dir, startTimeoutMs: 2_000 });
  if (!connected.ok) throw new Error(connected.error.message);
  cleanups.push(() => connected.value.close());
  return connected.value;
}

describe("the templates queries in sample mode", () => {
  it("lists the sample templates with their problem counts", async () => {
    const reply = await (await client({ sample: true })).query({ type: "templates" });
    expect(reply.ok && reply.data.templates.map((entry) => [entry.ref, entry.problemCount, entry.openable])).toEqual([
      ["orders-api/plan-and-build", 0, false],
      ["checkout-web/flaky-test-fix", 2, false],
    ]);
  });

  it("gives one file in full", async () => {
    const reply = await (await client({ sample: true })).query({ type: "template_detail", origin: "checkout-web", file: ".tokama/templates/flaky-test-fix.yaml" });
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.data.problems.map((problem) => problem.line)).toEqual([20, 24]);
    expect(reply.data.text).toContain("agent: reviewr");
    expect(reply.data.path).toBeNull();
  });

  it("answers not_found for a file it does not have", async () => {
    const reply = await (await client({ sample: true })).query({ type: "template_detail", origin: "orders-api", file: ".tokama/templates/gone.yaml" });
    expect(reply).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});
