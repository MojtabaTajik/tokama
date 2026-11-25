// Sample usage for the fake engine mode: 90 days of agent calls over the sample workflows, made
// up the same way on every start (a seeded generator, days in local time), and plan readings that
// show every state the Insights page draws: a CLI well inside its limits, one near its weekly
// limit, and a local model host without a plan.
import { type AgentCallUsage, type CliPlan, type ItemId, type ItemRecord, localDate, type PlanReading, pricedEntry, type Setup, type UsageEntry, type UsageRow } from "@tokama/core";

const MINUTE = 60_000;
const DAYS = 90;

/** Earlier items of each sample workflow, by template id (without its `builtin/` part), so the history has more than today's items. */
const HISTORY: Readonly<Record<string, readonly string[]>> = {
  "plan-and-build": [
    "Add order export endpoint",
    "Upgrade the Postgres driver in orders-api",
    "Paginate the orders list",
    "Add retry with backoff to the payment client",
    "Fix rounding in invoice totals",
    "Move invoice PDFs to the job queue",
    "Add a health endpoint to inventory-service",
  ],
  "emergency-investigator": ["Orders API returns 500 after deploy", "Checkout latency spike", "Payment webhook timeouts", "Inventory sync stalls at night"],
  "db-slow-query": ["Slow query on order_items", "Slow search on customers", "Lock waits on stock_levels"],
  "quick-fix": ["Flaky inventory sync test", "Typo in the refund email", "Wrong currency on the cart total"],
};

// The cloud model the sample architect's calls report.
const CLAUDE_MODEL = "claude-opus-5-5";

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

/** The sample calls of the last 90 days, ending now. Today's items are the sample board's own. */
export function sampleUsageRows(setup: Setup, items: readonly ItemRecord[], now: number): UsageRow[] {
  const today = new Date(now);
  const rows: UsageRow[] = [];
  const agents = new Map(setup.agents.map((agent) => [agent.id, agent]));
  let calls = 0;
  for (let daysAgo = DAYS - 1; daysAgo >= 0; daysAgo--) {
    const next = random(daysAgo * 7919 + 17);
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo);
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    templates: for (const template of setup.templates) {
      const titles = HISTORY[template.id.split("/").pop() ?? template.id];
      if (titles === undefined) continue;
      // Fewer runs at weekends; plan and build runs most days.
      const runs = Math.floor(next() * (template.id.endsWith("/plan-and-build") ? 3 : 2) * (weekend ? 0.4 : 1) + (daysAgo === 0 ? 1 : 0));
      for (let run = 0; run < runs; run++) {
        const pick = Math.floor(next() * titles.length);
        const title = titles[pick]!;
        // Today's items with a sample record keep its id, so the drawer opens on them.
        const record = daysAgo <= 1 ? items.find((item) => item.title === title) : undefined;
        const itemId = (record?.id ?? `item_5a3e${hex(pick, 4)}-${hex(daysAgo, 4)}-4000-8000-${hex(run, 12)}`) as ItemId;
        // Work hours on earlier days. Today, the hours before now, shrunk to fit into the part of the
        // day that has passed, so today has calls at any hour, also just after midnight.
        const span = template.steps.length * 18 * MINUTE;
        const fit = daysAgo === 0 ? Math.min(1, (now - day.getTime()) / (span + 140 * MINUTE)) : 1;
        let at = daysAgo === 0 ? now - (span + (20 + next() * 120) * MINUTE) * fit : day.getTime() + (9 + next() * 8) * 60 * MINUTE;
        for (const step of template.steps) {
          const agent = step.agentId === undefined ? undefined : agents.get(step.agentId);
          if (agent === undefined) continue;
          const durationMs = Math.round((2 + next() * 14) * MINUTE * fit);
          const endedAt = Math.min(now, Math.round(at + durationMs));
          if (endedAt > now) continue templates;
          at = endedAt + 2 * MINUTE * fit;
          calls++;
          const cliId = agent.runsOn === "local" ? "ollama" : agent.cliId;
          const scale = cliId === "ollama" ? 0.6 : cliId === "codex-cli" ? 0.8 : 1;
          const tokens = {
            input: Math.round((2_000 + next() * 18_000) * scale),
            output: Math.round((1_000 + next() * 7_000) * scale),
            cacheRead: Math.round((20_000 + next() * 130_000) * scale),
            cacheWrite: cliId === "claude-code" ? Math.round(5_000 + next() * 25_000) : 0,
          };
          const call: AgentCallUsage = {
            callId: `call_5a3e0000-${hex(daysAgo, 4)}-7000-8000-${hex(calls, 12)}` as AgentCallUsage["callId"],
            stepId: step.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") as AgentCallUsage["stepId"],
            attempt: 1,
            agentId: agent.id,
            cliId,
            model: cliId === "claude-code" ? CLAUDE_MODEL : agent.model,
            outcome: "completed",
            startedAt: endedAt - durationMs,
            endedAt,
            tokens,
            ...(cliId === "claude-code" && { models: { [CLAUDE_MODEL]: tokens } }),
          };
          const repo = setup.repos[pick % Math.max(1, setup.repos.length)];
          rows.push({ itemId, title, templateId: template.id, ...(repo !== undefined && { repoId: repo.id }), call });
        }
      }
    }
  }
  return rows;
}

/** Claude Code's sample answer to a usage request: inside its limits, one of them for one model, read two minutes ago. */
export function sampleClaudePlan(now: number): PlanReading & { readonly version: string } {
  const weekReset = now + 2 * 24 * 60 * MINUTE + 18 * 60 * MINUTE;
  return {
    windows: [
      { window: "session", usedPercent: 36, resetsAt: now + 158 * MINUTE, group: "session", severity: "normal", active: true },
      { window: "weekly_all", usedPercent: 58, resetsAt: weekReset, group: "weekly", severity: "normal", active: false },
      { window: "weekly_scoped", usedPercent: 12, resetsAt: weekReset, scope: "Fable", group: "weekly", severity: "normal", active: false, sharePercent: 50 },
    ],
    asOf: now - 2 * MINUTE,
    plan: "max",
    extraUsage: "off",
    version: "2.1.331",
  };
}

/** Codex CLI near its weekly limit, read 34 minutes ago, and Ollama without a plan. */
export function sampleOtherPlans(now: number): CliPlan[] {
  return [
    {
      cliId: "codex-cli",
      windows: [{ window: "seven_day", usedPercent: 84, resetsAt: now + 3 * 24 * 60 * MINUTE + 15 * 60 * MINUTE }],
      source: "request",
      asOf: now - 34 * MINUTE,
      version: "0.169.0",
    },
    { cliId: "ollama", windows: [], note: "Local models have no plan limit." },
  ];
}

/**
 * Claude Code's sample usage from its own logs: more than Tokama ran, on three models, in the
 * sample repos and outside them, every day of the last 90.
 */
export function sampleLogEntries(setup: Setup, now: number): UsageEntry[] {
  const today = new Date(now);
  const entries: UsageEntry[] = [];
  const models = [
    { model: "claude-opus-5-5", scale: 1 },
    { model: "claude-sonnet-5-5", scale: 0.6 },
    { model: "claude-haiku-5-5", scale: 0.2 },
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
