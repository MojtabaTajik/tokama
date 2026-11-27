// Test data shaped like the fake engine's sample set: one setup and items in every state, at
// fixed times before NOW (local time, so the tests do not depend on the machine's time zone).
// Plain literals cast to the engine types; model.test.ts checks them against the engine schemas,
// so they cannot drift from the API.
import type { ItemRecord, Setup } from "@tokama/core";

/** 15:00 local on 20 October 2025. */
export const NOW = new Date(2025, 9, 20, 15, 0, 0).getTime();
const MINUTE = 60_000;

const id = (n: number) => `item_1a2b3c4d-${String(n).padStart(4, "0")}-4a1b-8c1d-${String(n).padStart(12, "0")}`;
const step = (name: string, stage: string, state: string, agentId?: string) => ({ name, stage, state, data: "none", ...(agentId ? { agentId } : {}) });
const tplStep = (name: string, stage: string, agentId?: string) => ({ name, stage, data: "none", ...(agentId ? { agentId } : {}) });

export const setup = {
  repos: [
    { id: "orders-api", baseBranch: "main", checks: ["pnpm test"] },
    { id: "checkout-web", baseBranch: "main", checks: [] },
    { id: "inventory-service", baseBranch: "develop", checks: [] },
  ],
  connections: [{ id: "app-insights-prod", name: "App Insights · prod", type: "App Insights" }],
  agents: [
    { id: "architect", name: "Architect", cliId: "claude-code", model: "opus", runsOn: "cloud", icon: "compass" },
    { id: "local-builder", name: "Local builder", cliId: "claude-code", model: "qwen3-coder:30b", runsOn: "local", icon: "hammer" },
    { id: "reviewer", name: "Reviewer", cliId: "codex-cli", model: "gpt-5-codex", runsOn: "cloud", icon: "eye" },
  ],
  templates: [
    {
      id: "builtin/emergency-investigator",
      name: "Emergency investigator",
      icon: "fire",
      color: "rose",
      kind: "investigation", start: { needs: ["text"], askBeforeCloud: false }, warnings: [],
      connections: [],
      steps: [tplStep("Triage", "working", "local-builder"), tplStep("Query logs", "working", "local-builder"), tplStep("Propose a fix", "review", "architect")],
    },
    { id: "builtin/db-slow-query", name: "DB slow query check", icon: "database", color: "clay", kind: "investigation", start: { needs: ["text"], askBeforeCloud: false }, warnings: [], connections: [], steps: [tplStep("Explain plans", "working", "local-builder")] },
    {
      id: "builtin/plan-and-build",
      name: "Plan and build",
      icon: "hammer",
      color: "sky",
      kind: "task", start: { needs: ["text", "repo"], askBeforeCloud: false }, warnings: [],
      connections: [],
      steps: [tplStep("Plan", "working", "architect"), tplStep("Build", "working", "local-builder"), tplStep("Run checks", "verifying"), tplStep("Review", "review", "reviewer")],
    },
    { id: "builtin/quick-fix", name: "Quick fix", icon: "wrench", color: "moss", kind: "task", start: { needs: ["text", "repo"], askBeforeCloud: false }, warnings: [], connections: [], steps: [tplStep("Fix", "working", "local-builder"), tplStep("Run checks", "verifying")] },
    { id: "builtin/review-only", name: "Review only", icon: "eye", color: "slate", kind: "task", start: { needs: ["text", "repo"], askBeforeCloud: false }, warnings: [], connections: [], steps: [tplStep("Review", "review", "reviewer")] },
  ],
  health: { git: { ok: true }, clis: [], config: [] },
} as unknown as Setup;

const item = (n: number, minutesAgo: number, fields: Record<string, unknown>) => ({
  schemaVersion: 1,
  id: id(n),
  kind: "task",
  templateId: "builtin/quick-fix",
  text: "",
  repoIds: [],
  privacy: "local_only",
  createdAt: NOW - minutesAgo * MINUTE,
  ...fields,
});

export const ITEMS = {
  queued: item(1, 2, {
    templateId: "builtin/plan-and-build",
    title: "Add retry with backoff",
    repoIds: ["orders-api"],
    state: "queued",
    steps: [step("Plan", "working", "pending", "architect"), step("Build", "working", "pending", "local-builder"), step("Run checks", "verifying", "pending"), step("Review", "review", "pending", "reviewer")],
  }),
  working: item(2, 14, {
    kind: "investigation",
    templateId: "builtin/emergency-investigator",
    title: "Checkout p95 latency spike",
    repoIds: ["checkout-web"],
    state: "running",
    steps: [step("Triage", "working", "passed", "local-builder"), step("Query logs", "working", "running", "local-builder"), step("Propose a fix", "review", "pending", "architect")],
  }),
  needsYou: item(3, 41, {
    kind: "investigation",
    templateId: "builtin/emergency-investigator",
    repoIds: ["orders-api"],
    privacy: "local_and_cloud",
    title: "Orders API returns 500 after deploy",
    state: "needs_you",
    decision: {
      id: "decision_5e1c9a7b-3f2d-4c8e-9a6b-1d2e3f4a5b6c",
      stepIndex: 2,
      question: "Send the redacted findings summary to Architect on Claude Code?",
      choices: [{ id: "approve", label: "Approve and send" }],
    },
    steps: [step("Triage", "working", "passed", "local-builder"), step("Query logs", "working", "passed", "local-builder"), step("Propose a fix", "review", "needs_you", "architect")],
  }),
  verifying: item(4, 23, {
    title: "Fix rounding in invoice totals",
    repoIds: ["orders-api"],
    state: "running",
    steps: [step("Fix", "working", "passed", "local-builder"), step("Run checks", "verifying", "running")],
  }),
  done: item(5, 120, { title: "Bump the Postgres driver", state: "done", cardLine: "commit 3f2a9c1 · tokama/00000011", steps: [step("Fix", "working", "passed", "local-builder"), step("Run checks", "verifying", "passed")] }),
  failed: item(6, 130, { title: "Flaky checkout test", repoIds: ["checkout-web"], state: "failed", steps: [step("Fix", "working", "failed", "local-builder"), step("Run checks", "verifying", "pending")] }),
  stock: item(7, 6, {
    repoIds: ["inventory-service"],
    title: "Stock sync drops <b>items</b>",
    state: "running",
    steps: [step("Fix", "working", "running", "local-builder"), step("Run checks", "verifying", "pending")],
  }),
  stopped: item(8, 90, { title: "Try a cache for prices", state: "stopped", steps: [step("Fix", "working", "stopped", "local-builder"), step("Run checks", "verifying", "pending")] }),
  doneLastWeek: item(9, 3 * 24 * 60, { title: "Remove the old export flag", state: "done", steps: [step("Fix", "working", "passed", "local-builder"), step("Run checks", "verifying", "passed")] }),
  failedLastMonth: item(10, 20 * 24 * 60, { title: "Upgrade the build image", state: "failed", steps: [step("Fix", "working", "failed", "local-builder"), step("Run checks", "verifying", "pending")] }),
} as unknown as Record<"queued" | "working" | "needsYou" | "verifying" | "done" | "failed" | "stock" | "stopped" | "doneLastWeek" | "failedLastMonth", ItemRecord>;

export const items: ItemRecord[] = Object.values(ITEMS);
