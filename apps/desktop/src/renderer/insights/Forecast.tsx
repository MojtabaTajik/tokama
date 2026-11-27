// The page's first sentence: will a limit run out? It is about the window that ends soonest at its
// pace (or is already full), named with its AI tool. Without a pace there is no forecast, and the
// sentence says why: a tool with no plan, no reading yet, or pay per use (where money is the thing
// to watch, so the sentence is the week's cost).
import type { AiCliId, CliPlan, UsageReport } from "@tokama/core";
import { formatDuration } from "../format/duration.js";
import { cliName } from "../model.js";
import { markOf } from "../ui/status.js";
import { approxWhen, formatCost, headlineFacts, headlineOf, isPayPerUse, planName, resetWhen, windowShort } from "./usage-model.js";

const WARN = markOf("warning").symbol;
const FAIL = markOf("failed").symbol;

const TEXT = {
  localOnly: "Local models have no plan limits, so there is no forecast. Rows show tokens.",
  noReading: (names: string) => `No limit reading from ${names} yet, so there is no forecast. It comes with the first call Tokama runs on it.`,
  tooEarly: "No forecast yet: a window needs a little of its time to pass before its pace says anything.",
  perUse: (names: string) => `${names} · API key, pay per use · amounts are what ${names} reported for each call`,
} as const;

/** "weekly", "session", "Fable weekly": the window as it reads inside "your … limit". */
const limitWord = (window: Parameters<typeof windowShort>[0]): string => windowShort(window).replace(/^(Weekly|Session|5-hour)/, (word) => word.toLowerCase());

export interface ForecastProps {
  readonly report: UsageReport;
  readonly only: AiCliId | undefined;
  readonly now: number;
}

export function Forecast({ report, only, now }: ForecastProps) {
  const shown = report.clis.filter((plan) => only === undefined || plan.cliId === only);
  const headline = headlineOf(report.clis, now, only);
  if (headline !== undefined) {
    const { kind, plan, window } = headline;
    const tool = cliName(plan.cliId);
    const limit = `${tool} ${limitWord(window)} limit`;
    const when = window.resetsAt === undefined ? undefined : resetWhen(window.resetsAt, now);
    const sentence =
      kind === "runs_out"
        ? { mark: WARN, tone: "warn", text: `At this pace your ${limit} runs out ${approxWhen(window.forecast!.runsOutAt!, now)}` }
        : kind === "at_limit"
          ? { mark: FAIL, tone: "fail", text: `${limit} reached. Steps on it wait${when === undefined ? "" : ` until ${when}`}` }
          : { mark: undefined, tone: undefined, text: `At this pace you stay under your ${limit}: about ${Math.round(window.forecast!.atResetPercent)}% at the reset${when === undefined ? "" : ` ${when}`}` };
    return (
      <div className="ins-forecast" role="status">
        <p className="ins-forecast-line">
          {sentence.mark !== undefined && (
            <span className="ins-forecast-mark" data-tone={sentence.tone} aria-hidden="true">
              {sentence.mark}
            </span>
          )}
          <span>{sentence.text}</span>
        </p>
        <p className="ins-forecast-facts">{kind === "at_limit" ? atLimitFacts(plan, window, now) : headlineFacts(headline, report.clis, now)}</p>
      </div>
    );
  }
  const perUse = shown.filter((plan) => isPayPerUse(plan));
  if (perUse.length > 0) return <PerUse report={report} plans={perUse} />;
  const planned = shown.filter((plan) => plan.cliId !== "ollama");
  if (planned.length === 0) return <p className="ins-forecast-note">{TEXT.localOnly}</p>;
  if (planned.some((plan) => plan.windows.length > 0)) return <p className="ins-forecast-note">{TEXT.tooEarly}</p>;
  return <p className="ins-forecast-note">{TEXT.noReading(planned.map((plan) => cliName(plan.cliId)).join(" and "))}</p>;
}

function atLimitFacts(plan: CliPlan, window: CliPlan["windows"][number], now: number): string {
  return [planName(plan), window.resetsAt === undefined ? undefined : `resets in ${formatDuration(window.resetsAt - now, "coarse")}`, "items that wait say so on the board"].filter(Boolean).join(" · ");
}

function PerUse({ report, plans }: { readonly report: UsageReport; readonly plans: readonly CliPlan[] }) {
  const ids = new Set(plans.map((plan) => plan.cliId));
  const week = report.week;
  const costs = [...(week?.steps ?? []), ...(week?.helpers ?? [])].filter((row) => ids.has(row.cliId)).map((row) => row.costUsd);
  const total = costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
  const names = plans.map((plan) => cliName(plan.cliId)).join(" and ");
  return (
    <div className="ins-forecast">
      <p className="ins-forecast-line">
        <span>
          <span className="mono">{formatCost(total)}</span> {week?.window === "previous" ? "last week" : "this week"}
        </span>
      </p>
      <p className="ins-forecast-facts">{TEXT.perUse(names)}</p>
    </div>
  );
}
