import { describe, expect, it } from "vitest";
import { AgentCallEventSchema, type AgentCallEvent } from "../../../kernel/schemas/index.js";
import { codexCliAdapter } from "./adapter.js";

describe("the Codex CLI runtime", () => {
  it("refuses every call with one failed end event, until the sandbox and the stop are in place", async () => {
    const runtime = codexCliAdapter.createRuntime({ runner: { run: () => Promise.reject(new Error("must not start a process")) }, tokamaHome: "/home/u/.tokama", closedDirs: [] });
    const events: AgentCallEvent[] = [];
    for await (const event of runtime.launch({ model: "m", prompt: "p", cwd: "/work", timeoutMs: 1_000 }, new AbortController().signal)) events.push(event);
    expect(events).toHaveLength(1);
    expect(AgentCallEventSchema.parse(events[0])).toMatchObject({ type: "end", outcome: "failed", errorKind: "crash", error: expect.stringContaining("cannot run steps on Codex CLI yet") });
  });
});
