// The sample data set of the fake engine mode: one set of repos, connections, agents and templates, and items in
// every board stage, of both kinds and both privacy modes, one of them waiting for a decision.
// Plain JSON shapes; sample.ts parses them with the engine's schemas when it loads them.
// The "working" investigation is the one the tick moves (and loops); the others stay put.

export const DECISION_ID = "decision_5e1c9a7b-3f2d-4c8e-9a6b-1d2e3f4a5b6c";
/** The Quick change item's question: approve the diff it shows. */
export const DIFF_DECISION_ID = "decision_5e1c9a7b-3f2d-4c8e-9a6b-1d2e3f4a5b6d";

export const ITEM_IDS = {
  queued: "item_1a2b3c4d-0001-4a1b-8c1d-000000000001",
  working: "item_1a2b3c4d-0002-4a1b-8c1d-000000000002",
  needsYou: "item_1a2b3c4d-0003-4a1b-8c1d-000000000003",
  verifying: "item_1a2b3c4d-0004-4a1b-8c1d-000000000004",
  review: "item_1a2b3c4d-0005-4a1b-8c1d-000000000005",
  done: "item_1a2b3c4d-0006-4a1b-8c1d-000000000006",
  flaky: "item_1a2b3c4d-0007-4a1b-8c1d-000000000007",
  building: "item_1a2b3c4d-0008-4a1b-8c1d-000000000008",
  failed: "item_1a2b3c4d-0009-4a1b-8c1d-000000000009",
  quickChange: "item_1a2b3c4d-0010-4a1b-8c1d-000000000010",
  /** A done task with a commit on its branch: Finish offers Merge, Open PR and Discard. */
  finished: "item_1a2b3c4d-0011-4a1b-8c1d-000000000011",
} as const;

const agents = {
  architect: { id: "architect", name: "Architect", cliId: "claude-code", model: "opus", runsOn: "cloud" },
  investigator: { id: "local-investigator", name: "Local investigator", cliId: "claude-code", model: "qwen3-coder:30b", runsOn: "local" },
  reviewer: { id: "reviewer", name: "Reviewer", cliId: "codex-cli", model: "gpt-5-codex", runsOn: "cloud" },
  builder: { id: "local-builder", name: "Local builder", cliId: "claude-code", model: "qwen3-coder:30b", runsOn: "local" },
};

const templates = {
  emergency: {
    id: "builtin/emergency-investigator",
    name: "Emergency investigator",
    kind: "investigation",
    icon: "fire",
    color: "rose",
    connections: [
      { connectionId: "app-insights-prod", access: "query" },
      { connectionId: "postgres-prod", access: "read-only" },
      { connectionId: "azure-prod", access: "reader" },
    ],
    start: { needs: ["text"], askBeforeCloud: false },
    warnings: [],
    steps: [
      { name: "Triage", stage: "working", agentId: "local-investigator", data: "none" },
      {
        name: "Query logs and metrics",
        stage: "working",
        agentId: "local-investigator",
        data: "none",
        uses: [
          { connectionId: "app-insights-prod", access: "query" },
          { connectionId: "postgres-prod", access: "read-only" },
        ],
      },
      { name: "Find the cause", stage: "working", agentId: "local-investigator", data: "none" },
      { name: "Propose a fix", stage: "review", agentId: "architect", data: "summary-after-approval" },
    ],
  },
  slowQuery: {
    id: "builtin/db-slow-query",
    name: "DB slow query check",
    kind: "investigation",
    icon: "database",
    color: "clay",
    connections: [{ connectionId: "postgres-prod", access: "read-only" }],
    start: { needs: ["text"], askBeforeCloud: false },
    warnings: [],
    steps: [
      {
        name: "Collect slow queries",
        stage: "working",
        agentId: "local-investigator",
        data: "none",
        uses: [{ connectionId: "postgres-prod", access: "read-only" }],
      },
      { name: "Explain plans", stage: "working", agentId: "local-investigator", data: "none" },
      { name: "Summarize", stage: "review", agentId: "local-investigator", data: "none" },
    ],
  },
  planAndBuild: {
    id: "builtin/plan-and-build",
    name: "Plan and build",
    kind: "task",
    icon: "hammer",
    color: "sky",
    connections: [],
    start: { needs: ["text", "repo"], askBeforeCloud: false },
    warnings: [],
    steps: [
      { name: "Plan", stage: "working", agentId: "architect", data: "repo-and-diff" },
      { name: "Build", stage: "working", agentId: "local-builder", data: "none" },
      { name: "Run checks", stage: "verifying", data: "none", checks: { from: "repo" } },
      { name: "Review", stage: "review", agentId: "reviewer", data: "repo-and-diff" },
    ],
  },
  quickFix: {
    id: "builtin/quick-fix",
    name: "Quick fix",
    kind: "task",
    icon: "wrench",
    color: "moss",
    connections: [],
    start: { needs: ["text", "repo"], askBeforeCloud: false },
    warnings: [],
    steps: [
      { name: "Fix", stage: "working", agentId: "local-builder", data: "none" },
      { name: "Run checks", stage: "verifying", data: "none", checks: { from: "repo" } },
    ],
  },
  quickChange: {
    id: "builtin/quick-change",
    name: "Quick change",
    kind: "task",
    icon: "bolt",
    color: "rose",
    connections: [],
    start: { needs: ["text", "repo"], askBeforeCloud: false },
    warnings: [],
    steps: [{ name: "Change", stage: "review", agentId: "local-builder", data: "none" }],
  },
  reviewOnly: {
    id: "builtin/review-only",
    name: "Review only",
    kind: "task",
    icon: "eye",
    color: "slate",
    connections: [],
    start: { needs: ["text", "repo"], askBeforeCloud: false },
    warnings: [],
    steps: [{ name: "Review", stage: "review", agentId: "reviewer", data: "repo-and-diff" }],
  },
};

export const sampleSetup = {
  repos: [
    { id: "orders-api", baseBranch: "main", checks: ["pnpm test", "pnpm lint"], path: "~/code/orders-api" },
    { id: "checkout-web", baseBranch: "main", checks: ["npm test"] },
    { id: "inventory-service", baseBranch: "develop", checks: [] },
  ],
  connections: [
    { id: "app-insights-prod", name: "App Insights · prod", type: "App Insights" },
    { id: "postgres-prod", name: "Postgres · prod", type: "Postgres" },
    { id: "postgres-staging", name: "Postgres · staging", type: "Postgres" },
    { id: "azure-prod", name: "Azure · prod", type: "Azure" },
    { id: "grafana-prod", name: "Grafana · prod", type: "MCP server" },
  ],
  agents: [agents.architect, agents.investigator, agents.reviewer, agents.builder],
  templates: [templates.emergency, templates.slowQuery, templates.planAndBuild, templates.quickFix, templates.quickChange, templates.reviewOnly],
  health: { git: { ok: true, version: "git version 2.54.0" }, clis: [{ cliId: "claude-code", installed: true, loggedIn: true, version: "2.1.331" }], gh: { installed: true, loggedIn: true }, config: [] },
};

type StepState = "pending" | "running" | "needs_you" | "passed" | "failed";

/** The template's steps with these states and detail lines (a passed step without one says "passed"). */
function steps(template: { steps: readonly object[] }, states: readonly StepState[], details: Record<number, string> = {}) {
  return template.steps.map((templateStep: { checks?: unknown }, index) => {
    // Item steps carry no checks; the template summary does.
    const step = { ...templateStep };
    delete step.checks;
    const state = states[index] ?? "pending";
    const detail = details[index] ?? (state === "passed" ? "passed" : undefined);
    return { ...step, state, ...(detail ? { detail } : {}) };
  });
}

const MINUTE = 60_000;
const OLDEST_SAMPLE_MINUTES = 180;

/**
 * The time `minutes` before `now`, but never before the start of today (local time). The app lists
 * finished items of today by default, so shortly after midnight the sample ages shrink to fit
 * into the day, in the same order, rather than slipping into yesterday.
 */
export function ago(now: number, minutes: number): number {
  const startOfDay = new Date(now).setHours(0, 0, 0, 0);
  const fit = Math.min(1, (now - startOfDay) / (OLDEST_SAMPLE_MINUTES * MINUTE));
  return now - Math.floor(minutes * MINUTE * fit);
}

/** The sample items, created minutes before `now`. */
export function sampleItems(now: number) {
  const base = { schemaVersion: 1 };
  return [
    {
      ...base,
      id: ITEM_IDS.queued,
      kind: "task",
      templateId: templates.planAndBuild.id,
      title: "Add retry with backoff to the payment client",
      text: "Add retry with backoff to the payment client in orders-api. Retry 5xx and timeouts, at most 3 times.",
      repoIds: ["orders-api"],
      privacy: "local_and_cloud",
      state: "queued",
      createdAt: ago(now, 2),
      cardLine: "waiting for a free agent",
      steps: steps(templates.planAndBuild, []),
    },
    {
      ...base,
      id: ITEM_IDS.working,
      kind: "investigation",
      templateId: templates.emergency.id,
      title: "Checkout latency spike",
      text: "Alert: checkout p95 latency above 1.5 s for 10 minutes (orders-api, prod).",
      repoIds: [],
      privacy: "local_and_cloud",
      state: "running",
      createdAt: ago(now, 14),
      cardLine: "p95 1.8s · 3 of 10 queries",
      steps: steps(templates.emergency, ["passed", "running"], { 0: "scope: checkout, last 30 min", 1: "waits for App Insights query results" }),
    },
    {
      ...base,
      id: ITEM_IDS.building,
      kind: "task",
      templateId: templates.planAndBuild.id,
      title: "Paginate the orders list",
      text: "The orders list loads every order at once. Add cursor pagination to the API and the list.",
      repoIds: ["orders-api", "checkout-web"],
      privacy: "local_and_cloud",
      state: "running",
      createdAt: ago(now, 33),
      cardLine: "turn 18 of 40",
      steps: steps(templates.planAndBuild, ["passed", "running"], { 0: "plan approved", 1: "waits for Local builder on Ollama" }),
    },
    {
      ...base,
      id: ITEM_IDS.needsYou,
      kind: "investigation",
      templateId: templates.emergency.id,
      title: "Orders API returns 500 after deploy",
      text: "Alert: orders-api 5xx rate at 4% since the 14:02 deploy.",
      repoIds: ["orders-api"],
      privacy: "local_and_cloud",
      state: "needs_you",
      createdAt: ago(now, 41),
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
      templateId: templates.quickFix.id,
      title: "Fix rounding in invoice totals",
      text: "Invoice totals are off by one cent for some multi-currency orders.",
      repoIds: ["orders-api"],
      privacy: "local_only",
      state: "running",
      createdAt: ago(now, 23),
      cardLine: "pnpm test · 212 of 340",
      steps: steps(templates.quickFix, ["passed", "running"], { 0: "2 files changed", 1: "runs pnpm test" }),
    },
    {
      ...base,
      id: ITEM_IDS.review,
      kind: "task",
      templateId: templates.planAndBuild.id,
      title: "Add order export endpoint",
      text: "Add GET /orders/export that streams orders as CSV, filtered by date range.",
      repoIds: ["orders-api", "checkout-web"],
      privacy: "local_and_cloud",
      state: "running",
      createdAt: ago(now, 95),
      cardLine: "+184 −21 · 6 files",
      steps: steps(templates.planAndBuild, ["passed", "passed", "passed", "running"], { 1: "+184 −21 · 6 files", 2: "pnpm test · 340 passed", 3: "waits for the Reviewer verdict" }),
    },
    {
      ...base,
      id: ITEM_IDS.done,
      kind: "investigation",
      templateId: templates.slowQuery.id,
      title: "Slow query on order_items",
      text: "order_items lookups take 900 ms at peak.",
      repoIds: [],
      privacy: "local_only",
      state: "done",
      createdAt: ago(now, 180),
      cardLine: "missing index on order_items(order_id)",
      steps: steps(templates.slowQuery, ["passed", "passed", "passed"]),
    },
    {
      ...base,
      id: ITEM_IDS.finished,
      kind: "task",
      templateId: templates.quickFix.id,
      title: "Fix the null check in cart totals",
      text: "Cart totals crash when a line has no price. Fix the null check.",
      repoIds: ["orders-api"],
      privacy: "local_and_cloud",
      state: "done",
      createdAt: ago(now, 150),
      cardLine: "commit 3f2a9c1 · tokama/00000011",
      steps: steps(templates.quickFix, ["passed", "passed"]),
      outcome: {
        kind: "done",
        detail: "Committed 3f2a9c1e8b7d on tokama/00000011.",
        commits: [{ repoId: "orders-api", commit: "3f2a9c1e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39", branch: "tokama/00000011" }],
      },
      finish: { worktreeRemoved: false, pushTarget: "github.com/northwind/orders-api" },
    },
    {
      ...base,
      id: ITEM_IDS.failed,
      kind: "task",
      templateId: templates.quickFix.id,
      title: "Upgrade the Postgres driver in orders-api",
      text: "Upgrade the Postgres driver in orders-api to the next major version.",
      repoIds: ["orders-api"],
      privacy: "local_only",
      state: "failed",
      createdAt: ago(now, 130),
      cardLine: "checks failed 3 times",
      steps: steps(templates.quickFix, ["passed", "failed"], { 1: "pnpm test: 4 failing after 3 attempts" }),
    },
    {
      ...base,
      id: ITEM_IDS.quickChange,
      kind: "task",
      templateId: templates.quickChange.id,
      title: "Log the warehouse id on sync failures",
      text: "When an inventory sync fails, the log line does not say which warehouse. Add the warehouse id.",
      repoIds: ["inventory-service"],
      privacy: "local_only",
      state: "needs_you",
      createdAt: ago(now, 9),
      cardLine: "Approve this step's result?",
      decision: {
        id: DIFF_DECISION_ID,
        kind: "plan_approval",
        stepIndex: 0,
        question: "Approve this change and commit it?",
        why: "Local builder changed 4 files in a worktree of inventory-service. Nothing is committed until you approve. Request changes sends your note to Local builder for another run.",
        hasDiff: true,
        choices: [
          { id: "approve", label: "Approve and commit" },
          { id: "request_changes", label: "Request changes" },
          { id: "no_action_needed", label: "End: no action needed" },
          { id: "stop", label: "Stop" },
        ],
      },
      steps: steps(templates.quickChange, ["needs_you"], { 0: "waits for you" }).map((step) => ({ ...step, runs: 1, maxAttempts: 3, attempts: [{ attempt: 1, result: "passed", checks: [] }] })),
    },
    {
      ...base,
      id: ITEM_IDS.flaky,
      kind: "task",
      templateId: templates.quickFix.id,
      title: "Flaky inventory sync test",
      text: "InventorySyncTest fails about one run in ten on CI.",
      repoIds: ["inventory-service"],
      privacy: "local_only",
      state: "running",
      createdAt: ago(now, 6),
      cardLine: "attempt 2 of 3",
      steps: steps(templates.quickFix, ["running"], { 0: "waits for Local builder on Ollama" }),
    },
  ];
}

/** The change the Quick change item asks you to approve. */
export const sampleDiff = {
  files: [
    {
      path: "src/sync/worker.ts",
      status: "modified",
      added: 2,
      removed: 1,
      binary: false,
      cut: false,
      hunks: [
        {
          header: "@@ -41,7 +41,8 @@ export async function syncWarehouse(warehouse: Warehouse) {",
          lines: [
            "   try {",
            "     await pushStock(warehouse);",
            "   } catch (error) {",
            '-    log.error("inventory sync failed", { error });',
            '+    log.error("inventory sync failed", { error, warehouseId: warehouse.id });',
            "+    metrics.increment(\"sync.failed\", { warehouse: warehouse.id });",
            "     throw error;",
            "   }",
            " }",
          ],
        },
      ],
    },
    {
      path: "src/sync/worker.test.ts",
      status: "modified",
      added: 6,
      removed: 0,
      binary: false,
      cut: false,
      hunks: [
        {
          header: "@@ -88,3 +88,9 @@ describe(\"syncWarehouse\", () => {",
          lines: [
            "   });",
            "+",
            '+  it("logs the warehouse id when a sync fails", async () => {',
            "+    await expect(syncWarehouse(failing)).rejects.toThrow();",
            '+    expect(log.error).toHaveBeenCalledWith("inventory sync failed", expect.objectContaining({ warehouseId: "wh-7" }));',
            "+  });",
            " });",
          ],
        },
      ],
    },
    { path: "docs/sync-dashboard.png", status: "modified", added: null, removed: null, binary: true, cut: true, hunks: [] },
    { path: "fixtures/warehouses.json", status: "modified", added: 1204, removed: 310, binary: false, cut: true, hunks: [] },
  ],
  moreFiles: 0,
  cut: true,
  worktree: { repoId: "inventory-service", dir: ".tokama/wt/1a2b3c4d", branch: "tokama/1a2b3c4d", baseCommit: "85a75e3c0ffee0000000000000000000000000ab" },
};
