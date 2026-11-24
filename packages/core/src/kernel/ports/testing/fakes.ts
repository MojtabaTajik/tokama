// In-memory fakes of each port, for contract tests and for slice tests that need a backend.
// Not part of the build output.
import type { Clock } from "../../clock/index.js";
import { err, ok } from "../../result/index.js";
import type { AgentCallEvent, TokenUsage } from "../../schemas/index.js";
import type { AgentCallRequest, AgentRuntime, Connector, MachineSample, ModelHost, ModelInfo, PortError, Sampler, ToolInfo } from "../index.js";

const NO_TOKENS: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const ABORTED: PortError = { code: "aborted", message: "aborted" };
const DOWN: PortError = { code: "unavailable", message: "fake backend is down" };

const whenAborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });

/** What the fake agent does with a request. */
export type FakeAgentReply =
  | { readonly kind: "complete"; readonly text: readonly string[]; readonly usage: TokenUsage }
  | { readonly kind: "fail"; readonly error: string }
  /** Runs until aborted. */
  | { readonly kind: "hang" };

/** By default the agent echoes the prompt. */
export function createFakeAgentRuntime(
  reply: (request: AgentCallRequest) => FakeAgentReply = (request) => ({ kind: "complete", text: [request.prompt], usage: NO_TOKENS }),
): AgentRuntime {
  const aborted: AgentCallEvent = { type: "end", outcome: "aborted", usage: NO_TOKENS };
  return {
    async *launch(request, signal) {
      const plan = reply(request);
      if (plan.kind === "fail") {
        yield { type: "end", outcome: "failed", usage: NO_TOKENS, error: plan.error };
        return;
      }
      if (plan.kind === "hang") {
        await whenAborted(signal);
        yield aborted;
        return;
      }
      for (const text of plan.text) {
        if (signal.aborted) break;
        yield { type: "text", text };
      }
      yield signal.aborted ? aborted : { type: "end", outcome: "completed", usage: plan.usage };
    },
  };
}

export function createFakeModelHost(models: readonly ModelInfo[], { up = true } = {}): ModelHost {
  return {
    listModels(signal) {
      if (signal.aborted) return Promise.resolve(err(ABORTED));
      return Promise.resolve(up ? ok(models.map((model) => ({ ...model }))) : err(DOWN));
    },
  };
}

export function createFakeConnector(tools: readonly ToolInfo[], { up = true } = {}): Connector {
  return {
    listTools(signal) {
      if (signal.aborted) return Promise.resolve(err(ABORTED));
      return Promise.resolve(up ? ok(tools.map((tool) => ({ ...tool }))) : err(DOWN));
    },
    health(signal) {
      if (signal.aborted) return Promise.resolve(err(ABORTED));
      return Promise.resolve(up ? ok(undefined) : err(DOWN));
    },
  };
}

export function createFakeSampler(clock: Clock, metrics: Omit<MachineSample, "at">, { up = true } = {}): Sampler {
  return {
    sample(signal) {
      if (signal.aborted) return Promise.resolve(err(ABORTED));
      return Promise.resolve(up ? ok({ at: clock.now(), ...metrics }) : err(DOWN));
    },
  };
}
