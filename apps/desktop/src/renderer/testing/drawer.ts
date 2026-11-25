// Test data for the drawer: a setup with local and cloud agents and connections, an
// investigation waiting for a cloud-step approval, and a task. Plain literals cast to the engine
// types; drawer/describe.test.ts checks them against the engine schemas.
import type { ItemRecord, Setup } from "@tokama/core";

export const DECISION_ID = "decision_5e1c9a7b-3f2d-4c8e-9a6b-1d2e3f4a5b6c";

export const setup = {
  repos: [{ id: "orders-api", baseBranch: "main", checks: ["pnpm test"], path: "~/code/orders-api" }],
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
    { id: "builtin/emergency-investigator", name: "Emergency investigator", icon: "fire", color: "rose", kind: "investigation", connections: [], steps: [{ name: "Triage", stage: "working", data: "none" }], start: { needs: ["text"], askBeforeCloud: false }, warnings: [] },
    { id: "builtin/plan-and-build", name: "Plan and build", icon: "hammer", color: "sky", kind: "task", connections: [], steps: [{ name: "Plan", stage: "working", data: "none" }], start: { needs: ["text", "repo"], askBeforeCloud: false }, warnings: [] },
  ],
  health: { git: { ok: true }, clis: [], config: [] },
} as unknown as Setup;

export const needsYou = {
  schemaVersion: 1,
  id: "item_1a2b3c4d-0003-4a1b-8c1d-000000000003",
  kind: "investigation",
  templateId: "builtin/emergency-investigator",
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
  templateId: "builtin/plan-and-build",
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

/** A finished task as real mode sends it: attempts with checks, and the commit it made. */
export const committed = {
  ...task,
  id: "item_1a2b3c4d-0010-4a1b-8c1d-000000000010",
  templateId: "builtin/plan-and-build",
  state: "done",
  steps: [
    {
      name: "Plan",
      stage: "working",
      state: "passed",
      agentId: "architect",
      data: "repo-and-diff",
      detail: "passed on attempt 2",
      attempts: [
        { attempt: 1, result: "failed", checks: [{ command: "sh check.sh", passed: false, exitCode: 1 }] },
        { attempt: 2, result: "passed", checks: [{ command: "sh check.sh", passed: true, exitCode: 0 }] },
      ],
    },
  ],
  outcome: { kind: "done", commits: [{ repoId: "orders-api", commit: "3f2a9c1d4e5f60718293a4b5c6d7e8f901234567", branch: "tokama/0b9f3c1e" }] },
} as unknown as ItemRecord;

/** A done task whose worktree is still there: Finish offers Merge, Open PR and Discard. */
export const finishable = {
  ...committed,
  id: "item_1a2b3c4d-0011-4a1b-8c1d-000000000011",
  finish: { worktreeRemoved: false, pushTarget: "github.com/northwind/orders-api" },
} as unknown as ItemRecord;

/** A task whose Review stopped at its limit after Build fixed what it asked for. */
export const stoppedReview = {
  ...task,
  id: "item_1a2b3c4d-0013-4a1b-8c1d-000000000013",
  title: "Keep the start card still while it fades",
  state: "needs_you",
  decision: {
    id: "decision_5e1c9a7b-3f2d-4c8e-9a6b-1d2e3f4a5b6f",
    kind: "after_failure",
    stepIndex: 3,
    question: "The step failed. Retry it, or end the item?",
    why: "Step Review reached its limit of 1 attempts.",
    stopped: {
      limit: true,
      then: { kind: "later", stepIndex: 1, attempt: 2, result: "passed", checks: { passed: 2, total: 2 } },
      why: "Review may run once per round, so it has not checked the fix.",
    },
    choices: [
      { id: "one_more_attempt", label: "Run Review again" },
      { id: "no_action_needed", label: "End: no action needed" },
      { id: "stop", label: "Stop" },
    ],
  },
  steps: [
    { name: "Plan", stage: "working", state: "passed", agentId: "architect", data: "repo-and-diff", detail: "plan approved", attempts: [{ attempt: 1, result: "passed", checks: [] }] },
    {
      name: "Build",
      stage: "working",
      state: "passed",
      agentId: "local-builder",
      data: "none",
      detail: "passed on attempt 2",
      attempts: [
        { attempt: 1, result: "passed", checks: [] },
        { attempt: 2, result: "passed", checks: [] },
      ],
    },
    { name: "Run checks", stage: "verifying", state: "passed", data: "none", detail: "passed" },
    {
      name: "Review",
      stage: "review",
      state: "needs_you",
      agentId: "reviewer",
      data: "repo-and-diff",
      detail: "waits for you",
      runs: 1,
      maxAttempts: 1,
      attempts: [{ attempt: 1, result: "failed", detail: "The reviewer asked for changes.", checks: [] }],
    },
  ],
} as unknown as ItemRecord;
