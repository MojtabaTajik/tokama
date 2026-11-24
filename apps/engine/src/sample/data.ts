// The sample data set of the fake engine mode: two workspaces on the local host, and items in
// every board stage, of both kinds and both privacy modes, one of them waiting for a decision.
// Plain JSON shapes; sample.ts parses them with the engine's schemas when it loads them.
// The "working" investigation is the one the tick moves (and loops); the others stay put.

export const NORTHWIND = "northwind-prod";
export const TAILSPIN = "tailspin-staging";
export const DECISION_ID = "decision_5e1c9a7b-3f2d-4c8e-9a6b-1d2e3f4a5b6c";

export const ITEM_IDS = {
  queued: "item_1a2b3c4d-0001-4a1b-8c1d-000000000001",
  working: "item_1a2b3c4d-0002-4a1b-8c1d-000000000002",
  needsYou: "item_1a2b3c4d-0003-4a1b-8c1d-000000000003",
  verifying: "item_1a2b3c4d-0004-4a1b-8c1d-000000000004",
  review: "item_1a2b3c4d-0005-4a1b-8c1d-000000000005",
  done: "item_1a2b3c4d-0006-4a1b-8c1d-000000000006",
  tailspinWorking: "item_1a2b3c4d-0007-4a1b-8c1d-000000000007",
  building: "item_1a2b3c4d-0008-4a1b-8c1d-000000000008",
  failed: "item_1a2b3c4d-0009-4a1b-8c1d-000000000009",
} as const;

const agents = {
  architect: { id: "architect", name: "Architect", cliId: "claude-code", model: "opus", runsOn: "cloud" },
  investigator: { id: "local-investigator", name: "Local investigator", cliId: "claude-code", model: "qwen3-coder:30b", runsOn: "local" },
  reviewer: { id: "reviewer", name: "Reviewer", cliId: "codex-cli", model: "gpt-5-codex", runsOn: "cloud" },
  builder: { id: "local-builder", name: "Local builder", cliId: "claude-code", model: "qwen3-coder:30b", runsOn: "local" },
};

const templates = {
  emergency: {
    id: "emergency-investigator",
    name: "Emergency investigator",
    kind: "investigation",
    connections: [
      { connectionId: "app-insights", access: "query" },
      { connectionId: "postgres-main", access: "read-only" },
      { connectionId: "azure-prod", access: "reader" },
    ],
    steps: [
      { name: "Triage", stage: "working", agentId: "local-investigator", data: "none" },
      {
        name: "Query logs and metrics",
        stage: "working",
        agentId: "local-investigator",
        data: "none",
        uses: [
          { connectionId: "app-insights", access: "query" },
          { connectionId: "postgres-main", access: "read-only" },
        ],
      },
      { name: "Find the cause", stage: "working", agentId: "local-investigator", data: "none" },
      { name: "Propose a fix", stage: "review", agentId: "architect", data: "summary-after-approval" },
    ],
  },
  slowQuery: {
    id: "db-slow-query",
    name: "DB slow query check",
    kind: "investigation",
    connections: [{ connectionId: "postgres-main", access: "read-only" }],
    steps: [
      {
        name: "Collect slow queries",
        stage: "working",
        agentId: "local-investigator",
        data: "none",
        uses: [{ connectionId: "postgres-main", access: "read-only" }],
      },
      { name: "Explain plans", stage: "working", agentId: "local-investigator", data: "none" },
      { name: "Summarize", stage: "review", agentId: "local-investigator", data: "none" },
    ],
  },
  planAndBuild: {
    id: "plan-and-build",
    name: "Plan and build",
    kind: "task",
    connections: [],
    steps: [
      { name: "Plan", stage: "working", agentId: "architect", data: "repo-and-diff" },
      { name: "Build", stage: "working", agentId: "local-builder", data: "none" },
      { name: "Run checks", stage: "verifying", data: "none" },
      { name: "Review", stage: "review", agentId: "reviewer", data: "repo-and-diff" },
    ],
  },
  quickFix: {
    id: "quick-fix",
    name: "Quick fix",
    kind: "task",
    connections: [],
    steps: [
      { name: "Fix", stage: "working", agentId: "local-builder", data: "none" },
      { name: "Run checks", stage: "verifying", data: "none" },
    ],
  },
  reviewOnly: {
    id: "review-only",
    name: "Review only",
    kind: "task",
    connections: [],
    steps: [{ name: "Review", stage: "review", agentId: "reviewer", data: "repo-and-diff" }],
  },
};

export const sampleWorkspaces = [
  {
    id: NORTHWIND,
    name: "Northwind prod",
    host: "local",
    repos: [
      { id: "orders-api", baseBranch: "main" },
      { id: "checkout-web", baseBranch: "main" },
    ],
    connections: [
      { id: "app-insights", name: "App Insights (prod)", type: "App Insights" },
      { id: "postgres-main", name: "Postgres main", type: "Postgres" },
      { id: "azure-prod", name: "Azure prod", type: "Azure" },
      { id: "grafana", name: "Grafana", type: "MCP server" },
    ],
    agents: [agents.architect, agents.investigator, agents.reviewer, agents.builder],
    templates: [templates.emergency, templates.slowQuery, templates.planAndBuild, templates.quickFix, templates.reviewOnly],
  },
  {
    id: TAILSPIN,
    name: "Tailspin staging",
    host: "local",
    repos: [{ id: "inventory-service", baseBranch: "develop" }],
    connections: [{ id: "postgres-staging", name: "Postgres staging", type: "Postgres" }],
    agents: [agents.builder, agents.reviewer],
    templates: [templates.quickFix, templates.reviewOnly],
  },
];

type StepState = "pending" | "running" | "needs_you" | "passed" | "failed";

/** The template's steps with these states and detail lines (a passed step without one says "passed"). */
function steps(template: { steps: readonly object[] }, states: readonly StepState[], details: Record<number, string> = {}) {
  return template.steps.map((step, index) => {
    const state = states[index] ?? "pending";
    const detail = details[index] ?? (state === "passed" ? "passed" : undefined);
    return { ...step, state, ...(detail ? { detail } : {}) };
  });
}

const MINUTE = 60_000;

/** The sample items, created minutes before `now`. */
export function sampleItems(now: number) {
  const base = { schemaVersion: 1 };
  return [
    {
      ...base,
      id: ITEM_IDS.queued,
      kind: "task",
      workspaceId: NORTHWIND,
      templateId: templates.planAndBuild.id,
      title: "Add retry with backoff to the payment client",
      text: "Add retry with backoff to the payment client in orders-api. Retry 5xx and timeouts, at most 3 times.",
      repoIds: ["orders-api"],
      privacy: "local_and_cloud",
      state: "queued",
      createdAt: now - 2 * MINUTE,
      cardLine: "waiting for a free agent",
      steps: steps(templates.planAndBuild, []),
    },
    {
      ...base,
      id: ITEM_IDS.working,
      kind: "investigation",
      workspaceId: NORTHWIND,
      templateId: templates.emergency.id,
      title: "Checkout latency spike",
      text: "Alert: checkout p95 latency above 1.5 s for 10 minutes (orders-api, prod).",
      repoIds: [],
      privacy: "local_and_cloud",
      state: "running",
      createdAt: now - 14 * MINUTE,
      cardLine: "p95 1.8s · 3 of 10 queries",
      steps: steps(templates.emergency, ["passed", "running"], { 0: "scope: checkout, last 30 min", 1: "waits for App Insights query results" }),
    },
    {
      ...base,
      id: ITEM_IDS.building,
      kind: "task",
      workspaceId: NORTHWIND,
      templateId: templates.planAndBuild.id,
      title: "Paginate the orders list",
      text: "The orders list loads every order at once. Add cursor pagination to the API and the list.",
      repoIds: ["orders-api", "checkout-web"],
      privacy: "local_and_cloud",
      state: "running",
      createdAt: now - 33 * MINUTE,
      cardLine: "turn 18 of 40",
      steps: steps(templates.planAndBuild, ["passed", "running"], { 0: "plan approved", 1: "waits for Local builder on Ollama" }),
    },
    {
      ...base,
      id: ITEM_IDS.needsYou,
      kind: "investigation",
      workspaceId: NORTHWIND,
      templateId: templates.emergency.id,
      title: "Orders API returns 500 after deploy",
      text: "Alert: orders-api 5xx rate at 4% since the 14:02 deploy.",
      repoIds: ["orders-api"],
      privacy: "local_and_cloud",
      state: "needs_you",
      createdAt: now - 41 * MINUTE,
      cardLine: "cause found · null customer region",
      decision: {
        id: DECISION_ID,
        stepIndex: 3,
        question: "Send the redacted findings summary (1.2 KB) to Architect on Claude Code?",
        why: "Propose a fix runs on a cloud agent; its data rule sends a summary after your approval.",
        summaryText:
          "orders-api returns 500 on POST /orders since the 14:02 deploy. Cause: customers without a region " +
          "(about 3% of requests) hit a null reference in TaxCalculator. Evidence: 6 queries, error rate 4.1%. " +
          "Customer names and ids are redacted.",
        choices: [
          { id: "approve", label: "Approve and send" },
          { id: "stop", label: "Stop" },
        ],
      },
      steps: steps(templates.emergency, ["passed", "passed", "passed", "needs_you"], { 0: "scope: orders-api, last 2 h", 1: "6 queries · 41 rows", 2: "null customer region in TaxCalculator", 3: "waits for your approval of the cloud step" }),
    },
    {
      ...base,
      id: ITEM_IDS.verifying,
      kind: "task",
      workspaceId: NORTHWIND,
      templateId: templates.quickFix.id,
      title: "Fix rounding in invoice totals",
      text: "Invoice totals are off by one cent for some multi-currency orders.",
      repoIds: ["orders-api"],
      privacy: "local_only",
      state: "running",
      createdAt: now - 23 * MINUTE,
      cardLine: "pnpm test · 212 of 340",
      steps: steps(templates.quickFix, ["passed", "running"], { 0: "2 files changed", 1: "runs pnpm test" }),
    },
    {
      ...base,
      id: ITEM_IDS.review,
      kind: "task",
      workspaceId: NORTHWIND,
      templateId: templates.planAndBuild.id,
      title: "Add order export endpoint",
      text: "Add GET /orders/export that streams orders as CSV, filtered by date range.",
      repoIds: ["orders-api", "checkout-web"],
      privacy: "local_and_cloud",
      state: "running",
      createdAt: now - 95 * MINUTE,
      cardLine: "+184 −21 · 6 files",
      steps: steps(templates.planAndBuild, ["passed", "passed", "passed", "running"], { 1: "+184 −21 · 6 files", 2: "pnpm test · 340 passed", 3: "waits for the Reviewer verdict" }),
    },
    {
      ...base,
      id: ITEM_IDS.done,
      kind: "investigation",
      workspaceId: NORTHWIND,
      templateId: templates.slowQuery.id,
      title: "Slow query on order_items",
      text: "order_items lookups take 900 ms at peak.",
      repoIds: [],
      privacy: "local_only",
      state: "done",
      createdAt: now - 180 * MINUTE,
      cardLine: "missing index on order_items(order_id)",
      steps: steps(templates.slowQuery, ["passed", "passed", "passed"]),
    },
    {
      ...base,
      id: ITEM_IDS.failed,
      kind: "task",
      workspaceId: NORTHWIND,
      templateId: templates.quickFix.id,
      title: "Upgrade the Postgres driver in orders-api",
      text: "Upgrade the Postgres driver in orders-api to the next major version.",
      repoIds: ["orders-api"],
      privacy: "local_only",
      state: "failed",
      createdAt: now - 130 * MINUTE,
      cardLine: "checks failed 3 times",
      steps: steps(templates.quickFix, ["passed", "failed"], { 1: "pnpm test: 4 failing after 3 attempts" }),
    },
    {
      ...base,
      id: ITEM_IDS.tailspinWorking,
      kind: "task",
      workspaceId: TAILSPIN,
      templateId: templates.quickFix.id,
      title: "Flaky inventory sync test",
      text: "InventorySyncTest fails about one run in ten on CI.",
      repoIds: ["inventory-service"],
      privacy: "local_only",
      state: "running",
      createdAt: now - 6 * MINUTE,
      cardLine: "attempt 2 of 3",
      steps: steps(templates.quickFix, ["running"], { 0: "waits for Local builder on Ollama" }),
    },
  ];
}
