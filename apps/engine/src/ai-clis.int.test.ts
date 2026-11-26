// The ai_clis query over the engine API, in sample mode (no health checks of this machine run there,
// so the state comes from the sample setup).
import { connect } from "@tokama/client";
import { afterEach, describe, expect, it } from "vitest";
import { startEngine } from "./engine.js";
import { tempEngineDir } from "./testing/helpers.js";

let cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups = [];
  delete process.env["TOKAMA_TEST_API_KEY"];
});

describe("ai_clis query", () => {
  it("answers Claude Code with its launch arguments and the others as not supported, with no environment value", async () => {
    process.env["TOKAMA_TEST_API_KEY"] = "sk-sentinel-never-shown";
    const dir = tempEngineDir(cleanups);
    const started = await startEngine({ dir, sample: true });
    if (!started.ok) throw new Error(started.error.message);
    cleanups.push(() => started.value.close());
    const connected = await connect({ dir, lockPath: started.value.endpoint.lockPath, startTimeoutMs: 2_000 });
    if (!connected.ok) throw new Error(connected.error.message);
    cleanups.push(() => connected.value.close());

    const reply = await connected.value.query({ type: "ai_clis" });
    if (!reply.ok) throw new Error(reply.error.message);
    const [claude, codex] = reply.data.clis;
    expect(claude).toMatchObject({ supported: true, cliId: "claude-code", state: "ready", version: "2.1.331", promptVia: "stdin" });
    expect(claude?.supported && claude.permissionArgs).toContain("--permission-mode=dontAsk");
    expect(claude?.supported && claude.usedBy).toEqual(expect.arrayContaining(["Architect"]));
    expect(codex?.supported).toBe(false);
    expect(JSON.stringify(reply.data)).not.toContain("sk-sentinel-never-shown");
    expect(claude?.supported && claude.envNames).not.toContain("TOKAMA_TEST_API_KEY");
  });
});
