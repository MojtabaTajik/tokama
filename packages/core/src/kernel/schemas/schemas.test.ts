import { describe, expect, it } from "vitest";
import {
  API_VERSION,
  AgentCallEventSchema,
  parseAgentCallUsage,
  parseAgentId,
  parseCallId,
  parseClientMessage,
  parseDecisionId,
  parseEngineMessage,
  parseHandshakeReply,
  parseHelloMessage,
  parseItemId,
  parseItemRecord,
  parseQueryResult,
  parseServerMessage,
  parseTemplateId,
  parseWith,
  parseWorkspaceId,
} from "./index.js";

const ITEM_ID = "item_0b9f3c1e-6a2d-4f7b-9c1a-2e3d4f5a6b7c";
const CALL_ID = "call_1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const DECISION_ID = "decision_2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a";

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
    {
      apiVersion: API_VERSION,
      kind: "command",
      requestId: "r2",
      command: { type: "resolve_decision", itemId: ITEM_ID, decisionId: DECISION_ID, choice: "approve" },
    },
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
    ["a decision without an id", { apiVersion: API_VERSION, kind: "command", requestId: "r1", command: { type: "resolve_decision", itemId: ITEM_ID, choice: "approve" } }],
    ["an empty choice", { apiVersion: API_VERSION, kind: "command", requestId: "r1", command: { type: "resolve_decision", itemId: ITEM_ID, decisionId: DECISION_ID, choice: "" } }],
    ["the removed approve_step command", { apiVersion: API_VERSION, kind: "command", requestId: "r1", command: { type: "approve_step", itemId: ITEM_ID, stepIndex: 0 } }],
    ["a negative seq", { apiVersion: API_VERSION, kind: "event", seq: -1, event: { type: "item_updated", item: item() } }],
    ["an event with an invalid record", { apiVersion: API_VERSION, kind: "event", seq: 2, event: { type: "item_updated", item: { ...item(), schemaVersion: 9 } } }],
    ["reply data that is not JSON", { apiVersion: API_VERSION, kind: "reply", requestId: "r1", result: { ok: true, data: () => 1 } }],
    ["extra fields", { ...valid[2], token: "secret" }],
  ])("refuses %s", (_label, message) => {
    expect(parseEngineMessage(message).ok).toBe(false);
  });
});

describe("direction-specific parsers", () => {
  const command = { apiVersion: API_VERSION, kind: "command", requestId: "r1", command: { type: "stop_item", itemId: ITEM_ID } };
  const query = { apiVersion: API_VERSION, kind: "query", requestId: "r2", query: { type: "item", itemId: ITEM_ID } };
  const reply = { apiVersion: API_VERSION, kind: "reply", requestId: "r2", result: { ok: true, data: null } };
  const event = { apiVersion: API_VERSION, kind: "event", seq: 0, event: { type: "item_updated", item: item() } };

  it("parseClientMessage accepts commands and queries only", () => {
    expect([command, query, reply, event].map((message) => parseClientMessage(message).ok)).toEqual([true, true, false, false]);
  });

  it("parseServerMessage accepts replies and events only", () => {
    expect([command, query, reply, event].map((message) => parseServerMessage(message).ok)).toEqual([false, false, true, true]);
  });
});

describe("id parsers", () => {
  it.each([
    ["workspace", parseWorkspaceId, "northwind-prod", "Northwind Prod"],
    ["template", parseTemplateId, "plan-and-build", "-plan"],
    ["agent", parseAgentId, "local-investigator", "a".repeat(65)],
    ["item", parseItemId, ITEM_ID, CALL_ID],
    ["call", parseCallId, CALL_ID, "call_"],
    ["decision", parseDecisionId, DECISION_ID, ITEM_ID],
  ] as const)("%s id: accepts its format, refuses others", (_label, parse, valid, invalid) => {
    expect(parse(valid)).toEqual({ ok: true, value: valid });
    expect(parse(invalid).ok).toBe(false);
    expect(parse(42).ok).toBe(false);
  });
});

describe("handshake messages", () => {
  it("accepts a hello with any integer apiVersion and unknown fields", () => {
    const hello = { kind: "hello", apiVersion: API_VERSION + 7, token: "t0k", client: "future" };
    expect(parseHelloMessage(hello)).toMatchObject({ ok: true, value: { apiVersion: API_VERSION + 7 } });
  });

  it.each([
    ["no token", { kind: "hello", apiVersion: 1 }],
    ["an empty token", { kind: "hello", apiVersion: 1, token: "" }],
    ["a fractional version", { kind: "hello", apiVersion: 1.5, token: "t" }],
    ["a query instead", { apiVersion: 1, kind: "query", requestId: "r1", query: { type: "item", itemId: ITEM_ID } }],
  ])("refuses a hello with %s", (_label, hello) => {
    expect(parseHelloMessage(hello).ok).toBe(false);
  });

  it("reads welcomes and connection errors of any version", () => {
    expect(parseHandshakeReply({ kind: "welcome", apiVersion: 1, engineId: "e1" }).ok).toBe(true);
    const refusal = { kind: "connection_error", apiVersion: 9, code: "unsupported_version", message: "engine speaks 9" };
    expect(parseHandshakeReply(refusal)).toEqual({ ok: true, value: refusal });
    expect(parseHandshakeReply({ kind: "connection_error", apiVersion: 1, code: "", message: "" }).ok).toBe(false);
  });

  it("keeps handshake messages out of the normal message parsers", () => {
    expect(parseClientMessage({ kind: "hello", apiVersion: API_VERSION, token: "t" }).ok).toBe(false);
    expect(parseServerMessage({ kind: "welcome", apiVersion: API_VERSION, engineId: "e1" }).ok).toBe(false);
  });
});

describe("query results", () => {
  it("parses board and item data", () => {
    expect(parseQueryResult("board", { items: [item()] })).toEqual({ ok: true, value: { items: [item()] } });
    expect(parseQueryResult("item", { item: item() })).toEqual({ ok: true, value: { item: item() } });
  });

  it("refuses data of the wrong shape", () => {
    expect(parseQueryResult("board", { item: item() }).ok).toBe(false);
    expect(parseQueryResult("item", { item: { ...item(), state: "lost" } }).ok).toBe(false);
  });
});
