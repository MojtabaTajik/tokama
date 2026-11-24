import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentCallEventSchema, type AgentCallEvent } from "../../../kernel/schemas/index.js";
import { classifyFailure, createStreamParser, type StreamState } from "./stream.js";

// Stream parsing cases ported from ai-pipeline tests/test_claude_call.py (metrics from the result,
// fallback to `usage`, garbage lines), on the stream-json fixtures the fake CLI replays.

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "testing", "fixtures", `${name}.jsonl`), "utf8").split("\n");

function parse(lines: readonly string[], cwd = "/tmp/fixture/repo") {
  const parser = createStreamParser(cwd);
  const events: AgentCallEvent[] = lines.flatMap((line) => parser.line(line));
  for (const event of events) expect(AgentCallEventSchema.safeParse(event).success).toBe(true);
  return { events, state: parser.state() };
}

const line = (value: unknown) => JSON.stringify(value);

describe("Claude Code stream parser", () => {
  it("turns a recorded run into turns, text, tool calls and rate-limit events", () => {
    const { events } = parse(fixture("success"));
    expect(events.map((event) => event.type)).toEqual(["rate_limit", "turn", "text", "tool_call", "turn", "text", "tool_call", "turn", "text"]);
    expect(events).toContainEqual({ type: "tool_call", id: "call_cv9c3hv0", name: "Write", kind: "edit", input: { file_path: "hello.py", change: expect.stringMatching(/^[0-9a-f]{16}$/) } });
    expect(events).toContainEqual({ type: "tool_call", id: "call_va0yxsz1", name: "Bash", kind: "command", input: { command: "python3 hello.py" } });
  });

  it("keeps the session id and sums tokens by type from modelUsage", () => {
    const { state } = parse(fixture("success"));
    expect(state.sessionId).toBe("d4bc8b9c-641c-40df-bc38-952463fb9366");
    expect(state.result?.isError).toBe(false);
    expect(state.usage).toEqual({ input: 5440, output: 213, cacheRead: 10831, cacheWrite: 0 });
    expect(state.modelUsage).toEqual({ "qwen3-coder:30b": { input: 5440, output: 213, cacheRead: 10831, cacheWrite: 0 } });
  });

  it("sums modelUsage over every model the call used", () => {
    const { state } = parse([
      line({
        type: "result",
        is_error: false,
        modelUsage: {
          "claude-opus-5-5": { inputTokens: 4, outputTokens: 191, cacheReadInputTokens: 7385, cacheCreationInputTokens: 7479 },
          "claude-haiku-5-5": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ]);
    expect(state.usage).toEqual({ input: 14, output: 196, cacheRead: 7385, cacheWrite: 7479 });
  });

  it("falls back to the result's usage when modelUsage is empty", () => {
    const { state } = parse([line({ type: "result", is_error: false, modelUsage: {}, usage: { input_tokens: 5, output_tokens: 7 } })]);
    expect(state.usage).toEqual({ input: 5, output: 7, cacheRead: 0, cacheWrite: 0 });
    expect(state.modelUsage).toBeUndefined();
  });

  it("without a result, counts each message's usage once, not once per content block", () => {
    const message = (id: string, input: number) =>
      line({ type: "assistant", message: { id, content: [{ type: "text", text: "x" }], usage: { input_tokens: input, output_tokens: 1 } } });
    const { state } = parse([message("m1", 100), message("m1", 100), message("m2", 50)]);
    expect(state.usage).toEqual({ input: 150, output: 2, cacheRead: 0, cacheWrite: 0 });
  });

  it("converts rate-limit utilization to percent and reset times to epoch ms", () => {
    const { events } = parse(fixture("success"));
    expect(events[0]).toEqual({
      type: "rate_limit",
      status: "allowed",
      windows: [
        { window: "five_hour", usedPercent: 42, resetsAt: 1_795_000_000_000 },
        { window: "seven_day", usedPercent: 12.34, resetsAt: 1_795_500_000_000 },
      ],
    });
    const single = parse([line({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.9 } })]);
    expect(single.events).toEqual([{ type: "rate_limit", status: "allowed_warning", windows: [{ window: "seven_day", usedPercent: 90 }] }]);
  });

  const toolUse = (id: string, name: string, input: Record<string, unknown>, messageId = id) =>
    line({ type: "assistant", message: { id: messageId, content: [{ type: "tool_use", id, name, input }] } });
  const calls = (events: AgentCallEvent[]) => events.filter((event) => event.type === "tool_call");

  it("records no absolute path: paths outside the working directory become outside: true", () => {
    const { events } = parse(
      [
        line({ type: "system", subtype: "init", cwd: "/private/tmp/repo" }),
        toolUse("t1", "Read", { file_path: "/private/tmp/repo/src/a.ts", offset: 10, limit: 20 }),
        toolUse("t2", "Read", { file_path: "/tmp/repo/src/b.ts" }),
        toolUse("t3", "Read", { file_path: "/Users/someone/.ssh/config" }),
        toolUse("t4", "Grep", { pattern: "x", path: "/private/tmp/repo-other" }),
        toolUse("t5", "Glob", { pattern: "*.ts", path: "/tmp/repo" }),
      ],
      "/tmp/repo",
    );
    expect(calls(events).map((event) => event.type === "tool_call" && event.input)).toEqual([
      { file_path: "src/a.ts", offset: 10, limit: 20 },
      { file_path: "src/b.ts" },
      { outside: true },
      { pattern: "x", outside: true },
      { pattern: "*.ts", path: "." },
    ]);
  });

  it("keeps only identity fields: no descriptions, and an edit's change as a short hash", () => {
    const { events } = parse([
      toolUse("t1", "Bash", { command: "npm test", description: "Run the tests", timeout: 60000 }),
      toolUse("t2", "Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }),
      toolUse("t3", "Edit", { file_path: "src/a.ts", old_string: "a", new_string: "c" }),
      toolUse("t4", "Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }),
      toolUse("t5", "WebFetch", { url: "https://tokama.dev", prompt: "summarize", nested: { x: 1 } }),
    ]);
    const inputs = calls(events).map((event) => (event.type === "tool_call" ? event.input : {}));
    expect(inputs[0]).toEqual({ command: "npm test", timeout: 60000 });
    expect(inputs[1]?.["change"]).not.toBe(inputs[2]?.["change"]);
    expect(inputs[1]).toEqual(inputs[3]);
    expect(inputs[1]).toEqual({ file_path: "src/a.ts", change: expect.any(String) });
    expect(inputs[4]).toEqual({ url: "https://tokama.dev", prompt: "summarize" });
    expect(calls(events).map((event) => event.type === "tool_call" && event.kind)).toEqual(["command", "edit", "edit", "edit", "other"]);
  });

  it("emits one turn per message and one tool call per tool-use id", () => {
    const text = (id: string) => line({ type: "assistant", message: { id, content: [{ type: "text", text: "x" }] } });
    const { events } = parse([text("m1"), toolUse("t1", "Bash", { command: "ls" }, "m1"), toolUse("t1", "Bash", { command: "ls" }, "m1"), text("m2")]);
    expect(events.map((event) => event.type)).toEqual(["turn", "text", "tool_call", "turn", "text"]);
  });

  it("skips lines that are not JSON, not objects, or not in the expected shape", () => {
    const { events, state } = parse([
      "",
      "warning: something",
      "{not json",
      "[1,2]",
      line({ type: "user", message: { content: [] } }),
      line({ type: "assistant", message: "not an object" }),
      line({ type: "rate_limit_event" }),
      line({ type: "something_new", x: 1 }),
    ]);
    expect(events).toEqual([]);
    expect(state).toEqual({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, limitRejected: false });
  });

  it("keeps a line whose counts are odd, counting them as absent", () => {
    const { state } = parse([line({ type: "result", is_error: false, usage: { input_tokens: -3, output_tokens: 2.5, cache_read_input_tokens: 4 } })]);
    expect(state.usage).toEqual({ input: 0, output: 0, cacheRead: 4, cacheWrite: 0 });
  });
});

describe("Claude Code failure classification", () => {
  const classified = (name: string, stderr = "") => classifyFailure(parse(fixture(name)).state, stderr);
  const state = (patch: Partial<StreamState>): StreamState => ({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, limitRejected: false, ...patch });

  it("classifies the recorded and constructed samples", () => {
    expect(classified("logged-out")).toBe("auth");
    expect(classified("quota")).toBe("quota");
    expect(classified("rate-limited")).toBe("rate_limit");
    expect(classified("execution-error")).toBe("crash");
  });

  it("uses the assistant message's error value first", () => {
    for (const code of ["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "verification_required", "cloud_credential_error"]) {
      expect(classifyFailure(state({ assistantError: { code, text: "" } }), "")).toBe("auth");
    }
    expect(classifyFailure(state({ assistantError: { code: "billing_error", text: "" } }), "")).toBe("quota");
    expect(classifyFailure(state({ assistantError: { code: "rate_limit", text: "" } }), "")).toBe("rate_limit");
    expect(classifyFailure(state({ assistantError: { code: "rate_limit", text: "" }, limitRejected: true }), "")).toBe("quota");
    expect(classifyFailure(state({ assistantError: { code: "server_error", text: "" } }), "")).toBe("crash");
  });

  it("falls back to the API status, then to the words of the result and stderr", () => {
    expect(classifyFailure(state({ result: { isError: true, text: "", apiErrorStatus: 401 } }), "")).toBe("auth");
    expect(classifyFailure(state({ result: { isError: true, text: "", apiErrorStatus: 429 } }), "")).toBe("rate_limit");
    expect(classifyFailure(state({ result: { isError: true, text: "Claude AI usage limit reached|1795000000" } }), "")).toBe("quota");
    expect(classifyFailure(state({}), "Invalid API key · Please run /login")).toBe("auth");
    expect(classifyFailure(state({}), "API Error: 429 rate_limit_error")).toBe("rate_limit");
    expect(classifyFailure(state({ result: { isError: true, text: "Context limit reached" } }), "")).toBe("crash");
    expect(classifyFailure(state({}), "Error: something broke")).toBe("crash");
  });
});
