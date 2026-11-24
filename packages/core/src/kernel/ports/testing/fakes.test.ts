import { describe, expect, it } from "vitest";
import { manualClock } from "../../clock/index.js";
import { describeAgentRuntimeContract, describeConnectorContract, describeModelHostContract, describeSamplerContract } from "./contracts.js";
import { createFakeAgentRuntime, createFakeConnector, createFakeModelHost, createFakeSampler } from "./fakes.js";

const request = (prompt: string) => ({ model: "fake-model", prompt, cwd: "/tmp/fake" });

describeAgentRuntimeContract("fake", () => ({
  runtime: createFakeAgentRuntime((req) => {
    if (req.prompt === "fail") return { kind: "fail", error: "exit code 1" };
    if (req.prompt === "hang") return { kind: "hang" };
    return { kind: "complete", text: ["one", "two"], usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 } };
  }),
  completing: request("hello"),
  failing: request("fail"),
  hanging: request("hang"),
}));

describeModelHostContract("fake", () => ({
  host: createFakeModelHost([{ name: "qwen3-coder:30b" }, { name: "gemma3:12b" }]),
  expectedModel: "qwen3-coder:30b",
  downHost: createFakeModelHost([], { up: false }),
}));

describeConnectorContract("fake", () => ({
  connector: createFakeConnector([{ name: "query", description: "Run a read-only query" }]),
  expectedTool: "query",
  downConnector: createFakeConnector([], { up: false }),
}));

describeSamplerContract("fake", () => ({
  sampler: createFakeSampler(manualClock(1_760_000_000_000), { cpuPercent: 12.5, powerWatts: 8 }),
  downSampler: createFakeSampler(manualClock(), {}, { up: false }),
}));

describe("fake agent runtime", () => {
  it("echoes the prompt by default", async () => {
    const events = [];
    for await (const event of createFakeAgentRuntime().launch(request("hi"), new AbortController().signal)) events.push(event);
    expect(events).toEqual([
      { type: "text", text: "hi" },
      { type: "end", outcome: "completed", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ]);
  });
});
