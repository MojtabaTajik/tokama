// Test data shaped like the fake engine's sample set: one setup and items
// in every state. Plain literals cast to the engine types; model.test.ts checks them against the
// engine schemas, so they cannot drift from the API.
import type { ItemRecord, Setup } from "@tokama/core";

const id = (n: number) => `item_1a2b3c4d-000${n}-4a1b-8c1d-00000000000${n}`;
const step = (name: string, stage: string, state: string, agentId?: string) => ({ name, stage, state, data: "none", ...(agentId ? { agentId } : {}) });
const template = (templateId: string, kind: string) => ({ id: templateId, name: templateId, kind, connections: [], steps: [{ name: "Work", stage: "working", data: "none" }] });

export const setup = {
  repos: [
    { id: "orders-api", baseBranch: "main" },
    { id: "checkout-web", baseBranch: "main" },
    { id: "inventory-service", baseBranch: "develop" },
  ],
  connections: [
    { id: "app-insights-prod", name: "App Insights · prod", type: "App Insights" },
    { id: "postgres-prod", name: "Postgres · prod", type: "Postgres" },
    { id: "postgres-staging", name: "Postgres · staging", type: "Postgres" },
    { id: "azure-prod", name: "Azure · prod", type: "Azure" },
    { id: "grafana-prod", name: "Grafana · prod", type: "MCP server" },
  ],
  agents: [{ id: "local-builder", name: "Local builder", cliId: "claude-code", model: "qwen3-coder:30b", runsOn: "local" }],
  templates: [
    template("emergency-investigator", "investigation"),
    template("db-slow-query", "investigation"),
    template("plan-and-build", "task"),
    template("quick-fix", "task"),
    template("review-only", "task"),
  ],
} as unknown as Setup;

const item = (n: number, fields: Record<string, unknown>) => ({
  schemaVersion: 1,
  id: id(n),
  kind: "task",
  templateId: "quick-fix",
  text: "",
  repoIds: [],
  privacy: "local_only",
  createdAt: 1_760_000_000_000 + n,
  ...fields,
});

export const ITEMS = {
  queued: item(1, { title: "Add retry with backoff", repoIds: ["orders-api"], state: "queued", steps: [step("Fix", "working", "pending", "local-builder")] }),
  working: item(2, {
    kind: "investigation",
    templateId: "emergency-investigator",
    title: "Checkout p95 latency spike",
    state: "running",
    steps: [step("Triage", "working", "passed"), step("Query logs", "working", "running"), step("Propose a fix", "review", "pending")],
  }),
  needsYou: item(3, {
    kind: "investigation",
    templateId: "emergency-investigator",
    repoIds: ["orders-api"],
    title: "Orders API returns 500 after deploy",
    state: "needs_you",
    steps: [step("Find the cause", "working", "passed"), step("Propose a fix", "review", "needs_you")],
  }),
  verifying: item(4, { title: "Fix rounding in invoice totals", repoIds: ["orders-api"], state: "running", steps: [step("Fix", "working", "passed"), step("Run checks", "verifying", "running")] }),
  done: item(5, { title: "Bump the Postgres driver", state: "done", steps: [step("Fix", "working", "passed")] }),
  failed: item(6, { title: "Flaky checkout test", state: "failed", steps: [step("Fix", "working", "failed")] }),
  stock: item(7, {
    repoIds: ["inventory-service"],
    title: "Stock sync drops <b>items</b>",
    state: "running",
    steps: [step("Fix", "working", "running")],
  }),
} as unknown as Record<"queued" | "working" | "needsYou" | "verifying" | "done" | "failed" | "stock", ItemRecord>;

export const items: ItemRecord[] = Object.values(ITEMS);
