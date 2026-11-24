// Test data for the drawer: a setup with local and cloud agents and connections, an
// investigation waiting for a cloud-step approval, and a task. Plain literals cast to the engine
// types; drawer/describe.test.ts checks them against the engine schemas.
import type { ItemRecord, Setup } from "@tokama/core";

export const DECISION_ID = "decision_5e1c9a7b-3f2d-4c8e-9a6b-1d2e3f4a5b6c";

export const setup = {
  repos: [{ id: "orders-api", baseBranch: "main" }],
  connections: [
    { id: "app-insights-prod", name: "App Insights · prod", type: "App Insights" },
    { id: "postgres-prod", name: "Postgres · prod", type: "Postgres" },
  ],
  agents: [
    { id: "architect", name: "Architect", cliId: "claude-code", model: "opus", runsOn: "cloud" },
    { id: "local-investigator", name: "Local investigator", cliId: "claude-code", model: "qwen3-coder:30b", runsOn: "local" },
    { id: "reviewer", name: "Reviewer", cliId: "codex-cli", model: "gpt-5-codex", runsOn: "cloud" },
    { id: "local-builder", name: "Local builder", cliId: "claude-code", model: "qwen3-coder:30b", runsOn: "local" },
  ],
  templates: [
    { id: "emergency-investigator", name: "Emergency investigator", icon: "fire", color: "rose", kind: "investigation", connections: [], steps: [{ name: "Triage", stage: "working", data: "none" }] },
    { id: "plan-and-build", name: "Plan and build", icon: "hammer", color: "sky", kind: "task", connections: [], steps: [{ name: "Plan", stage: "working", data: "none" }] },
  ],
} as unknown as Setup;

export const needsYou = {
  schemaVersion: 1,
  id: "item_1a2b3c4d-0003-4a1b-8c1d-000000000003",
  kind: "investigation",
  templateId: "emergency-investigator",
  title: "Orders API returns 500 after deploy",
  text: "Alert: orders-api 5xx rate at 4% since the 14:02 deploy.",
  repoIds: ["orders-api"],
  privacy: "local_and_cloud",
  state: "needs_you",
  createdAt: 1_760_000_000_000,
  decision: {
    id: DECISION_ID,
    stepIndex: 3,
    question: "Send the redacted findings summary to Architect on Claude Code?",
    why: "Propose a fix runs on a cloud agent; its data rule sends a summary after your approval.",
    summaryText: "orders-api returns 500 on POST /orders.\nCause: null customer region in TaxCalculator.",
    choices: [
      { id: "approve", label: "Approve and send" },
      { id: "stop", label: "Stop" },
    ],
  },
  steps: [
    { name: "Triage", stage: "working", state: "passed", agentId: "local-investigator", data: "none", detail: "scope: orders-api, last 2 h" },
    {
      name: "Query logs and metrics",
      stage: "working",
      state: "passed",
      agentId: "local-investigator",
      data: "none",
      uses: [
        { connectionId: "app-insights-prod", access: "query" },
        { connectionId: "postgres-prod", access: "read-only" },
      ],
      detail: "6 queries · 41 rows",
    },
    { name: "Find the cause", stage: "working", state: "passed", agentId: "local-investigator", data: "none" },
    { name: "Propose a fix", stage: "review", state: "needs_you", agentId: "architect", data: "summary-after-approval", detail: "waits for your approval of the cloud step" },
  ],
} as unknown as ItemRecord;

/** The same item once the approval went through: the cloud step runs. */
export const approved = {
  ...needsYou,
  state: "running",
  decision: undefined,
  steps: needsYou.steps.map((step, index) => (index === 3 ? { ...step, state: "running", detail: "approved · runs on Architect (opus)" } : step)),
} as unknown as ItemRecord;
delete (approved as { decision?: unknown }).decision;

export const task = {
  schemaVersion: 1,
  id: "item_1a2b3c4d-0008-4a1b-8c1d-000000000008",
  kind: "task",
  templateId: "plan-and-build",
  title: "Paginate the orders list",
  text: "Add cursor pagination.",
  repoIds: ["orders-api"],
  privacy: "local_and_cloud",
  state: "running",
  createdAt: 1_760_000_000_001,
  steps: [
    { name: "Plan", stage: "working", state: "passed", agentId: "architect", data: "repo-and-diff", detail: "plan approved" },
    { name: "Build", stage: "working", state: "running", agentId: "local-builder", data: "none", detail: "turn 18 of 40" },
    { name: "Run checks", stage: "verifying", state: "pending", data: "none" },
    { name: "Review", stage: "review", state: "pending", agentId: "reviewer", data: "repo-and-diff" },
  ],
} as unknown as ItemRecord;
