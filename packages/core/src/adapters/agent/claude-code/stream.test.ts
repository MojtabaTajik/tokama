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
    expect(events.map((event) => event.type)).toEqual(["rate_limit", "turn", "text", "tool_call", "tool_result", "turn", "text", "tool_call", "tool_result", "turn", "text"]);
    expect(events).toContainEqual({ type: "tool_result", id: "call_cv9c3hv0" });
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

  it("keeps the CLI's own cost estimate from a recorded result", () => {
    expect(parse(fixture("success")).state.costUsd).toBeCloseTo(0.0281862, 6);
    expect(parse(fixture("logged-out")).state.costUsd).toBe(0);
  });

  it("keeps an earlier cost when a later result reports zeroed totals, and has none without a result", () => {
    const { state } = parse([
      line({ type: "result", is_error: false, total_cost_usd: 0.42, modelUsage: {} }),
      line({ type: "result", is_error: true, total_cost_usd: 0, modelUsage: {} }),
    ]);
    expect(state.costUsd).toBe(0.42);
    expect(parse([line({ type: "assistant", message: { id: "m1", content: [] } })]).state.costUsd).toBeUndefined();
    expect(parse([line({ type: "result", is_error: false, total_cost_usd: "free" })]).state.costUsd).toBeUndefined();
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

  it("records no absolute path: a path outside the working directory becomes a distinct hash", () => {
    const { events } = parse(
      [
        line({ type: "system", subtype: "init", cwd: "/private/tmp/repo" }),
        toolUse("t1", "Read", { file_path: "/private/tmp/repo/src/a.ts", offset: 10, limit: 20 }),
        toolUse("t2", "Read", { file_path: "/tmp/repo/src/b.ts" }),
        toolUse("t3", "Read", { file_path: "/Users/someone/.ssh/config" }),
        toolUse("t4", "Grep", { pattern: "x", path: "/private/tmp/repo-other" }),
        toolUse("t5", "Glob", { pattern: "*.ts", path: "/tmp/repo" }),
        toolUse("t6", "Read", { file_path: "/Users/someone/.ssh/id_rsa" }),
        toolUse("t7", "Read", { file_path: "src/../../escape.txt" }),
        toolUse("t8", "Read", { file_path: "src/../ok.txt" }),
      ],
      "/tmp/repo",
    );
    expect(calls(events).map((event) => event.type === "tool_call" && event.input)).toEqual([
      { file_path: "src/a.ts", offset: 10, limit: 20 },
      { file_path: "src/b.ts" },
      { file_path: expect.stringMatching(/^outside:[0-9a-f]{16}$/) },
      { pattern: "x", path: expect.stringMatching(/^outside:[0-9a-f]{16}$/) },
      { pattern: "*.ts", path: "." },
      { file_path: expect.stringMatching(/^outside:[0-9a-f]{16}$/) },
      { file_path: expect.stringMatching(/^outside:/) },
      { file_path: "ok.txt" },
    ]);
    const inputs = calls(events).map((event) => (event.type === "tool_call" ? event.input : {}));
    expect(inputs[2]?.["file_path"]).not.toBe(inputs[5]?.["file_path"]);
    expect(JSON.stringify(events)).not.toContain("someone");
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
    expect(inputs[4]).toEqual({ url: "https://tokama.dev", prompt: "summarize", nested: expect.stringMatching(/^[0-9a-f]{16}$/) });
    expect(calls(events).map((event) => event.type === "tool_call" && event.kind)).toEqual(["command", "edit", "edit", "edit", "other"]);
  });

  it("keeps objects and arrays as a hash, so two different todo lists are not a repeat", () => {
    const { events } = parse([
      toolUse("t1", "TodoWrite", { todos: [{ content: "a", status: "pending" }] }),
      toolUse("t2", "TodoWrite", { todos: [{ content: "a", status: "completed" }] }),
    ]);
    const inputs = calls(events).map((event) => (event.type === "tool_call" ? event.input : {}));
    expect(inputs[0]?.["todos"]).toMatch(/^[0-9a-f]{16}$/);
    expect(inputs[0]).not.toEqual(inputs[1]);
  });

  it("writes the working directory as . and the home directory as ~ in other strings", () => {
    const parser = createStreamParser("/home/dev/work/repo", "/home/dev");
    const events = [
      line({ type: "system", subtype: "init", cwd: "/private/home/dev/work/repo" }),
      toolUse("t1", "Bash", { command: "cd /home/dev/work/repo && cat /home/dev/.npmrc /private/home/dev/work/repo/a" }),
    ].flatMap((text) => parser.line(text));
    expect(calls(events)[0]).toMatchObject({ input: { command: "cd . && cat ~/.npmrc ./a" } });
    expect(parser.scrub("ENOENT: /home/dev/work/repo/x and /home/dev/y")).toBe("ENOENT: ./x and ~/y");
  });

  it("does not count a subagent's messages as the parent's turns or tool calls, only as a sign of life", () => {
    const sub = line({ type: "assistant", parent_tool_use_id: "toolu_task", message: { id: "s1", content: [{ type: "tool_use", id: "st1", name: "Bash", input: { command: "ls" } }], usage: { input_tokens: 7 } } });
    const subResult = line({ type: "user", parent_tool_use_id: "toolu_task", message: { content: [{ type: "tool_result", tool_use_id: "st1" }] } });
    const { events, state } = parse([sub, subResult, toolUse("t1", "Bash", { command: "ls" })]);
    expect(events.map((event) => event.type)).toEqual(["subagent", "subagent", "turn", "tool_call"]);
    expect(state.usage.input).toBe(7);
  });

  it("keeps the result's subtype", () => {
    expect(parse(fixture("execution-error")).state.result).toMatchObject({ isError: true, subtype: "error_during_execution" });
  });

  it("emits one turn per message and one tool call per tool-use id", () => {
    const text = (id: string) => line({ type: "assistant", message: { id, content: [{ type: "text", text: "x" }] } });
    const { events } = parse([text("m1"), toolUse("t1", "Bash", { command: "ls" }, "m1"), toolUse("t1", "Bash", { command: "ls" }, "m1"), text("m2")]);
    expect(events.map((event) => event.type)).toEqual(["turn", "text", "tool_call", "turn", "text"]);
  });

  it("ends a tool call once per result, and leaves a subagent's results and a prompt out", () => {
    const result = (id: string, parent: string | null = null) => line({ type: "user", parent_tool_use_id: parent, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
    const { events } = parse([
      toolUse("t1", "Bash", { command: "pnpm test" }, "m1"),
      result("t1"),
      result("t1"),
      result("s1", "t9"),
      line({ type: "user", message: { role: "user", content: "the prompt" } }),
      line({ type: "user", message: { content: [{ type: "tool_result" }, { type: "text", text: "x" }] } }),
    ]);
    expect(events.filter((event) => event.type === "tool_result")).toEqual([{ type: "tool_result", id: "t1" }]);
  });

  it("records the first line of a tool result that says the sandbox is required but not working, in either text shape", () => {
    const required = "Sandbox is required (sandbox.failIfUnavailable) and stopped being available in this session: bwrap went away";
    const result = (content: unknown, extra: object = {}) => line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true, content }] }, ...extra });
    expect(parse([result(`${required}\nmore`)]).state.sandboxFailure).toBe(required);
    expect(parse([result([{ type: "text", text: `${required}\nmore` }])]).state.sandboxFailure).toBe(required);
    expect(parse([result("Sandbox is required but failed to initialize: socat not found")]).state.sandboxFailure).toBe("Sandbox is required but failed to initialize: socat not found");
    // A subagent's commands are refused too.
    expect(parse([result(required, { parent_tool_use_id: "toolu_parent" })]).state.sandboxFailure).toBe(required);
    expect(parse([result("x".repeat(1_000).replace(/^/, "Sandbox is required "))]).state.sandboxFailure).toHaveLength(300);
  });

  it("does not take a command's own output for a sandbox failure", () => {
    const result = (content: unknown) => line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content }] } });
    expect(parse([result("Read-only file system"), result("echo: Sandbox is required"), result(["no text here"]), result(undefined)]).state.sandboxFailure).toBeUndefined();
    expect(parse(fixture("success")).state.sandboxFailure).toBeUndefined();
    // A command that succeeded and printed the words, such as `cat NOTES.md`, is not a refusal.
    const printed = line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "Sandbox is required for the build\nmore" }] } });
    expect(parse([printed]).state.sandboxFailure).toBeUndefined();
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

describe("Claude Code stream parser: stored hash format", () => {
  // Known vector: the first 16 hex characters of SHA-256 over the path's UTF-8 bytes. Stored inputs
  // are compared across versions, so the format must not change.
  it("writes an outside path as outside:<16 hex characters of its SHA-256>", () => {
    const parser = createStreamParser("/tmp/repo", "/home/nobody");
    const events = parser.line(line({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/Users/someone/.ssh/config" } }] } }));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_call", input: { file_path: "outside:52ac51c7fcad9fbe" } }));
  });
});
