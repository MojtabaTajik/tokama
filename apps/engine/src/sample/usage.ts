// Sample usage for the fake engine mode: 90 days of items with their attempts, checks and agent
// calls, made up the same way on every start (a seeded generator, days in local time), and plan
// readings that show every state the Insights page draws: Claude Code on a Max plan whose weekly
// limit runs out before it resets (and that closed a week ago), Codex CLI on pace with no log to
// split it by, and a local model host without a plan.
import {
  type AgentCallUsage,
  type AgentId,
  type AiCliId,
  callWeight,
  type CliPlan,
  type DoneWhen,
  type HelperCallRow,
  type ItemId,
  type ItemRecord,
  localDate,
  type PastWindow,
  type PlanReading,
  pricedEntry,
  PRICES_AS_OF,
  type RepoId,
  type RunItem,
  type Setup,
  type StepId,
  type TokenUsage,
  type UsageEntry,
  type UsageRow,
  withForecast,
} from "@tokama/core";
import type { PlanSources } from "../usage.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DAYS = 90;
const GOLDEN = 0.6180339887498949;

type Pool = readonly (readonly [model: string, runs: number])[];

interface FlowStep {
  readonly id: string;
  readonly name: string;
  readonly agentId: string;
  readonly doneWhen: DoneWhen;
  readonly cliId: AiCliId;
  /**
   * The models the step's runs use, with how many runs each takes. The runs use up the pool in a
   * seeded order, so a flow with as many runs as the pool holds shows exactly these counts.
   */
  readonly pool: Pool;
}

interface Flow {
  readonly templateId: string;
  /** Earlier items of the workflow, so the history has more than the sample board's own items. */
  readonly titles: readonly string[];
  readonly items: number;
  readonly steps: readonly FlowStep[];
}

const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-5-5";
const HAIKU = "claude-haiku-5-5";
const LOCAL = "qwen3-coder:30b";
const only = (model: string, runs: number): Pool => [[model, runs]];

/** Plan and build has 52 items; six of them are sent back by the reviewer, so Build runs 58 times. */
const SENT_BACK = new Set([3, 9, 17, 25, 33, 41]);

const FLOWS: readonly Flow[] = [
  {
    templateId: "builtin/plan-and-build",
    titles: [
      "Add order export endpoint",
      "Upgrade the Postgres driver in orders-api",
      "Paginate the orders list",
      "Add retry with backoff to the payment client",
      "Fix rounding in invoice totals",
      "Move invoice PDFs to the job queue",
      "Add a health endpoint to inventory-service",
    ],
    items: 52,
    steps: [
      { id: "plan", name: "Plan", agentId: "architect", doneWhen: "you approve", cliId: "claude-code", pool: [[OPUS, 49], [SONNET, 3]] },
      { id: "build", name: "Build", agentId: "orders-builder", doneWhen: "checks pass", cliId: "claude-code", pool: [[SONNET, 46], [OPUS, 12]] },
      { id: "review", name: "Review", agentId: "reviewer", doneWhen: "reviewer approves", cliId: "codex-cli", pool: [["gpt-5-codex", 50], ["gpt-5", 2]] },
    ],
  },
  {
    templateId: "builtin/quick-change",
    titles: ["Rename the retry setting", "Update the README badge", "Bump the lint rule", "Tidy the order status labels"],
    items: 40,
    steps: [{ id: "change", name: "Change", agentId: "local-builder", doneWhen: "you approve", cliId: "claude-code", pool: [[SONNET, 31], [HAIKU, 9]] }],
  },
  {
    templateId: "builtin/quick-fix",
    titles: ["Flaky inventory sync test", "Typo in the refund email", "Wrong currency on the cart total"],
    items: 20,
    steps: [{ id: "fix", name: "Fix", agentId: "local-builder", doneWhen: "agent finishes", cliId: "ollama", pool: only(LOCAL, 20) }],
  },
  {
    templateId: "builtin/emergency-investigator",
    titles: ["Orders API returns 500 after deploy", "Checkout latency spike", "Payment webhook timeouts", "Inventory sync stalls at night"],
    items: 14,
    steps: [
      { id: "triage", name: "Triage", agentId: "local-investigator", doneWhen: "agent finishes", cliId: "ollama", pool: only(LOCAL, 14) },
      { id: "query", name: "Query logs and metrics", agentId: "local-investigator", doneWhen: "agent finishes", cliId: "ollama", pool: only(LOCAL, 14) },
      { id: "cause", name: "Find the cause", agentId: "local-investigator", doneWhen: "agent finishes", cliId: "ollama", pool: only(LOCAL, 14) },
      { id: "propose", name: "Propose a fix", agentId: "architect", doneWhen: "agent finishes", cliId: "claude-code", pool: only(OPUS, 14) },
    ],
  },
  {
    templateId: "builtin/db-slow-query",
    titles: ["Slow query on order_items", "Slow search on customers", "Lock waits on stock_levels"],
    items: 10,
    steps: [
      { id: "collect", name: "Collect slow queries", agentId: "local-investigator", doneWhen: "agent finishes", cliId: "ollama", pool: only(LOCAL, 10) },
      { id: "explain", name: "Explain plans", agentId: "local-investigator", doneWhen: "agent finishes", cliId: "ollama", pool: only(LOCAL, 10) },
      { id: "summarize", name: "Summarize", agentId: "local-investigator", doneWhen: "agent finishes", cliId: "ollama", pool: only(LOCAL, 10) },
    ],
  },
  {
    templateId: "builtin/review-only",
    titles: ["Review the refund change", "Review the currency fix"],
    items: 6,
    steps: [{ id: "review", name: "Review", agentId: "reviewer", doneWhen: "reviewer approves", cliId: "codex-cli", pool: only("gpt-5-codex", 6) }],
  },
];

/** What a failing check is called in each sample repo. */
const FAILING_CHECK: Readonly<Record<string, string>> = { "orders-api": "pnpm test", "checkout-web": "pnpm e2e" };

/** The size of a call's tokens by model, against Claude Code's Sonnet. */
const SCALE: Readonly<Record<string, number>> = { [SONNET]: 1, [OPUS]: 1.4, [HAIKU]: 0.4, "gpt-5-codex": 0.8, "gpt-5": 0.8, [LOCAL]: 0.6 };

/** A small seeded generator (mulberry32), so the sample is the same on every start. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");

/** The pool of a step as a list in a seeded order: the model of its n-th run is the n-th entry. */
function modelOrder(step: FlowStep, seed: number): string[] {
  const list = step.pool.flatMap(([model, runs]) => Array<string>(runs).fill(model));
  const next = random(seed);
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [list[i], list[j]] = [list[j]!, list[i]!];
  }
  return list;
}

interface Planned {
  readonly step: FlowStep;
  readonly attempt: number;
  readonly result: "passed" | "failed";
  readonly checks: readonly (readonly [string, boolean])[];
  readonly model: string;
  readonly agentMs: number;
  readonly checksMs: number;
}

/**
 * The sample calls of the last 90 days, ending now, as the items they belong to: each step with its
 * attempts and checks. A call of today or yesterday that matches a title on the sample board uses
 * that item's id, so the drawer opens on it.
 */
export function sampleUsageItems(setup: Setup, board: readonly ItemRecord[], now: number): RunItem[] {
  const today = new Date(now);
  const items: RunItem[] = [];
  const usedIds = new Set<string>();
  const repoId = (name: string) => (setup.repos.find((repo) => repo.id === name)?.id ?? setup.repos[0]?.id) as RepoId;
  let callCount = 0;

  for (const [f, flow] of FLOWS.entries()) {
    const orders = new Map(flow.steps.map((step, s) => [step.id, modelOrder(step, f * 131 + s * 17 + 5)]));
    const runsMade = new Map<string, number>();
    for (let k = 0; k < flow.items; k++) {
      const next = random(f * 100_003 + k * 7919 + 11);
      const spread = (((k + 1) * GOLDEN + f * 0.37) % 1) ** 2;
      const daysAgo = k === 0 ? 0 : Math.min(DAYS - 1, Math.floor(DAYS * spread));
      const repo = repoId(flow.templateId.endsWith("plan-and-build") && k % 3 === 2 ? "checkout-web" : "orders-api");
      const modelFor = (step: FlowStep) => {
        const n = runsMade.get(step.id) ?? 0;
        runsMade.set(step.id, n + 1);
        const order = orders.get(step.id)!;
        return order[n % order.length]!;
      };

      // The attempts of the item in the order they run.
      const planned: Planned[] = [];
      const at = (step: FlowStep, attempt: number, result: "passed" | "failed", model: string, failing?: string): void => {
        const checks: (readonly [string, boolean])[] = [];
        if (step.doneWhen === "checks pass") {
          if (failing !== undefined) checks.push([failing, false]);
          for (const command of repo === "orders-api" ? ["pnpm test", "pnpm lint"] : ["pnpm e2e"]) if (command !== failing) checks.push([command, result === "passed" || failing !== undefined]);
        }
        planned.push({ step, attempt, result, checks, model, agentMs: Math.round((2 + next() * 12) * MINUTE), checksMs: checks.length > 0 ? Math.round((1 + next() * 2) * MINUTE) : 0 });
      };
      const counts = new Map<string, number>();
      const attemptOf = (step: FlowStep) => {
        const n = (counts.get(step.id) ?? 0) + 1;
        counts.set(step.id, n);
        return n;
      };
      for (const step of flow.steps) {
        if (step.doneWhen === "checks pass") {
          const model = modelFor(step);
          const failing = FAILING_CHECK[repo];
          // A step fails its checks now and then, Sonnet more often than Opus, and passes by the third attempt.
          const failsFirst = next() < (model === OPUS ? 0.08 : 0.24);
          if (failsFirst) {
            at(step, attemptOf(step), "failed", model, failing);
            if (next() < 0.2) at(step, attemptOf(step), "failed", model, next() < 0.8 ? failing : "pnpm lint");
          }
          at(step, attemptOf(step), "passed", model);
          if (SENT_BACK.has(k) && flow.steps.at(-1)?.doneWhen === "reviewer approves") {
            // The reviewer asks for changes: the step runs again on a new model of its pool, and the review runs a second time.
            const review = flow.steps.at(-1)!;
            at(review, attemptOf(review), "failed", modelFor(review));
            at(step, attemptOf(step), "passed", modelFor(step));
          }
        } else if (step.doneWhen === "reviewer approves") {
          const model = (counts.get(step.id) ?? 0) > 0 ? (planned.findLast((p) => p.step === step)?.model ?? modelFor(step)) : modelFor(step);
          if ((counts.get(step.id) ?? 0) === 0 && next() < 0.12) at(step, attemptOf(step), "failed", model);
          at(step, attemptOf(step), "passed", model);
        } else {
          const model = modelFor(step);
          // An agent that finishes with nothing usable is asked again now and then.
          if (step.id === "propose" && next() < 0.2) at(step, attemptOf(step), "failed", model);
          at(step, attemptOf(step), "passed", model);
        }
      }

      // When they run. Today's items are squeezed into the part of the day that has passed.
      const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo).getTime();
      const span = planned.reduce((sum, p) => sum + p.agentMs + p.checksMs + 2 * MINUTE, 0);
      const scale = daysAgo === 0 ? Math.min(1, ((now - dayStart) * 0.8) / span) : 1;
      let cursor = daysAgo === 0 ? dayStart + next() * (now - dayStart - span * scale) : dayStart + (9 + next() * 7) * HOUR;

      const title = flow.titles[k % flow.titles.length]!;
      const known = daysAgo <= 1 ? board.find((item) => item.title === title && !usedIds.has(item.id)) : undefined;
      const itemId = (known?.id ?? `item_5a3e${hex(f, 4)}-${hex(k, 4)}-4000-8000-000000000000`) as ItemId;
      usedIds.add(itemId);

      const calls: AgentCallUsage[] = [];
      const attempts = new Map<string, RunItem["steps"][number]["attempts"][number][]>();
      for (const p of planned) {
        const agentMs = Math.round(p.agentMs * scale);
        const checksMs = Math.round(p.checksMs * scale);
        const startedAt = Math.round(cursor);
        const endedAt = Math.min(now, startedAt + agentMs);
        cursor = startedAt + agentMs + checksMs + Math.round(2 * MINUTE * scale);
        callCount++;
        const size = SCALE[p.model] ?? 1;
        const tokens: TokenUsage = {
          input: Math.round((8_000 + next() * 22_000) * size),
          output: Math.round((2_000 + next() * 7_000) * size),
          cacheRead: Math.round((60_000 + next() * 190_000) * size),
          cacheWrite: p.step.cliId === "claude-code" ? Math.round(5_000 + next() * 25_000) : 0,
        };
        calls.push({
          callId: `call_5a3e0000-${hex(f, 4)}-7000-8000-${hex(callCount, 12)}` as AgentCallUsage["callId"],
          stepId: p.step.id as StepId,
          attempt: p.attempt,
          agentId: p.step.agentId as AgentId,
          cliId: p.step.cliId,
          model: p.model,
          outcome: "completed",
          startedAt,
          endedAt,
          tokens,
          ...(p.step.cliId === "claude-code" && { models: { [p.model]: tokens } }),
        });
        const list = attempts.get(p.step.id) ?? [];
        list.push({ attempt: p.attempt, result: p.result, startedAt, endedAt: Math.min(now, startedAt + agentMs + checksMs), checks: p.checks.map(([command, passed]) => ({ command, passed })) });
        attempts.set(p.step.id, list);
      }
      items.push({
        itemId,
        title,
        templateId: flow.templateId,
        repoIds: [repo],
        calls,
        steps: flow.steps.map((step) => ({ id: step.id as StepId, name: step.name, agentId: step.agentId as AgentId, doneWhen: step.doneWhen, attempts: attempts.get(step.id) ?? [] })),
      });
    }
  }
  return items;
}

/** The sample calls as the report's rows, oldest first. */
export function sampleUsageRows(setup: Setup, board: readonly ItemRecord[], now: number): UsageRow[] {
  return sampleUsageItems(setup, board, now)
    .flatMap((item) => item.calls.map((call): UsageRow => ({ itemId: item.itemId, title: item.title, templateId: item.templateId, ...(item.repoIds[0] !== undefined && { repoId: item.repoIds[0] }), call })))
    .sort((a, b) => a.call.endedAt - b.call.endedAt || (a.call.callId < b.call.callId ? -1 : 1));
}

/**
 * Tokama's sample helper calls, six suggest-checks calls on Claude Code haiku over the last ten
 * days, two of them today (as early as the day allows). The report counts them in its totals and
 * per-day figures and lists them in its `helpers` block.
 */
export function sampleHelperCalls(now: number): HelperCallRow[] {
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  // Minutes after the start of each call's day; today's two are squeezed into the time that has passed.
  const spots: readonly { readonly daysAgo: number; readonly at: number }[] = [
    { daysAgo: 0, at: 0.2 },
    { daysAgo: 0, at: 0.6 },
    { daysAgo: 1, at: 11 * 60 },
    { daysAgo: 3, at: 14 * 60 },
    { daysAgo: 6, at: 10 * 60 },
    { daysAgo: 10, at: 16 * 60 },
  ];
  return spots.map(({ daysAgo, at }, n) => {
    const endedAt = daysAgo === 0 ? Math.round(midnight + (now - midnight) * at) : midnight - daysAgo * DAY + at * MINUTE;
    const tokens = { input: 6_200, output: 180, cacheRead: 0, cacheWrite: 0 };
    return {
      helperId: "suggest-checks",
      call: {
        callId: `call_5a3e1000-${hex(daysAgo, 4)}-7000-8000-${hex(n, 12)}` as AgentCallUsage["callId"],
        stepId: "suggest-checks" as AgentCallUsage["stepId"],
        attempt: 1,
        agentId: "helper" as AgentCallUsage["agentId"],
        cliId: "claude-code",
        model: HAIKU,
        outcome: "completed",
        startedAt: endedAt - 4_000,
        endedAt,
        tokens,
        models: { [HAIKU]: tokens },
      },
    };
  });
}

/** How long before it resets Claude Code's sample weekly window is: it runs out before then. */
const WEEK_RESET_IN = 2 * DAY + 5 * HOUR;

/** Claude Code's sample answer to a usage request: a Max plan whose weekly limit runs out before it resets, read two minutes ago. */
export function sampleClaudePlan(now: number): PlanReading & { readonly version: string } {
  const weekReset = now + WEEK_RESET_IN;
  return {
    windows: [
      { window: "session", usedPercent: 36, resetsAt: now + 158 * MINUTE, group: "session", severity: "normal", active: true },
      { window: "weekly_all", usedPercent: 82, resetsAt: weekReset, group: "weekly", severity: "warning", active: false },
      { window: "weekly_scoped", usedPercent: 47, resetsAt: weekReset, scope: "Fable", group: "weekly", severity: "normal", active: false, sharePercent: 50 },
    ],
    asOf: now - 2 * MINUTE,
    plan: "max",
    extraUsage: "off",
    version: "2.1.331",
  };
}

/** Claude Code's sample usage request as a plan source. */
export function samplePlanSources(now: () => number): PlanSources {
  return { "claude-code": { request: async () => ({ ok: true, value: sampleClaudePlan(now()) }) } };
}

/** Codex CLI on pace for its weekly limit, read 34 minutes ago, and Ollama without a plan. */
export function sampleOtherPlans(now: number): CliPlan[] {
  const asOf = now - 34 * MINUTE;
  return [
    {
      cliId: "codex-cli",
      windows: [withForecast({ window: "seven_day", usedPercent: 41, resetsAt: now + 3 * DAY + 15 * HOUR }, asOf)],
      source: "request",
      asOf,
      version: "0.169.0",
      billing: "plan",
    },
    { cliId: "ollama", windows: [], note: "Local models have no plan limit." },
  ];
}

/** What the sample logs hold of Claude Code against what Tokama ran: the user's own sessions are 82/62 of it. */
const LOGGED_PER_TOKAMA = 82 / 62;

const claudeCalls = (calls: readonly AgentCallUsage[], from: number, to: number) => calls.filter((call) => call.cliId === "claude-code" && call.endedAt >= from && call.endedAt <= to);

/**
 * Claude Code's sample log totals between two times: Tokama's own calls in them (they are in
 * Claude Code's logs too), and the user's own sessions on top, so that of the 82% used this week
 * Tokama's calls took 62%.
 */
export function sampleLogTotals(calls: readonly AgentCallUsage[], from: number, to: number): { model: string; tokens: TokenUsage }[] {
  const byModel = new Map<string, TokenUsage>();
  for (const call of claudeCalls(calls, from, to)) {
    for (const [model, tokens] of Object.entries(call.models ?? { [call.model]: call.tokens })) {
      const sum = byModel.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      byModel.set(model, { input: sum.input + tokens.input, output: sum.output + tokens.output, cacheRead: sum.cacheRead + tokens.cacheRead, cacheWrite: sum.cacheWrite + tokens.cacheWrite });
    }
  }
  return [...byModel].map(([model, t]) => ({
    model,
    tokens: { input: Math.round(t.input * LOGGED_PER_TOKAMA), output: Math.round(t.output * LOGGED_PER_TOKAMA), cacheRead: Math.round(t.cacheRead * LOGGED_PER_TOKAMA), cacheWrite: Math.round(t.cacheWrite * LOGGED_PER_TOKAMA) },
  }));
}

/** Claude Code's sample weekly window that closed when this one began: 64% used, 46 points of it Tokama's. */
export function sampleHistory(calls: readonly AgentCallUsage[], now: number): PastWindow[] {
  const endsAt = now + WEEK_RESET_IN - 7 * DAY;
  const startsAt = endsAt - 7 * DAY;
  const tokama = claudeCalls(calls, startsAt, endsAt).reduce((sum, call) => sum + (callWeight(call) ?? 0), 0);
  return [{ window: "weekly_all", startsAt, endsAt, usedPercent: 64, ...(tokama > 0 && { weight: { tokama, all: (tokama * 64) / 46 }, pricesAsOf: PRICES_AS_OF }) }];
}

/**
 * Claude Code's sample usage from its own logs: more than Tokama ran, on three models, in the
 * sample repos and outside them, every day of the last 90.
 */
export function sampleLogEntries(setup: Setup, now: number): UsageEntry[] {
  const today = new Date(now);
  const entries: UsageEntry[] = [];
  const models = [
    { model: OPUS, scale: 1 },
    { model: SONNET, scale: 0.6 },
    { model: HAIKU, scale: 0.2 },
  ];
  for (let daysAgo = DAYS - 1; daysAgo >= 0; daysAgo--) {
    const next = random(daysAgo * 104_729 + 3);
    const day = localDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo).getTime());
    for (const [n, { model, scale }] of models.entries()) {
      const repoId = n === 2 ? null : (setup.repos[n % Math.max(1, setup.repos.length)]?.id ?? null);
      const messages = Math.round((40 + next() * 260) * scale);
      entries.push(
        pricedEntry({
          day,
          model,
          cliId: "claude-code",
          repoId,
          calls: messages,
          tokens: {
            input: messages * Math.round(5 + next() * 40),
            output: messages * Math.round(200 + next() * 900),
            cacheRead: messages * Math.round(20_000 + next() * 60_000),
            cacheWrite: messages * Math.round(500 + next() * 3_000),
          },
        }),
      );
    }
  }
  return entries;
}
