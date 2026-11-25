import { describe, expect, it } from "vitest";
import {
  MAX_CHECK_CHARS,
  API_VERSION,
  AgentCallEventSchema,
  COMMAND_ERROR_CODES,
  parseCommandResult,
  itemStage,
  parseAgentId,
  parseCallId,
  parseClientMessage,
  parseCommand,
  parseDecisionId,
  parseEngineMessage,
  parseHandshakeReply,
  parseHelloMessage,
  parseItemId,
  parseItemRecord,
  parseQuery,
  parseQueryResult,
  parseServerMessage,
  parseTemplateId,
  parseWith,
  AgentCallUsageSchema,
  UsageReportSchema,
} from "./index.js";

const parseAgentCallUsage = (input: unknown) => parseWith(AgentCallUsageSchema, input);

const ITEM_ID = "item_0b9f3c1e-6a2d-4f7b-9c1a-2e3d4f5a6b7c";
const CALL_ID = "call_1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const DECISION_ID = "decision_2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a";

const item = () => ({
  schemaVersion: 1,
  id: ITEM_ID,
  kind: "investigation",
  templateId: "builtin/emergency-investigator",
  title: "Checkout latency spike",
  text: "Alert: checkout p95 above 1.5 s",
  repoIds: ["orders-api"],
  privacy: "local_only",
  state: "running",
  createdAt: 1_760_000_000_000,
  steps: [
    {
      name: "Triage",
      stage: "working",
      state: "passed",
      agentId: "local-investigator",
      data: "none",
      uses: [{ connectionId: "app-insights", access: "query" }],
      detail: "scope: checkout, last 30 min",
    },
    { name: "Run checks", stage: "verifying", state: "pending", data: "none" },
  ],
});

const usage = () => ({
  callId: CALL_ID,
  stepId: "plan",
  attempt: 1,
  agentId: "architect",
  cliId: "claude-code",
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
    ["an unknown stage", { steps: [{ name: "x", stage: "doing", state: "pending", data: "none" }] }, "steps.0.stage"],
    ["an unknown step state", { steps: [{ name: "x", stage: "working", state: "skipped", data: "none" }] }, "steps.0.state"],
    ["an unknown data rule", { steps: [{ name: "x", stage: "working", state: "pending", data: "everything" }] }, "steps.0.data"],
    ["an unknown privacy mode", { privacy: "public" }, "privacy"],
    ["a step use without access", { steps: [{ name: "x", stage: "working", state: "pending", data: "none", uses: [{ connectionId: "pg" }] }] }, "steps.0.uses.0.access"],
    ["the removed hint field", { hint: "x" }, ""],
    ["the removed waitingFor field", { steps: [{ name: "x", stage: "working", state: "pending", data: "none", waitingFor: "y" }] }, "steps.0"],
    ["a decision without choices", { decision: { id: DECISION_ID, stepIndex: 0, question: "Go?", choices: [] } }, "decision.choices"],
    ["an unknown kind", { kind: "chore" }, "kind"],
    ["a malformed item id", { id: "item_1" }, "id"],
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
  it("accepts a valid record, with or without the optional facts", () => {
    expect(parseAgentCallUsage(usage())).toEqual({ ok: true, value: usage() });
    const full = {
      ...usage(),
      models: { "claude-opus-5-5": { input: 1200, output: 340, cacheRead: 9000, cacheWrite: 0 } },
      reportedCostUsd: 0.31,
      plan: { status: "allowed", windows: [{ window: "five_hour", usedPercent: 36, resetsAt: 1_760_010_000_000 }], at: 1_760_000_041_000 },
    };
    expect(parseAgentCallUsage(full)).toEqual({ ok: true, value: full });
  });

  it("requires the step, the attempt and the CLI", () => {
    for (const key of ["stepId", "attempt", "cliId"]) expect(paths(parseAgentCallUsage(without(usage(), key)))).toContain(key);
  });

  it.each([
    ["negative tokens", { tokens: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 } }, "tokens.input"],
    ["a missing token type", { tokens: { input: 1, output: 0, cacheRead: 0 } }, "tokens.cacheWrite"],
    ["an unknown outcome", { outcome: "guarded" }, "outcome"],
    ["an end before the start", { endedAt: 1_759_999_999_999 }, "endedAt"],
    ["a malformed call id", { callId: ITEM_ID }, "callId"],
    ["a negative reported cost", { reportedCostUsd: -1 }, "reportedCostUsd"],
    ["an unknown CLI", { cliId: "gemini" }, "cliId"],
  ])("refuses %s", (_label, patch, path) => {
    expect(paths(parseAgentCallUsage({ ...usage(), ...patch }))).toContain(path);
  });
});

describe("usage report", () => {
  const report = () => ({
    range: 14,
    asOf: 1_760_000_000_000,
    pricesAsOf: "2026-11-03",
    clis: [
      { cliId: "claude-code", windows: [{ window: "five_hour", usedPercent: 36, resetsAt: 1_760_010_000_000 }], source: "request", asOf: 1_759_999_000_000, plan: "max", extraUsage: "off" },
      { cliId: "codex-cli", windows: [], note: "Codex comes later." },
    ],
    days: [{ date: "2025-10-09", workflows: [{ templateId: "plan-and-build", tokens: 1200, costUsd: null, items: [{ itemId: ITEM_ID, title: "Add order export" }], itemCount: 1 }] }],
    workflows: [{ templateId: "plan-and-build", tokens: 1200, costUsd: 0.5, calls: 2 }],
    items: [
      {
        itemId: ITEM_ID,
        title: "Add order export",
        templateId: "plan-and-build",
        agents: [{ agentId: "architect", cliId: "claude-code" }],
        tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
        durationMs: 60_000,
        costUsd: 0.5,
        local: false,
      },
    ],
    totals: { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, costUsd: 0.5, calls: 2, unpricedCalls: 0 },
  });

  it("accepts a report with unknown plan windows and unpriced costs", () => {
    expect(parseWith(UsageReportSchema, report())).toEqual({ ok: true, value: report() });
  });

  it.each([
    ["a range the query does not offer", { range: 7 }, "range"],
    ["a price date that is not a date", { pricesAsOf: "November" }, "pricesAsOf"],
    ["an unknown plan source", { clis: [{ cliId: "claude-code", windows: [], source: "guess" }] }, "clis.0.source"],
  ])("refuses %s", (_label, patch, path) => {
    expect(paths(parseWith(UsageReportSchema, { ...report(), ...patch }))).toContain(path);
  });

  it("refuses a usage query for another range", () => {
    expect(parseQuery({ type: "usage", range: 7 }).ok).toBe(false);
    expect(parseQuery({ type: "usage", range: 90 }).ok).toBe(true);
  });
});

describe("agent call events", () => {
  it.each([
    [{ type: "text", text: "hello" }],
    [{ type: "end", outcome: "completed", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }],
    [{ type: "end", outcome: "failed", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, error: "exit 1" }],
    [{ type: "started", pid: 4242 }],
    [{ type: "rate_limit", status: "allowed", windows: [{ window: "five_hour", usedPercent: 12.5, resetsAt: 1_760_000_000_000 }] }],
    [
      {
        type: "end",
        outcome: "failed",
        usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
        modelUsage: { "claude-haiku-5-5": { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } },
        error: "Not logged in",
        errorKind: "auth",
        sessionId: "49dd4f9f-cdba-4d4c-ba9f-3c815dc5dc14",
        durationMs: 25,
      },
    ],
  ])("accepts %j", (event) => {
    expect(parseWith(AgentCallEventSchema, event).ok).toBe(true);
  });

  it.each([
    [{ type: "turn" }],
    [{ type: "tool_call", id: "t1", name: "Bash", kind: "command", input: { command: "npm test" } }],
    [{ type: "tool_call", id: "t2", name: "Edit", kind: "edit", input: { file_path: "a.ts", old: "x", new: { lines: [1, null] } } }],
  ])("accepts %j", (event) => {
    expect(parseWith(AgentCallEventSchema, event).ok).toBe(true);
  });

  it("refuses an end without usage", () => {
    expect(parseWith(AgentCallEventSchema, { type: "end", outcome: "completed" }).ok).toBe(false);
  });

  it.each([
    ["a tool call without an id", { type: "tool_call", id: "", name: "Bash", kind: "command", input: {} }],
    ["a tool call of an unknown kind", { type: "tool_call", id: "t1", name: "Bash", kind: "shell", input: {} }],
    ["a tool call whose input is not an object", { type: "tool_call", id: "t1", name: "Bash", kind: "command", input: "npm test" }],
    ["extra fields on a turn", { type: "turn", id: "m1" }],
    ["a started event without a pid", { type: "started", pid: 0 }],
    ["an unknown error kind", { type: "end", outcome: "failed", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, errorKind: "network" }],
    ["a negative rate-limit percent", { type: "rate_limit", status: "allowed", windows: [{ window: "five_hour", usedPercent: -1 }] }],
  ])("refuses %s", (_label, event) => {
    expect(parseWith(AgentCallEventSchema, event).ok).toBe(false);
  });
});

describe("engine API messages", () => {
  const valid = [
    {
      apiVersion: API_VERSION,
      kind: "command",
      requestId: "r1",
      command: {
        type: "start_item",
        templateId: "builtin/plan-and-build",
        repoIds: ["orders-api"],
        text: "Add retries",
        options: { askBeforeCloud: false, notify: true },
      },
    },
    {
      apiVersion: API_VERSION,
      kind: "command",
      requestId: "r2",
      command: { type: "resolve_decision", itemId: ITEM_ID, decisionId: DECISION_ID, choice: "approve" },
    },
    { apiVersion: API_VERSION, kind: "command", requestId: "r3", command: { type: "stop_item", itemId: ITEM_ID } },
    { apiVersion: API_VERSION, kind: "query", requestId: "r4", query: { type: "board" } },
    { apiVersion: API_VERSION, kind: "query", requestId: "r5", query: { type: "item", itemId: ITEM_ID } },
    { apiVersion: API_VERSION, kind: "query", requestId: "r6", query: { type: "setup" } },
    { apiVersion: API_VERSION, kind: "query", requestId: "r7", query: { type: "suggest_template", text: "5xx on /cart" } },
    { apiVersion: API_VERSION, kind: "reply", requestId: "r4", result: { ok: true, data: { items: [] } } },
    { apiVersion: API_VERSION, kind: "reply", requestId: "r5", result: { ok: false, error: { code: "not_found", message: "no item" } } },
    { apiVersion: API_VERSION, kind: "event", seq: 0, event: { type: "item_updated", item: item() } },
    { apiVersion: API_VERSION, kind: "event", seq: 1, event: { type: "usage_changed" } },
    { apiVersion: API_VERSION, kind: "query", requestId: "r8", query: { type: "usage", range: 30 } },
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
    ["a blank start text", { apiVersion: API_VERSION, kind: "command", requestId: "r1", command: { type: "start_item", templateId: "builtin/quick-fix", repoIds: [], text: " \n " } }],
    ["an unknown start option", { apiVersion: API_VERSION, kind: "command", requestId: "r1", command: { type: "start_item", templateId: "builtin/quick-fix", repoIds: [], text: "x", options: { yolo: true } } }],
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

  it("parseQuery and parseCommand take a bare query or command", () => {
    expect(parseQuery(query.query)).toEqual({ ok: true, value: query.query });
    expect(parseCommand(command.command)).toEqual({ ok: true, value: command.command });
    expect(parseQuery(command.command).ok).toBe(false);
    expect(parseCommand(query.query).ok).toBe(false);
    expect(parseQuery({ type: "board", extra: 1 }).ok).toBe(false);
    expect(parseQuery(query).ok).toBe(false);
  });
});

describe("id parsers", () => {
  it.each([
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

describe("check command length", () => {
  it("allows MAX_CHECK_CHARS (500) characters per check in add_repo and in a repo suggestion, and no more", () => {
    expect(MAX_CHECK_CHARS).toBe(500);
    const check = (length: number) => "x".repeat(length);
    expect(parseCommand({ type: "add_repo", path: "/a", checks: [check(500)] }).ok).toBe(true);
    expect(parseCommand({ type: "add_repo", path: "/a", checks: [check(501)] }).ok).toBe(false);
    const suggestion = { path: "/a", gitRepo: true, branch: "main", id: "a", problem: null };
    expect(parseQueryResult("suggest_repo", { ...suggestion, checks: [check(500)] }).ok).toBe(true);
    expect(parseQueryResult("suggest_repo", { ...suggestion, checks: [check(501)] }).ok).toBe(false);
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

describe("itemStage", () => {
  const steps = (...states: string[]) =>
    states.map((state, index) => ({ name: `s${index}`, stage: index === 0 ? "working" : "review", state, data: "none" }));
  const stageOf = (state: string, stepStates: string[]) => {
    const parsed = parseItemRecord({ ...item(), state, steps: steps(...stepStates) });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
    return itemStage(parsed.value);
  };

  it.each([
    ["queued", ["pending", "pending"], "queued"],
    ["running", ["running", "pending"], "working"],
    ["needs_you", ["passed", "needs_you"], "review"],
    ["done", ["passed", "passed"], "done"],
    ["stopped", ["stopped", "pending"], "done"],
  ])("puts a %s item with steps %j in %s", (state, stepStates, stage) => {
    expect(stageOf(state, stepStates)).toBe(stage);
  });
});

describe("setup query result", () => {
  const setup = {
    repos: [{ id: "orders-api", baseBranch: "main", checks: [] }],
    connections: [{ id: "postgres-prod", name: "Postgres · prod", type: "Postgres" }],
    agents: [{ id: "architect", name: "Architect", cliId: "claude-code", model: "opus", runsOn: "cloud" }],
    templates: [
      {
        id: "orders-api/review-only",
        name: "Review only",
        kind: "task",
        connections: [{ connectionId: "postgres-prod", access: "read-only" }],
        steps: [
          { name: "Review", stage: "review", agentId: "architect", data: "repo-and-diff", uses: [{ connectionId: "postgres-prod", access: "read-only" }] },
          { name: "Build", stage: "working", agentId: "architect", data: "repo-and-diff", checks: { from: "repo" } },
        ],
        start: { needs: ["text", "repo"], askBeforeCloud: false },
        setup: "pnpm install",
        warnings: [],
      },
    ],
    health: {
      git: { ok: true, version: "git version 2.54.0" },
      clis: [{ cliId: "claude-code", installed: true, loggedIn: false, message: "Claude Code is not logged in." }],
      config: [{ file: "repos.yaml", message: "repos.yaml line 2: base_branch is missing" }],
    },
  };

  it("accepts a valid result", () => {
    expect(parseQueryResult("setup", setup)).toEqual({ ok: true, value: setup });
  });

  it("passes a template's icon and tag colour through", () => {
    const tagged = { ...setup, templates: [{ ...setup.templates[0], icon: "screwdriver-wrench", color: "moss" }] };
    expect(parseQueryResult("setup", tagged)).toEqual({ ok: true, value: tagged });
  });

  it.each([
    ["a template colour outside the 8 tag colours", { templates: [{ ...setup.templates[0], color: "red" }] }, "templates.0.color"],
    ["a template icon that is not an icon name", { templates: [{ ...setup.templates[0], icon: "Fire Icon" }] }, "templates.0.icon"],
    ["a template without steps", { templates: [{ ...setup.templates[0], steps: [] }] }, "templates.0.steps"],
    ["a template id without its repo", { templates: [{ ...setup.templates[0], id: "review-only" }] }, "templates.0.id"],
    ["a template without its start", { templates: [{ ...setup.templates[0], start: undefined }] }, "templates.0.start"],
    ["a CLI health entry for an unknown CLI", { health: { ...setup.health, clis: [{ cliId: "gemini", installed: true, loggedIn: true }] } }, "health.clis.0.cliId"],
    ["an unknown AI CLI", { agents: [{ ...setup.agents[0], cliId: "gemini" }] }, "agents.0.cliId"],
    ["an agent that runs nowhere", { agents: [{ ...setup.agents[0], runsOn: "edge" }] }, "agents.0.runsOn"],
    ["an uppercase repo id", { repos: [{ id: "Orders", baseBranch: "main" }] }, "repos.0.id"],
    ["an unknown field", { color: "red" }, ""],
  ])("refuses %s", (_label, patch, path) => {
    expect(paths(parseQueryResult("setup", { ...setup, ...patch }))).toContain(path);
  });
});

describe("command results", () => {
  it("parses each command's reply data", () => {
    expect(parseCommandResult("start_item", { itemId: ITEM_ID })).toEqual({ ok: true, value: { itemId: ITEM_ID } });
    expect(parseCommandResult("resolve_decision", null)).toEqual({ ok: true, value: null });
    expect(parseCommandResult("stop_item", null)).toEqual({ ok: true, value: null });
  });

  it.each([
    ["start_item", { itemId: "item_1" }],
    ["start_item", null],
    ["stop_item", { itemId: ITEM_ID }],
  ] as const)("refuses %s data %j", (type, data) => {
    expect(parseCommandResult(type, data).ok).toBe(false);
  });

  it("lists the command error codes", () => {
    expect(COMMAND_ERROR_CODES).toContain("stale_decision");
    expect(COMMAND_ERROR_CODES).toContain("not_implemented");
  });
});

describe("decision", () => {
  it("accepts why and summaryText for a cloud-step approval", () => {
    const decision = {
      id: DECISION_ID,
      stepIndex: 1,
      question: "Send the summary to Architect?",
      why: "The step runs on a cloud agent.",
      summaryText: "Request: 5xx on /cart",
      choices: [{ id: "approve", label: "Approve and send" }],
    };
    const parsed = parseItemRecord({ ...item(), state: "needs_you", decision });
    expect(parsed.ok && parsed.value.decision).toEqual(decision);
  });
});
