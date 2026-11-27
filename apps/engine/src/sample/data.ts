// The sample data set of the fake engine mode: one set of repos, connections, agents and templates, and items in
// every board stage, of both kinds and both privacy modes, one of them waiting for a decision.
// Plain JSON shapes; sample.ts parses them with the engine's schemas when it loads them.
// The "working" investigation is the one the tick moves (and loops); the others stay put.

export const DECISION_ID = "decision_5e1c9a7b-3f2d-4c8e-9a6b-1d2e3f4a5b6c";
/** The Quick change item's question: approve the diff it shows. */
export const DIFF_DECISION_ID = "decision_5e1c9a7b-3f2d-4c8e-9a6b-1d2e3f4a5b6d";

/** The Plan approval item's question: approve the plan its Plan step wrote, which changed no files. */
export const PLAN_DECISION_ID = "decision_5e1c9a7b-3f2d-4c8e-9a6b-1d2e3f4a5b6e";

/** The Review limit item's question: Review asked for changes, Build fixed them, and Review may not run again. */
export const LIMIT_DECISION_ID = "decision_5e1c9a7b-3f2d-4c8e-9a6b-1d2e3f4a5b6f";

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
  /** A Plan and build task whose Plan step waits for your approval of the plan. */
  planApproval: "item_1a2b3c4d-0012-4a1b-8c1d-000000000012",
  /** A Plan and build task whose Review step stopped at its limit after Build fixed what it asked for. */
  reviewLimit: "item_1a2b3c4d-0013-4a1b-8c1d-000000000013",
} as const;

const agents = {
  architect: { id: "architect", name: "Architect", cliId: "claude-code", model: "opus", runsOn: "cloud" },
  investigator: { id: "local-investigator", name: "Local investigator", cliId: "claude-code", model: "qwen3-coder:30b", runsOn: "local" },
  reviewer: { id: "reviewer", name: "Reviewer", cliId: "codex-cli", model: "gpt-5-codex", runsOn: "cloud" },
  builder: { id: "local-builder", name: "Local builder", cliId: "claude-code", model: "qwen3-coder:30b", runsOn: "local" },
  /** Shared by the orders-api repo. */
  repoBuilder: { id: "orders-builder", name: "Orders builder", cliId: "claude-code", model: "qwen3-coder:30b", runsOn: "local" },
};

/**
 * What each sample agent may do and who owns it, as the engine resolves it for a template step:
 * a built-in, a personal agent, and a repo's agent with more power than the built-ins have.
 */
const access = {
  architect: { name: "Architect", owner: "builtin", cliId: "claude-code", model: "opus", role: "You plan the change and name the files it touches.", edit: false, commands: [], web: false },
  "local-investigator": { name: "Local investigator", owner: "personal", cliId: "claude-code", model: "qwen3-coder:30b", role: "You find the cause from logs and queries, and change nothing.", edit: false, commands: [], web: false },
  reviewer: { name: "Reviewer", owner: "builtin", cliId: "codex-cli", model: "gpt-5-codex", role: "You review a diff you did not write.", edit: false, commands: [], web: false },
  "local-builder": { name: "Local builder", owner: "builtin", cliId: "claude-code", model: "qwen3-coder:30b", role: "You make the change the plan describes, in the worktree.", edit: true, commands: ["pnpm test"], web: false },
  /** A repo's own agent: it may run more commands and use the web, which the list shows in amber. */
  "orders-builder": {
    name: "Orders builder",
    owner: "repo",
    repoId: "orders-api",
    cliId: "claude-code",
    model: "qwen3-coder:30b",
    role: "You change orders-api and keep its migrations reversible.",
    edit: true,
    commands: ["pnpm test", "pnpm db:migrate", "docker compose up"],
    web: true,
  },
} as const;

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
      { name: "Build", stage: "working", agentId: "orders-builder", data: "none" },
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

/** The template with what each step's agent may do, as the engine's setup reply carries it. */
function withAccess<T extends { steps: readonly { agentId?: string }[] }>(template: T) {
  return {
    ...template,
    steps: template.steps.map((step) => {
      const agentAccess = step.agentId === undefined ? undefined : access[step.agentId as keyof typeof access];
      return agentAccess === undefined ? step : { ...step, agentAccess };
    }),
  };
}

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
  agents: [agents.architect, agents.investigator, agents.reviewer, agents.builder, agents.repoBuilder],
  templates: [templates.emergency, templates.slowQuery, templates.planAndBuild, templates.quickFix, templates.quickChange, templates.reviewOnly].map(withAccess),
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
/**
 * The time `minutes` before `now`: a fixed offset, at any hour. Just after midnight the older sample
 * items fall into yesterday, as they would for real work; the sample never bends its ages to the
 * day, so it holds the same shape whenever the app starts.
 */
export function ago(now: number, minutes: number): number {
  return now - minutes * MINUTE;
}

/** How long each sample attempt worked, by step and attempt: a few minutes each. */
const ATTEMPT_MS = [252_000, 185_000, 431_000, 96_000, 318_000];
/** A running sample attempt started this long ago. */
const RUNNING_FOR_MS = 192_000;
/** The done sample item's first step waited this long for your approval. */
export const SAMPLE_WAIT_MS = 6 * MINUTE;

interface RawAttempt {
  readonly attempt: number;
  readonly [field: string]: unknown;
}
interface RawStep {
  readonly state: string;
  readonly attempts?: readonly RawAttempt[] | undefined;
  readonly [field: string]: unknown;
}
interface RawItem {
  readonly id: string;
  readonly state: string;
  readonly createdAt: number;
  readonly steps: readonly RawStep[];
  readonly [field: string]: unknown;
}

/**
 * The item with attempt times as the engine derives them from the log: each attempt one after the
 * other from shortly after the item was created, a running attempt started a few minutes ago, and
 * the working time of ended steps and of the ended item. Squeezed to fit before `now` when an item is too young for its attempts.
 */
function withTimes(item: RawItem, now: number, waits: Readonly<Record<number, number>> = {}): RawItem {
  const ended = item.state === "done" || item.state === "failed";
  const plan = item.steps.map((step, index) => {
    const attempts = step.attempts ?? (step.state === "passed" ? [{ attempt: 1, result: "passed", checks: [] }] : []);
    return attempts.map((attempt, n) => ATTEMPT_MS[(index + n) % ATTEMPT_MS.length]!);
  });
  const total = plan.flat().reduce((sum, ms) => sum + ms, 0) + Object.values(waits).reduce((sum, ms) => sum + ms, 0);
  const room = now - item.createdAt - 2 * 20_000 - (ended ? 0 : RUNNING_FOR_MS);
  const scale = total > 0 ? Math.max(0, Math.min(1, room / total)) : 1;
  let at = item.createdAt + 20_000;
  let first: number | undefined;
  const steps = item.steps.map((step, index) => {
    const attempts: RawAttempt[] = (step.attempts ?? (step.state === "passed" ? [{ attempt: 1, result: "passed", checks: [] }] : [])).map((attempt, n) => {
      const durationMs = Math.round(plan[index]![n]! * scale);
      const timed = { ...attempt, startedAt: at, endedAt: at + durationMs, durationMs };
      first ??= at;
      at += durationMs + 5_000;
      return timed;
    });
    const waitedMs = waits[index];
    if (waitedMs !== undefined) at += Math.round(waitedMs * scale);
    if (step.state === "running") {
      const startedAt = Math.min(now, Math.max(at, now - RUNNING_FOR_MS));
      attempts.push({ attempt: attempts.length + 1, startedAt, checks: [] });
    }
    const worked = attempts.reduce((sum, attempt) => sum + (typeof attempt["durationMs"] === "number" ? attempt["durationMs"] : 0), 0);
    return {
      ...step,
      ...(attempts.length > 0 && { attempts }),
      ...((step.state === "passed" || step.state === "failed") && attempts.length > 0 && { durationMs: worked }),
      ...(waitedMs !== undefined && { waitedMs: Math.round(waitedMs * scale) }),
    };
  });
  const waited = Object.values(waits).reduce((sum, ms) => sum + Math.round(ms * scale), 0);
  return { ...item, steps, ...(ended && first !== undefined && { durationMs: at - 5_000 - first - waited }) };
}

/** The sample items, created minutes before `now`. */
export function sampleItems(now: number) {
  return rawItems(now).map((item) => withTimes(item, now, item.id === ITEM_IDS.finished ? { 0: SAMPLE_WAIT_MS } : {}));
}

function rawItems(now: number): RawItem[] {
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
      steps: steps(templates.planAndBuild, ["passed", "running"], { 0: "plan approved", 1: "waits for Orders builder on Ollama" }),
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
      steps: steps(templates.quickFix, ["passed", "passed"]).map((step, index) => ({
        ...step,
        attempts: [{ attempt: 1, result: "passed", checks: index === 0 ? [] : ["pnpm typecheck", "pnpm lint", "pnpm test"].map((command) => ({ command, passed: true, exitCode: 0 })) }],
      })),
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
      steps: steps(templates.quickFix, ["passed", "failed"], { 1: "pnpm test: 4 failing after 3 attempts" }).map((step, index) => ({
        ...step,
        attempts: [1, 2, 3].map((attempt) =>
          index === 0
            ? { attempt, result: "passed", checks: [] }
            : { attempt, result: "failed", detail: "`pnpm test` exited 1.", checks: [{ command: "pnpm test", passed: false, exitCode: 1 }, { command: "pnpm lint", passed: true, exitCode: 0 }] },
        ),
      })),
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
      id: ITEM_IDS.planApproval,
      kind: "task",
      templateId: templates.planAndBuild.id,
      title: "Reserve stock when an order is placed",
      text: "Reserve stock in inventory-service when an order is placed in orders-api, and release it when the order is cancelled.",
      repoIds: ["orders-api"],
      privacy: "local_and_cloud",
      state: "needs_you",
      createdAt: ago(now, 12),
      cardLine: "Approve this step's result?",
      decision: {
        id: PLAN_DECISION_ID,
        kind: "plan_approval",
        stepIndex: 0,
        question: "Approve this step's result?",
        why: "Architect wrote a plan and changed 0 files. Build starts after you approve. Request changes sends your note to Architect for another run.",
        choices: [
          { id: "approve", label: "Approve" },
          { id: "request_changes", label: "Request changes" },
          { id: "stop", label: "Stop" },
        ],
      },
      steps: steps(templates.planAndBuild, ["needs_you"], { 0: "waits for you" }).map((step, index) => (index === 0 ? { ...step, runs: 1, maxAttempts: 3, attempts: [{ attempt: 1, result: "passed", checks: [] }] } : step)),
    },
    {
      ...base,
      id: ITEM_IDS.reviewLimit,
      kind: "task",
      templateId: templates.planAndBuild.id,
      title: "Keep the start card still while it fades",
      text: "The start card jumps while it fades out in checkout-web. Keep its layout still.",
      repoIds: ["checkout-web"],
      privacy: "local_and_cloud",
      state: "needs_you",
      createdAt: ago(now, 18),
      cardLine: "The step failed. Retry it, or end the item?",
      decision: {
        id: LIMIT_DECISION_ID,
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
      steps: steps(templates.planAndBuild, ["passed", "passed", "passed", "needs_you"], { 0: "plan approved", 1: "passed on attempt 2", 2: "passed on attempt 2", 3: "waits for you" }).map((step, index) => {
        const attempts = [
          [{ attempt: 1, result: "passed", checks: [] }],
          [
            { attempt: 1, result: "passed", checks: [] },
            { attempt: 2, result: "passed", checks: [] },
          ],
          [
            { attempt: 1, result: "passed", checks: [{ command: "npm test", passed: true, exitCode: 0 }] },
            { attempt: 2, result: "passed", checks: [{ command: "npm test", passed: true, exitCode: 0 }] },
          ],
          [{ attempt: 1, result: "failed", detail: "The reviewer asked for changes.", checks: [] }],
        ][index];
        return { ...step, attempts, ...(index === 3 && { runs: 1, maxAttempts: 1 }) };
      }),
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

/** What each attempt's agent wrote last, by item and step index, oldest attempt first. */
export const sampleOutputs: Readonly<Record<string, Readonly<Record<number, readonly string[]>>>> = {
  [ITEM_IDS.failed]: {
    0: [
      "Upgraded pg and moved the pool to the new connect API.",
      "Kept held clients out of the idle timeout.",
      "Every caller releases its client. I could not find why the idle timeout still closes a held client.",
    ],
  },
  [ITEM_IDS.planApproval]: {
    0: [
      [
        "## Plan: reserve stock when an order is placed",
        "",
        "Orders take stock only when they ship, so two customers can buy the last item. This plan reserves stock at checkout and releases it when an order is cancelled.",
        "",
        "### Changes",
        "",
        "1. Add a `stock_reservations` table to inventory-service, with `order_id`, `sku`, `quantity` and `expires_at`.",
        "2. Add `POST /reservations` and `DELETE /reservations/{orderId}` to inventory-service.",
        "3. Call `POST /reservations` from `OrderService.place` in orders-api, before the payment step. A refusal ends checkout with \"out of stock\".",
        "4. Release the reservation in `OrderService.cancel`, and in a job that removes reservations older than 30 minutes.",
        "",
        "### Tests",
        "",
        "- Two orders for the last item: the second gets \"out of stock\".",
        "- A cancelled order releases its stock.",
        "- The release job removes expired reservations only.",
        "",
        "### Risks",
        "",
        "- The reserve call adds a network hop to checkout. Timeout: 2 s, then checkout fails safe.",
        "- The migration is reversible:",
        "",
        "```sql",
        "DROP TABLE stock_reservations;",
        "```",
        "",
        "Files to change: 6. Nothing is changed until Build runs.",
      ].join("\n"),
    ],
  },
  [ITEM_IDS.finished]: {
    0: [
      [
        "Fixed the null check in `cartTotal`: a line without a price now counts as 0 instead of throwing.",
        "",
        "- `src/cart/total.ts` reads `line.price ?? 0`.",
        "- `src/cart/total.test.ts` adds a case for a line with no price.",
      ].join("\n"),
    ],
  },
  [ITEM_IDS.reviewLimit]: {
    3: [
      [
        "**Needs changes.** The change follows the plan, but one visual bug needs fixing first.",
        "",
        "**Must change**",
        "",
        "1. **`src/start-card.css:31`: the start card changes layout while it fades out.** The `[hidden]` rule sets `display: block`, which beats the card's `display: flex`, so its two lines jump onto one while it fades. Fix: keep `display: flex` in the hidden rule.",
        "",
        "**Checked and fine**",
        "- The fade still takes 250 ms (`src/start-card.css:12`).",
        "",
        "**Minor (optional)**",
        "- `src/start-card.ts:40`: the timer is not cleared when the card is removed.",
        "",
        "VERDICT: changes",
      ].join("\n"),
    ],
  },
  [ITEM_IDS.quickChange]: {
    0: [
      [
        "Added the warehouse id to the sync failure log line.",
        "",
        "- `SyncJob.run` now logs `warehouseId` with each failure.",
        "- `SyncJob.test.js` checks the new field.",
        "- The README's log example shows the new field.",
      ].join("\n"),
    ],
  },
};

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

/** What the done "Fix the null check" item changed on its branch; after Merge, the commit it was merged as. */
export const finishedDiff = {
  files: [
    {
      path: "src/cart/totals.ts",
      status: "modified",
      added: 3,
      removed: 1,
      binary: false,
      cut: false,
      hunks: [
        {
          header: "@@ -12,6 +12,8 @@ export function lineTotal(line: CartLine): number {",
          lines: [
            " export function lineTotal(line: CartLine): number {",
            "-  return line.price.amount * line.quantity;",
            "+  // A line without a price counts as zero instead of crashing the cart.",
            "+  if (line.price === null) return 0;",
            "+  return line.price.amount * line.quantity;",
            " }",
          ],
        },
      ],
    },
    {
      path: "src/cart/totals.test.ts",
      status: "added",
      added: 5,
      removed: 0,
      binary: false,
      cut: false,
      hunks: [
        {
          header: "@@ -0,0 +1,5 @@",
          lines: [
            '+import { lineTotal } from "./totals.js";',
            "+",
            '+it("counts a line without a price as zero", () => {',
            "+  expect(lineTotal({ price: null, quantity: 2 })).toBe(0);",
            "+});",
          ],
        },
      ],
    },
  ],
  moreFiles: 0,
  cut: false,
  worktree: { repoId: "orders-api", dir: ".tokama/wt/00000011", branch: "tokama/00000011", baseCommit: "a41c9e2b7d6c5f4e3d2c1b0a9f8e7d6c5b4a3921" },
};

/** What the failed driver upgrade left in its worktree. */
export const failedDiff = {
  files: [
    {
      path: "package.json",
      status: "modified",
      added: 1,
      removed: 1,
      binary: false,
      cut: false,
      hunks: [{ header: "@@ -14,7 +14,7 @@", lines: ['   "dependencies": {', '-    "pg": "^8.11.0",', '+    "pg": "^9.0.0",', '     "zod": "^4.1.0"'] }],
    },
  ],
  moreFiles: 0,
  cut: false,
  worktree: { repoId: "orders-api", dir: ".tokama/wt/00000009", branch: "tokama/00000009", baseCommit: "3c1e8d0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d40" },
};

const HISTORY_WORK = ["Tidy the logs", "Add a health check", "Rename the status enum", "Pin the Node version", "Speed up the build", "Fix a flaky test", "Drop an unused flag", "Retry the webhook"];
const HISTORY_REPOS = ["orders-api", "checkout-web", "inventory-service"];
const HISTORY_TEMPLATES = [templates.quickFix, templates.quickChange, templates.planAndBuild];

/**
 * A long history for trying the work list: `count` finished items, a few on each local day from
 * yesterday back about two months (so some are older than 30 days), every seventh failed and
 * every eleventh stopped. Each title carries its number, `(#n)`, so a search can find one.
 */
export function sampleHistory(now: number, count: number) {
  const today = new Date(now);
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    const template = HISTORY_TEMPLATES[index % HISTORY_TEMPLATES.length]!;
    const repo = HISTORY_REPOS[index % HISTORY_REPOS.length]!;
    const state = n % 7 === 0 ? "failed" : n % 11 === 0 ? "stopped" : "done";
    // Local calendar days, so the items of one day stay on it across a DST change.
    const daysBack = 1 + Math.floor((index * 60) / Math.max(count, 1));
    const createdAt = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysBack, 9 + (index % 9), (index * 7) % 60).getTime();
    const last = template.steps.length - 1;
    const states = template.steps.map((_step, step): StepState => (state === "failed" && step === last ? "failed" : state === "stopped" && step === last ? "pending" : "passed"));
    return {
      schemaVersion: 1,
      id: `item_00000000-0000-4000-9000-${String(n).padStart(12, "0")}`,
      kind: "task",
      templateId: template.id,
      title: `${HISTORY_WORK[index % HISTORY_WORK.length]} in ${repo} (#${n})`,
      text: "",
      repoIds: [repo],
      privacy: "local_and_cloud",
      state,
      createdAt,
      steps: steps(template, states),
    };
  });
}
