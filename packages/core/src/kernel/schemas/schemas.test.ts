import { describe, expect, it } from "vitest";
import {
  API_VERSION,
  AgentCallEventSchema,
  parseAgentCallUsage,
  parseEngineMessage,
  parseItemRecord,
  parseWith,
} from "./index.js";

const ITEM_ID = "item_0b9f3c1e-6a2d-4f7b-9c1a-2e3d4f5a6b7c";
const CALL_ID = "call_1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

const item = () => ({
  schemaVersion: 1,
  id: ITEM_ID,
  kind: "investigation",
  workspaceId: "northwind-prod",
  templateId: "emergency-investigator",
  title: "Checkout latency spike",
  state: "running",
  createdAt: 1_760_000_000_000,
  steps: [
    { name: "Triage", stage: "working", state: "passed", agentId: "local-investigator" },
    { name: "Run checks", stage: "verifying", state: "pending" },
  ],
});

const usage = () => ({
  schemaVersion: 1,
  callId: CALL_ID,
  itemId: ITEM_ID,
  stepIndex: 0,
  agentId: "architect",
  model: "opus",
  outcome: "completed",
  startedAt: 1_760_000_000_000,
  endedAt: 1_760_000_042_000,
  tokens: { input: 1200, output: 340, cacheRead: 9000, cacheWrite: 0 },
});

const without = (record: object, key: string) => Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));

const paths = (result: { ok: boolean; error?: { issues: readonly { path: string }[] } }) =>
  result.ok ? [] : (result.error?.issues.map((issue) => issue.path) ?? []);

describe("item record", () => {
  it("accepts a valid record", () => {
    const result = parseItemRecord(item());
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.steps[1]?.agentId).toBeUndefined();
  });

  it("requires schemaVersion", () => {
    const result = parseItemRecord(without(item(), "schemaVersion"));
    expect(result.ok).toBe(false);
    expect(paths(result)).toContain("schemaVersion");
  });

  it("refuses another schemaVersion", () => {
    expect(paths(parseItemRecord({ ...item(), schemaVersion: 2 }))).toContain("schemaVersion");
  });

  it.each([
    ["an unknown stage", { steps: [{ name: "x", stage: "doing", state: "pending" }] }, "steps.0.stage"],
    ["an unknown step state", { steps: [{ name: "x", stage: "working", state: "skipped" }] }, "steps.0.state"],
    ["an unknown kind", { kind: "chore" }, "kind"],
    ["a malformed item id", { id: "item_1" }, "id"],
    ["an uppercase workspace id", { workspaceId: "Northwind" }, "workspaceId"],
    ["an empty title", { title: "" }, "title"],
    ["a fractional timestamp", { createdAt: 1.5 }, "createdAt"],
    ["an unknown field", { color: "red" }, ""],
  ])("refuses %s", (_label, patch, path) => {
    expect(paths(parseItemRecord({ ...item(), ...patch }))).toContain(path);
  });

  it("returns errors for non-objects instead of throwing", () => {
    for (const input of [null, undefined, 42, "item", []]) expect(parseItemRecord(input).ok).toBe(false);
  });
});

describe("agent call usage record", () => {
  it("accepts a valid record", () => {
    expect(parseAgentCallUsage(usage())).toEqual({ ok: true, value: usage() });
  });

  it("requires schemaVersion", () => {
    expect(paths(parseAgentCallUsage(without(usage(), "schemaVersion")))).toContain("schemaVersion");
  });

  it.each([
    ["negative tokens", { tokens: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 } }, "tokens.input"],
    ["a missing token type", { tokens: { input: 1, output: 0, cacheRead: 0 } }, "tokens.cacheWrite"],
    ["an unknown outcome", { outcome: "guarded" }, "outcome"],
    ["an end before the start", { endedAt: 1_759_999_999_999 }, "endedAt"],
    ["a malformed call id", { callId: ITEM_ID }, "callId"],
  ])("refuses %s", (_label, patch, path) => {
    expect(paths(parseAgentCallUsage({ ...usage(), ...patch }))).toContain(path);
  });
});

describe("agent call events", () => {
  it.each([
    [{ type: "text", text: "hello" }],
    [{ type: "end", outcome: "completed", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }],
    [{ type: "end", outcome: "failed", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, error: "exit 1" }],
  ])("accepts %j", (event) => {
    expect(parseWith(AgentCallEventSchema, event).ok).toBe(true);
  });

  it("refuses an end without usage", () => {
    expect(parseWith(AgentCallEventSchema, { type: "end", outcome: "completed" }).ok).toBe(false);
  });
});

describe("engine API messages", () => {
  const valid = [
    {
      apiVersion: API_VERSION,
      kind: "command",
      requestId: "r1",
      command: { type: "start_item", workspaceId: "northwind-prod", templateId: "plan-and-build", title: "Add retries" },
    },
    { apiVersion: API_VERSION, kind: "command", requestId: "r2", command: { type: "approve_step", itemId: ITEM_ID, stepIndex: 3 } },
    { apiVersion: API_VERSION, kind: "command", requestId: "r3", command: { type: "stop_item", itemId: ITEM_ID } },
    { apiVersion: API_VERSION, kind: "query", requestId: "r4", query: { type: "board", workspaceId: "northwind-prod" } },
    { apiVersion: API_VERSION, kind: "query", requestId: "r5", query: { type: "item", itemId: ITEM_ID } },
    { apiVersion: API_VERSION, kind: "reply", requestId: "r4", result: { ok: true, data: { items: [] } } },
    { apiVersion: API_VERSION, kind: "reply", requestId: "r5", result: { ok: false, error: { code: "not_found", message: "no item" } } },
    { apiVersion: API_VERSION, kind: "event", seq: 0, event: { type: "item_updated", item: item() } },
    { apiVersion: API_VERSION, kind: "event", seq: 1, event: { type: "usage_recorded", usage: usage() } },
  ];

  it.each(valid.map((message) => [`${message.kind} ${JSON.stringify(message).slice(0, 60)}`, message]))(
    "accepts %s",
    (_label, message) => {
      const result = parseEngineMessage(message);
      expect(result).toEqual({ ok: true, value: message });
    },
  );

  it("survives a JSON round trip", () => {
    for (const message of valid) expect(parseEngineMessage(JSON.parse(JSON.stringify(message))).ok).toBe(true);
  });

  it("requires apiVersion", () => {
    expect(paths(parseEngineMessage(without(valid[0] ?? {}, "apiVersion")))).toContain("apiVersion");
  });

  it("refuses another apiVersion", () => {
    expect(paths(parseEngineMessage({ ...valid[3], apiVersion: API_VERSION + 1 }))).toContain("apiVersion");
  });

  it.each([
    ["an unknown kind", { apiVersion: API_VERSION, kind: "rpc", requestId: "r1" }],
    ["an unknown command", { apiVersion: API_VERSION, kind: "command", requestId: "r1", command: { type: "delete_everything" } }],
    ["an empty requestId", { apiVersion: API_VERSION, kind: "query", requestId: "", query: { type: "item", itemId: ITEM_ID } }],
    ["a negative seq", { apiVersion: API_VERSION, kind: "event", seq: -1, event: { type: "item_updated", item: item() } }],
    ["an event with an invalid record", { apiVersion: API_VERSION, kind: "event", seq: 2, event: { type: "item_updated", item: { ...item(), schemaVersion: 9 } } }],
    ["reply data that is not JSON", { apiVersion: API_VERSION, kind: "reply", requestId: "r1", result: { ok: true, data: () => 1 } }],
    ["extra fields", { ...valid[2], token: "secret" }],
  ])("refuses %s", (_label, message) => {
    expect(parseEngineMessage(message).ok).toBe(false);
  });
});
