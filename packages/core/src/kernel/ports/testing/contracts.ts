// Contract suites every adapter of a port must pass. An adapter's test calls the suite with a
// setup that returns the adapter plus the inputs the suite needs, e.g.
//
//   describeAgentRuntimeContract("claude-code", () => ({ runtime, completing, failing, hanging }));
//
// The suites check only what any adapter can meet: results are plain JSON, expected failures are
// values, and an abort signal ends the call. Not part of the build output.
import { describe, expect, it } from "vitest";
import { AgentCallEventSchema, type AgentCallEvent } from "../../schemas/index.js";
import type { AgentCallRequest, AgentRuntime, Connector, ModelHost, PortError, Sampler } from "../index.js";

type Setup<T> = () => T | Promise<T>;

const abortedSignal = () => AbortSignal.abort();
const liveSignal = () => new AbortController().signal;

/** Asserts that `value` is plain JSON data: a JSON round trip gives back the same value. */
const expectJson = (value: unknown) => expect(JSON.parse(JSON.stringify(value))).toStrictEqual(value);

const expectPortError = (error: PortError, code?: PortError["code"]) => {
  expectJson(error);
  expect(["aborted", "unavailable", "failed"]).toContain(error.code);
  if (code !== undefined) expect(error.code).toBe(code);
  expect(typeof error.message).toBe("string");
};

async function collect(stream: AsyncIterable<AgentCallEvent>): Promise<AgentCallEvent[]> {
  const events: AgentCallEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** Every event parses, and exactly one `end` event comes last. Returns that event. */
function expectWellFormed(events: AgentCallEvent[]) {
  for (const event of events) {
    expect(AgentCallEventSchema.safeParse(event).success).toBe(true);
    expectJson(event);
  }
  expect(events.filter((event) => event.type === "end")).toHaveLength(1);
  const last = events.at(-1);
  if (last?.type !== "end") throw new Error("the stream did not end with an end event");
  return last;
}

export interface AgentRuntimeContractSubject {
  readonly runtime: AgentRuntime;
  /** A request that completes on its own. */
  readonly completing: AgentCallRequest;
  /** A request that fails on its own, e.g. the CLI exits non-zero. */
  readonly failing: AgentCallRequest;
  /** A request that keeps running until aborted. */
  readonly hanging: AgentCallRequest;
}

export function describeAgentRuntimeContract(name: string, setup: Setup<AgentRuntimeContractSubject>): void {
  describe(`AgentRuntime contract: ${name}`, () => {
    it("streams events that end with one completed end event", async () => {
      const { runtime, completing } = await setup();
      expect(expectWellFormed(await collect(runtime.launch(completing, liveSignal()))).outcome).toBe("completed");
    });

    it("reports a failed call as a failed end event with a reason", async () => {
      const { runtime, failing } = await setup();
      const end = expectWellFormed(await collect(runtime.launch(failing, liveSignal())));
      expect(end.outcome).toBe("failed");
      expect(end.error).toEqual(expect.any(String));
    });

    it("ends as aborted when the signal has already fired", async () => {
      const { runtime, completing } = await setup();
      expect(expectWellFormed(await collect(runtime.launch(completing, abortedSignal()))).outcome).toBe("aborted");
    });

    it("ends as aborted when the signal fires during the call", async () => {
      const { runtime, hanging } = await setup();
      const controller = new AbortController();
      const events = collect(runtime.launch(hanging, controller.signal));
      setTimeout(() => controller.abort(), 20);
      expect(expectWellFormed(await events).outcome).toBe("aborted");
    });
  });
}

export interface ModelHostContractSubject {
  readonly host: ModelHost;
  /** A model the host serves. */
  readonly expectedModel: string;
  /** The same adapter pointed at a host that is not running. */
  readonly downHost: ModelHost;
}

export function describeModelHostContract(name: string, setup: Setup<ModelHostContractSubject>): void {
  describe(`ModelHost contract: ${name}`, () => {
    it("lists its models with unique, non-empty names", async () => {
      const { host, expectedModel } = await setup();
      const result = await host.listModels(liveSignal());
      if (!result.ok) throw new Error(`listModels failed: ${result.error.message}`);
      expectJson(result.value);
      const names = result.value.map((model) => model.name);
      expect(names).toContain(expectedModel);
      expect(new Set(names).size).toBe(names.length);
      for (const modelName of names) expect(modelName).not.toBe("");
    });

    it("returns an error, not a throw, when the host is down", async () => {
      const { downHost } = await setup();
      const result = await downHost.listModels(liveSignal());
      expect(result.ok).toBe(false);
      if (!result.ok) expectPortError(result.error);
    });

    it("returns an aborted error when the signal has already fired", async () => {
      const { host } = await setup();
      const result = await host.listModels(abortedSignal());
      expect(result.ok).toBe(false);
      if (!result.ok) expectPortError(result.error, "aborted");
    });
  });
}

export interface ConnectorContractSubject {
  readonly connector: Connector;
  /** A tool the connector offers. */
  readonly expectedTool: string;
  /** The same adapter pointed at a system it cannot reach. */
  readonly downConnector: Connector;
}

export function describeConnectorContract(name: string, setup: Setup<ConnectorContractSubject>): void {
  describe(`Connector contract: ${name}`, () => {
    it("lists its tools with unique, non-empty names", async () => {
      const { connector, expectedTool } = await setup();
      const result = await connector.listTools(liveSignal());
      if (!result.ok) throw new Error(`listTools failed: ${result.error.message}`);
      expectJson(result.value);
      const names = result.value.map((tool) => tool.name);
      expect(names).toContain(expectedTool);
      expect(new Set(names).size).toBe(names.length);
      for (const tool of result.value) {
        expect(tool.name).not.toBe("");
        expect(typeof tool.description).toBe("string");
      }
    });

    it("reports healthy when it can reach its system", async () => {
      const { connector } = await setup();
      expect(await connector.health(liveSignal())).toStrictEqual({ ok: true, value: undefined });
    });

    it("returns errors, not throws, when its system is down", async () => {
      const { downConnector } = await setup();
      for (const result of [await downConnector.health(liveSignal()), await downConnector.listTools(liveSignal())]) {
        expect(result.ok).toBe(false);
        if (!result.ok) expectPortError(result.error);
      }
    });

    it("returns aborted errors when the signal has already fired", async () => {
      const { connector } = await setup();
      for (const result of [await connector.health(abortedSignal()), await connector.listTools(abortedSignal())]) {
        expect(result.ok).toBe(false);
        if (!result.ok) expectPortError(result.error, "aborted");
      }
    });
  });
}

export interface SamplerContractSubject {
  readonly sampler: Sampler;
  /** The same adapter where its metrics source is missing (e.g. no macmon). */
  readonly downSampler: Sampler;
}

const METRICS = ["cpuPercent", "gpuPercent", "memoryUsedBytes", "powerWatts", "temperatureC"] as const;

export function describeSamplerContract(name: string, setup: Setup<SamplerContractSubject>): void {
  describe(`Sampler contract: ${name}`, () => {
    it("returns a timestamped sample with at least one valid metric", async () => {
      const { sampler } = await setup();
      const result = await sampler.sample(liveSignal());
      if (!result.ok) throw new Error(`sample failed: ${result.error.message}`);
      const sample = result.value;
      expectJson(sample);
      expect(Number.isSafeInteger(sample.at) && sample.at >= 0).toBe(true);
      const present = METRICS.filter((metric) => sample[metric] !== undefined);
      expect(present.length).toBeGreaterThan(0);
      for (const metric of present) {
        const value = sample[metric] ?? Number.NaN;
        expect(Number.isFinite(value) && value >= 0).toBe(true);
        if (metric.endsWith("Percent")) expect(value).toBeLessThanOrEqual(100);
      }
    });

    it("returns an error, not a throw, when its source is missing", async () => {
      const { downSampler } = await setup();
      const result = await downSampler.sample(liveSignal());
      expect(result.ok).toBe(false);
      if (!result.ok) expectPortError(result.error);
    });

    it("returns an aborted error when the signal has already fired", async () => {
      const { sampler } = await setup();
      const result = await sampler.sample(abortedSignal());
      expect(result.ok).toBe(false);
      if (!result.ok) expectPortError(result.error, "aborted");
    });
  });
}
