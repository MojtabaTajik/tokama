// Test data shaped like the fake engine's sample set: two workspaces on the local host and items
// in every state. Plain literals cast to the engine types; model.test.ts checks them against the
// engine schemas, so they cannot drift from the API.
import type { ItemRecord, WorkspaceSummary } from "@tokama/core";

const id = (n: number) => `item_1a2b3c4d-000${n}-4a1b-8c1d-00000000000${n}`;
const step = (name: string, stage: string, state: string, agentId?: string) => ({ name, stage, state, data: "none", ...(agentId ? { agentId } : {}) });
const template = (templateId: string, kind: string) => ({ id: templateId, name: templateId, kind, connections: [], steps: [{ name: "Work", stage: "working", data: "none" }] });

export const workspaces = [
  {
    id: "northwind-prod",
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
    agents: [{ id: "local-builder", name: "Local builder", cliId: "claude-code", model: "qwen3-coder:30b", runsOn: "local" }],
    templates: [
      template("emergency-investigator", "investigation"),
      template("db-slow-query", "investigation"),
      template("plan-and-build", "task"),
      template("quick-fix", "task"),
      template("review-only", "task"),
    ],
  },
  {
    id: "tailspin-staging",
    name: "Tailspin staging",
    host: "local",
    repos: [{ id: "inventory-service", baseBranch: "develop" }],
    connections: [{ id: "postgres-staging", name: "Postgres staging", type: "Postgres" }],
    agents: [],
    templates: [template("quick-fix", "task"), template("review-only", "task")],
  },
] as unknown as WorkspaceSummary[];

const item = (n: number, fields: Record<string, unknown>) => ({
  schemaVersion: 1,
  id: id(n),
  kind: "task",
  workspaceId: "northwind-prod",
  templateId: "quick-fix",
  text: "",
  repoIds: [],
  privacy: "local_only",
  createdAt: 1_760_000_000_000 + n,
  ...fields,
});

export const ITEMS = {
  queued: item(1, { title: "Add retry with backoff", state: "queued", steps: [step("Fix", "working", "pending", "local-builder")] }),
  working: item(2, {
    kind: "investigation",
    title: "Checkout p95 latency spike",
    state: "running",
    steps: [step("Triage", "working", "passed"), step("Query logs", "working", "running"), step("Propose a fix", "review", "pending")],
  }),
  needsYou: item(3, {
    kind: "investigation",
    title: "Orders API returns 500 after deploy",
    state: "needs_you",
    steps: [step("Find the cause", "working", "passed"), step("Propose a fix", "review", "needs_you")],
  }),
  verifying: item(4, { title: "Fix rounding in invoice totals", state: "running", steps: [step("Fix", "working", "passed"), step("Run checks", "verifying", "running")] }),
  done: item(5, { title: "Bump the Postgres driver", state: "done", steps: [step("Fix", "working", "passed")] }),
  failed: item(6, { title: "Flaky checkout test", state: "failed", steps: [step("Fix", "working", "failed")] }),
  tailspin: item(7, {
    workspaceId: "tailspin-staging",
    title: "Stock sync drops <b>items</b>",
    state: "running",
    steps: [step("Fix", "working", "running")],
  }),
} as unknown as Record<"queued" | "working" | "needsYou" | "verifying" | "done" | "failed" | "tailspin", ItemRecord>;

export const items: ItemRecord[] = Object.values(ITEMS);
