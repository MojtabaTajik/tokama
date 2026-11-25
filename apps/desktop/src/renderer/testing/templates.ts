// Test data for the Templates page, shaped like the sample engine's template files: one that loads
// (Plan and build, with a retry and a review loop) and one with problems. Plain literals cast to the
// engine types; templates.test.ts checks them against the engine schemas.
import type { TemplateDetail, TemplateEntry, TemplateStepView, TemplateView } from "@tokama/core";

const step = (fields: Partial<TemplateStepView> & Pick<TemplateStepView, "id" | "name" | "agentId">): TemplateStepView =>
  ({ doneWhen: "agent finishes", ifFailed: { action: "ask" }, maxAttempts: 1, data: "none", sees: [], connections: [], commands: [], ...fields }) as TemplateStepView;

export const planAndBuild = {
  schemaVersion: 1,
  ref: "orders-api/plan-and-build",
  id: "plan-and-build",
  source: { kind: "repo", repoId: "orders-api", file: ".tokama/templates/plan-and-build.yaml" },
  name: "Plan and build",
  icon: "hammer",
  color: "sky",
  uses: { repos: { picked: "edit", named: [] }, connections: [], commands: ["pnpm test"] },
  start: { needs: ["text", "repo"], askBeforeCloud: false, notify: false },
  budget: { timeMinutes: 90 },
  finish: ["commit", "pull-request"],
  steps: [
    step({ id: "plan", name: "Plan", agentId: "architect", doneWhen: "you approve", data: "repo-and-diff", instructionsFile: "instructions/plan.md" }),
    step({ id: "build", name: "Build", agentId: "local-builder", doneWhen: "checks pass", checks: { from: "repo" }, ifFailed: { action: "retry" }, maxAttempts: 3, sees: ["plan"] }),
    step({ id: "review", name: "Review", agentId: "reviewer", doneWhen: "reviewer approves", ifChangesRequested: { action: "back", stepId: "build" }, maxAttempts: 2, data: "repo-and-diff" }),
  ],
} as unknown as TemplateView;

export const planEntry = {
  origin: "orders-api",
  file: ".tokama/templates/plan-and-build.yaml",
  ref: "orders-api/plan-and-build",
  name: "Plan and build",
  icon: "hammer",
  color: "sky",
  problemCount: 0,
  openable: true,
} as unknown as TemplateEntry;

export const flakyEntry = {
  origin: "checkout-web",
  file: ".tokama/templates/flaky-test-fix.yaml",
  ref: "checkout-web/flaky-test-fix",
  problemCount: 2,
  openable: false,
} as unknown as TemplateEntry;

export const builtinEntry = { origin: "builtin", file: "builtin/quick-fix", ref: "builtin/quick-fix", name: "Quick fix", icon: "screwdriver-wrench", color: "sky", problemCount: 0, openable: false } as unknown as TemplateEntry;

export const planDetail = {
  entry: planEntry,
  template: planAndBuild,
  problems: [],
  warnings: [],
  text: "format: 1\nname: Plan and build\n",
  path: "/work/orders-api/.tokama/templates/plan-and-build.yaml",
} as unknown as TemplateDetail;

export const flakyDetail = {
  entry: flakyEntry,
  template: null,
  problems: [
    { line: 3, message: 'Step "review" uses agent "reviewr", which is not set up. Did you mean "reviewer"?' },
    { line: 5, message: 'Step "review": "if_changes_requested" goes back to "buld", which is not a step in this template. Did you mean "build"?' },
  ],
  warnings: [],
  text: "format: 1\nname: Flaky test fix\n    agent: reviewr\n  - id: x\n      back: buld\n",
  path: null,
} as unknown as TemplateDetail;
