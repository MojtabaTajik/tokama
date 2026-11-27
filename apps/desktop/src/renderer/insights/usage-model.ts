// What the Insights page, the item header and the rail tooltip derive from the usage report: words
// for windows and times, alerts per AI CLI, the forecast sentence, number formats and the AI tools'
// colours. Pure functions that take the clock as an argument, so they are tested without React or a
// real time.
import type { AiCliId, CliPlan, Setup, TemplateSummary, UsageReport } from "@tokama/core";
import { formatDuration } from "../format/duration.js";
import { clock, sameDay, stamp, weekday } from "../format/time.js";
import { AI_CLIS, cliName, type CliIssue } from "../model.js";
import { markOf, type Tone as StatusTone } from "../ui/status.js";

/** A window at or above this share of its limit is high, then near it. */
export const HIGH = 60;
export const NEAR_LIMIT = 80;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Data older than this says how old it is. */
const SHOW_AGE_AFTER_MS = 10 * MINUTE;

type PlanWindow = CliPlan["windows"][number];

const WINDOW_LABELS: Readonly<Record<string, string>> = {
  five_hour: "5-hour window",
  seven_day: "Weekly window",
  seven_day_opus: "Weekly · Opus",
  seven_day_sonnet: "Weekly · Sonnet",
  session: "Session window",
  weekly_all: "Weekly window",
};
/** The AI CLI's whole weekly window, not one scoped to a model. */
const isWeekly = (w: Pick<PlanWindow, "window" | "scope">): boolean => w.scope === undefined && (w.window === "weekly_all" || w.window === "seven_day");

/** "5-hour window", "Session window", "Fable weekly window"; a scoped limit without a name is "Scoped weekly window". */
export function windowLabel(w: Pick<PlanWindow, "window" | "scope">): string {
  if (w.window === "weekly_scoped") return `${w.scope ?? "Scoped"} weekly window`;
  return WINDOW_LABELS[w.window] ?? w.window.replace(/_/g, " ");
}
/** The short form, for the tooltip: "5-hour", "Weekly", "Fable weekly". */
export const windowShort = (w: Pick<PlanWindow, "window" | "scope">): string => windowLabel(w).replace(/ window$/, "");
/** "50% share of the weekly limit" for a scoped limit with a known share. */
export const shareText = (w: Pick<PlanWindow, "sharePercent">): string | undefined => (w.sharePercent === undefined ? undefined : `${Math.round(w.sharePercent)}% share of the weekly limit`);
/** The tone of a limit alert. */
type Tone = Extract<StatusTone, "warn" | "fail">;
const WARN = markOf("warning").symbol;
const FAIL = markOf("failed").symbol;

/**
 * How full a window is: under 60% ok, 60 to 79% high, 80% or more near its limit, 100% at it.
 * Each level above ok has a word or symbol shown beside its colour.
 */
export type Level = "ok" | "high" | "near" | "limit";
export const levelOf = (usedPercent: number): Level => (usedPercent >= 100 ? "limit" : usedPercent >= NEAR_LIMIT ? "near" : usedPercent >= HIGH ? "high" : "ok");
/** The meter fill's tone per level; `pass` draws neutral grey: a normal state has no colour. */
export const LEVEL_TONE: Readonly<Record<Level, "pass" | Tone>> = { ok: "pass", high: "warn", near: "fail", limit: "fail" };
/** The word beside the percentage; ok needs none. */
export const LEVEL_WORD: Readonly<Record<Level, string | undefined>> = { ok: undefined, high: "high", near: `${WARN} near limit`, limit: `${FAIL} at limit` };
/** The level for a screen reader, after the percentage. */
export const LEVEL_SPOKEN: Readonly<Record<Level, string>> = { ok: "ok", high: "high", near: "near limit", limit: "at limit" };

export type CliAlert = "logged_out" | "not_installed" | "limit" | "near_limit";

/**
 * The windows that still say something about now: one whose reset time has passed is dropped,
 * because the report may be older than the reset (it reloads only on events while nobody looks).
 */
export const liveWindows = (plan: CliPlan | undefined, now: number): CliPlan["windows"] => (plan?.windows ?? []).filter((w) => w.resetsAt === undefined || w.resetsAt > now);

/** What the rail badge and the tooltip say about a CLI: a login problem first, then its windows. */
export function cliAlert(plan: CliPlan | undefined, issue: CliIssue | undefined, now: number): CliAlert | undefined {
  if (issue !== undefined) return issue.kind;
  // By the shown (rounded) number, so the badge agrees with the meter.
  const levels = liveWindows(plan, now).map((w) => levelOf(Math.round(w.usedPercent)));
  return levels.includes("limit") ? "limit" : levels.includes("near") ? "near_limit" : undefined;
}

export const ALERT_TEXT: Readonly<Record<CliAlert, string>> = {
  logged_out: `${FAIL} logged out`,
  not_installed: `${FAIL} not found`,
  limit: `${FAIL} at limit`,
  near_limit: `${WARN} near limit`,
};
export const alertTone = (alert: CliAlert): Tone => (alert === "near_limit" ? "warn" : "fail");

/**
 * The words behind the "!" on the Insights icon, or undefined when there is no mark: some AI CLI has a
 * window at its limit ("Claude Code weekly limit reached. Its steps cannot run until Wed 18:00."). Near a
 * limit, logged out and not found give none: the first is a forecast, the others show on Attention.
 * Of a CLI's windows at the limit, the one that resets last decides the time; a window without a reset
 * time leaves it out. Two CLIs at their limits give two sentences.
 */
export function railBadge(usage: UsageReport | undefined, issues: readonly CliIssue[], now: number): string | undefined {
  const causes = AI_CLIS.flatMap((cli) => {
    const plan = usage?.clis.find((entry) => entry.cliId === cli.id);
    if (cliAlert(plan, issues.find((issue) => issue.cliId === cli.id), now) !== "limit") return [];
    const full = liveWindows(plan, now).filter((w) => levelOf(Math.round(w.usedPercent)) === "limit");
    const last = full.reduce((a, b) => (a.resetsAt === undefined || (b.resetsAt !== undefined && a.resetsAt >= b.resetsAt) ? a : b));
    // "Weekly" reads "weekly", a scoped "Fable weekly" stays, the older "Weekly · Opus" reads "Opus weekly".
    const short = windowShort(last);
    const named = /^Weekly · (.+)$/.exec(short);
    const name = named !== null ? `${named[1]} weekly` : last.scope === undefined ? short.charAt(0).toLowerCase() + short.slice(1) : short;
    const until = last.resetsAt === undefined ? "the limit resets" : sameDay(last.resetsAt, now) ? clock(last.resetsAt) : resetWhen(last.resetsAt, now);
    return [`${cli.name} ${name} limit reached. Its steps cannot run until ${until}.`];
  });
  return causes.length === 0 ? undefined : causes.join(" ");
}

/** "data 34 m old" once the data is older than a few minutes. */
export const ageText = (asOf: number, now: number): string | undefined => (now - asOf > SHOW_AGE_AFTER_MS ? `data ${formatDuration(now - asOf, "coarse")} old` : undefined);

const TOKEN_UNITS = [
  ["k", 1e3],
  ["M", 1e6],
  ["B", 1e9],
] as const;
// Decimals by size: "9.9k" and "163k"; "2.41M", "38.6M" and "420M"; the same for B.
const tokenDecimals = (value: number, unit: string): number => (value >= 100 ? 0 : value >= 10 ? (unit === "k" ? 0 : 1) : unit === "k" ? 1 : 2);

/** "1.2k", "163k", "2.41M", "2.34B". The unit is chosen after rounding, so 999,950 is "1.00M", never "1000k". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  for (const [index, [unit, size]] of TOKEN_UNITS.entries()) {
    const value = n / size;
    const rounded = Number(value.toFixed(tokenDecimals(value, unit)));
    if (rounded < 1000 || index === TOKEN_UNITS.length - 1) return `${rounded.toFixed(tokenDecimals(rounded, unit))}${unit}`;
  }
  return String(n);
}

/**
 * The money a pay-per-use call cost: "$16.10", "$1,755". Only the pay-per-use screens call this: a
 * plan user sees limit shares, never dollars. `estimated` marks a price from Tokama's price table
 * (the CLI gave no figure), with "≈".
 */
export const formatCost = (usd: number, estimated = false): string => `${estimated ? "≈ " : ""}$${usd < 100 ? usd.toFixed(2) : Math.round(usd).toLocaleString("en-US")}`;

/** "~27%", "~5.1%", "~8%", "<0.1%": a part of a limit, to one decimal under 10; the tilde says it is an estimate. */
export function limitShare(percent: number): string {
  if (percent < 0.05) return "<0.1%";
  return `~${percent < 10 ? Number(percent.toFixed(1)) : Math.round(percent)}%`;
}

/** A part of Tokama's own use, a whole percent: "39%". */
export const usePercent = (percent: number): string => `${percent > 0 && percent < 1 ? "<1" : Math.round(percent)}%`;

/** A limit's name in the Limits list: "Session · 5 hours", "Weekly · all models", "Weekly · Fable". */
const LIMIT_NAMES: Readonly<Record<string, string>> = {
  five_hour: "Session · 5 hours",
  session: "Session · 5 hours",
  seven_day: "Weekly",
  weekly_all: "Weekly · all models",
  seven_day_opus: "Weekly · Opus",
  seven_day_sonnet: "Weekly · Sonnet",
};
export function limitName(w: Pick<PlanWindow, "window" | "scope">): string {
  if (w.window === "weekly_scoped") return `Weekly · ${w.scope ?? "scoped"}`;
  return LIMIT_NAMES[w.window] ?? windowLabel(w);
}

/** When a reset happens: "at 17:10" today, "Thu 09:00" this week, else the full date. */
export function resetWhen(resetsAt: number, now: number): string {
  if (sameDay(resetsAt, now)) return `at ${clock(resetsAt)}`;
  if (resetsAt - now < 6 * DAY) return `${weekday(resetsAt)} ${clock(resetsAt)}`;
  return stamp(resetsAt, now);
}

/** A time the limit runs out, which is a guess: "Wed ~18:00", "~17:10" today. */
export function approxWhen(at: number, now: number): string {
  return sameDay(at, now) ? `~${clock(at)}` : `${weekday(at)} ~${clock(at)}`;
}

/** The template of a usage key: matched like items are, by the id the record carries. */
export const templateFor = (templateId: string, setup: Setup | undefined): TemplateSummary | undefined => setup?.templates.find((t) => t.id === templateId);
export const workflowName = (templateId: string, setup: Setup | undefined): string => templateFor(templateId, setup)?.name ?? templateId.split("/").pop() ?? templateId;

/** "Max plan"; undefined when the CLI did not say. */
export const planName = (plan: CliPlan): string | undefined => (plan.plan === undefined ? undefined : `${plan.plan.charAt(0).toUpperCase()}${plan.plan.slice(1)} plan`);

/** True for an AI CLI that bills per call (an API key): it has no plan limit to run out of. */
export const isPayPerUse = (plan: CliPlan | undefined): boolean => plan?.billing === "pay_per_use";

/**
 * The AI tools the filter offers, in the order the app lists them (which is the order they were
 * added): those the setup finds installed, and any that has a reading or runs in the report.
 * The engine lists every tool in `clis`, so the list alone says nothing about what is set up.
 */
export function usageTools(report: UsageReport, setup: Setup | undefined): readonly AiCliId[] {
  const used = new Set<AiCliId>();
  for (const plan of report.clis) if (plan.windows.length > 0 || plan.billing !== undefined) used.add(plan.cliId);
  for (const step of report.week?.steps ?? []) used.add(step.cliId);
  for (const helper of report.week?.helpers ?? []) used.add(helper.cliId);
  for (const health of setup?.health.clis ?? []) if (health.installed) used.add(health.cliId);
  return AI_CLIS.map((cli) => cli.id).filter((id) => used.has(id));
}

/** The colour of an AI tool's bars: by the place the tool has in the list, never by the amount. Further tools stay grey. */
const TOOL_COLOURS = ["var(--tag-sky)", "var(--tag-sand)", "var(--tag-clay)"] as const;
export const toolColour = (cliId: AiCliId, tools: readonly AiCliId[]): string => TOOL_COLOURS[tools.indexOf(cliId)] ?? "var(--chart-other)";

/** What the page's first sentence is about: one window of one AI tool. */
export interface Headline {
  readonly kind: "at_limit" | "runs_out" | "on_pace";
  readonly plan: CliPlan;
  readonly window: PlanWindow;
}

const soonest = (windows: readonly Headline[], by: (headline: Headline) => number): Headline | undefined => [...windows].sort((a, b) => by(a) - by(b))[0];

/**
 * The window the first sentence is about, over the tools shown: a limit already reached, else the
 * one that runs out first at its pace, else, when every limit holds, the weekly window nearest its
 * limit at the reset. Nothing when no window has a pace (no reading, or a tool with no plan).
 */
export function headlineOf(clis: readonly CliPlan[], now: number, only: AiCliId | undefined): Headline | undefined {
  const all = clis
    .filter((plan) => (only === undefined || plan.cliId === only) && !isPayPerUse(plan))
    .flatMap((plan) => liveWindows(plan, now).map((window): { plan: CliPlan; window: PlanWindow } => ({ plan, window })));
  const at = soonest(
    all.filter(({ window }) => window.usedPercent >= 100).map((entry) => ({ ...entry, kind: "at_limit" as const })),
    ({ window }) => window.resetsAt ?? Infinity,
  );
  if (at !== undefined) return at;
  const runs = soonest(
    all.filter(({ window }) => window.forecast?.runsOutAt !== undefined).map((entry) => ({ ...entry, kind: "runs_out" as const })),
    ({ window }) => window.forecast!.runsOutAt!,
  );
  if (runs !== undefined) return runs;
  const paced = all.filter(({ window }) => window.forecast !== undefined);
  const weekly = paced.filter(({ window }) => isWeekly(window));
  return soonest(
    (weekly.length > 0 ? weekly : paced).map((entry) => ({ ...entry, kind: "on_pace" as const })),
    ({ window }) => -window.forecast!.atResetPercent,
  );
}

/** "this week's pace is 16% a day" for a weekly window with a known start; else nothing. */
export function paceText(window: PlanWindow, now: number): string | undefined {
  if (window.startsAt === undefined || !isWeekly(window) || window.usedPercent <= 0) return undefined;
  const days = Math.max(now - window.startsAt, MINUTE) / DAY;
  return `this week's pace is ${Math.round(window.usedPercent / days)}% a day`;
}

/** The sentence under the headline's first line: plan, use, time left, reset, pace, how short, and the other tools. */
export function headlineFacts(headline: Headline, clis: readonly CliPlan[], now: number): string {
  const { plan, window } = headline;
  const left = window.resetsAt === undefined ? undefined : window.resetsAt - now;
  const short = window.forecast?.runsOutAt !== undefined && window.resetsAt !== undefined ? `about ${formatDuration(window.resetsAt - window.forecast.runsOutAt, "coarse")} short` : undefined;
  const others = clis
    .filter((other) => other.cliId !== plan.cliId && !isPayPerUse(other))
    .flatMap((other) => {
      const forecast = other.windows.find((w) => isWeekly(w) && w.forecast !== undefined)?.forecast ?? other.windows.find((w) => w.forecast !== undefined)?.forecast;
      if (forecast === undefined) return [];
      return [forecast.runsOutAt === undefined ? `${cliName(other.cliId)} is on pace to stay under` : `${cliName(other.cliId)} runs out ${approxWhen(forecast.runsOutAt, now)}`];
    });
  return [
    [planName(plan), `${Math.round(window.usedPercent)}% used${left === undefined || left <= 0 ? "" : ` with ${formatDuration(left, "coarse")} to go`}`].filter(Boolean).join(" · "),
    window.resetsAt === undefined ? undefined : `resets ${resetWhen(window.resetsAt, now)}`,
    paceText(window, now),
    short,
    ...others,
  ]
    .filter((part) => part !== undefined && part !== "")
    .join(" · ");
}

/** "Attempt 2", "Attempts 2 and 3", "Attempts 2, 3 and 4". */
export function attemptsText(attempts: readonly number[]): string {
  if (attempts.length === 1) return `Attempt ${attempts[0]}`;
  return `Attempts ${attempts.slice(0, -1).join(", ")} and ${attempts.at(-1)}`;
}
