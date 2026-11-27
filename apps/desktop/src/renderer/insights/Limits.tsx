// Limits: one line per plan window of each AI tool shown: the tool, the window, a meter that is grey
// until 60%, the percent, and in words when it resets and where it ends up at its pace. A tool with
// no window says why in one line (local models, pay per use, a login problem, no reading yet).
import type { AiCliId, CliPlan, UsageReport } from "@tokama/core";
import { Fragment } from "react";
import { stamp } from "../format/time.js";
import type { CliIssue } from "../model.js";
import { cliName } from "../model.js";
import { BackendMark } from "../ui/agent.js";
import { Button } from "../ui/Button.js";
import { MeterBar } from "./Meter.js";
import { ageText, ALERT_TEXT, approxWhen, isPayPerUse, LEVEL_TONE, LEVEL_WORD, levelOf, limitName, liveWindows, resetWhen, shareText } from "./usage-model.js";

const TEXT = {
  title: "Limits",
  refreshes: "refreshes every 5 min · as of",
  refresh: "Refresh",
  list: "Plan limits",
  local: "Local models have no plan limits.",
  perUse: "Billed per use with an API key: no plan limit.",
  noReading: "No limit reading yet.",
  runsOut: "runs out",
  atThisPace: "at this pace",
  onPace: (percent: number) => `on pace for about ${percent}%`,
} as const;

export interface LimitsProps {
  readonly report: UsageReport;
  /** The tools shown, in order. */
  readonly tools: readonly AiCliId[];
  readonly issues: readonly CliIssue[];
  readonly now: number;
  readonly onRefresh: () => void;
}

export function Limits({ report, tools, issues, now, onRefresh }: LimitsProps) {
  // When the limits were last read, not when the report was made: a refresh that reads nothing new keeps the time.
  const readings = report.clis.flatMap((cli) => (cli.asOf === undefined ? [] : [cli.asOf]));
  const asOf = readings.length === 0 ? report.asOf : Math.max(...readings);
  return (
    <section className="ins-section" aria-labelledby="ins-limits-title">
      <header className="ins-section-head">
        <h2 id="ins-limits-title" className="ins-h2">
          {TEXT.title}
        </h2>
        <span className="muted">
          {TEXT.refreshes} <span className="mono">{stamp(asOf, now)}</span>
        </span>
        <Button variant="secondary" size="sm" className="ins-refresh" onClick={onRefresh}>
          <span aria-hidden="true">↻</span> {TEXT.refresh}
        </Button>
      </header>
      <div className="ins-scroll">
        <div className="ins-limits" role="list" aria-label={TEXT.list}>
          {tools.map((cliId) => (
            <Tool key={cliId} plan={report.clis.find((plan) => plan.cliId === cliId) ?? { cliId, windows: [] }} issue={issues.find((issue) => issue.cliId === cliId)} now={now} />
          ))}
        </div>
      </div>
    </section>
  );
}

function ToolCell({ plan }: { readonly plan: CliPlan }) {
  return (
    <span className="ins-limit-tool">
      <BackendMark cliId={plan.cliId} size={16} />
      <span className="ins-limit-name">{cliName(plan.cliId)}</span>
      {plan.plan !== undefined && <span className="mono ins-badge">{plan.plan.toUpperCase()}</span>}
    </span>
  );
}

function Tool({ plan, issue, now }: { readonly plan: CliPlan; readonly issue: CliIssue | undefined; readonly now: number }) {
  const windows = liveWindows(plan, now);
  if (windows.length === 0) {
    const words = issue !== undefined ? ALERT_TEXT[issue.kind] : plan.cliId === "ollama" ? TEXT.local : isPayPerUse(plan) ? TEXT.perUse : (plan.note ?? TEXT.noReading);
    return (
      <div role="listitem" className="ins-limit-row">
        <ToolCell plan={plan} />
        <span className="ins-limit-words ins-limit-wide" data-tone={issue === undefined ? undefined : "fail"}>
          {words}
        </span>
      </div>
    );
  }
  const age = plan.asOf === undefined ? undefined : ageText(plan.asOf, now);
  return (
    <>
      {windows.map((w, index) => {
        const shown = Math.round(w.usedPercent);
        const level = levelOf(shown);
        const word = LEVEL_WORD[level];
        const runsOut = w.forecast?.runsOutAt;
        const share = shareText(w);
        return (
          <div key={`${w.window}:${w.scope ?? ""}:${index}`} role="listitem" className="ins-limit-row">
            {index === 0 ? <ToolCell plan={plan} /> : <span />}
            <span className="ins-limit-window">{limitName(w)}</span>
            <MeterBar name={limitName(w)} usedPercent={w.usedPercent} />
            <span className="mono ins-limit-pct">{shown}%</span>
            <span className="ins-limit-words">
              {word !== undefined && (
                <>
                  <span data-tone={LEVEL_TONE[level]}>{word}</span> ·{" "}
                </>
              )}
              {w.resetsAt === undefined ? "reset time unknown" : <>resets <span className="mono">{resetWhen(w.resetsAt, now)}</span></>}
              {runsOut !== undefined ? (
                <Fragment>
                  {" · "}
                  <span data-tone="warn">!</span> {TEXT.runsOut} <span className="mono">{approxWhen(runsOut, now)}</span> {TEXT.atThisPace}
                </Fragment>
              ) : (
                w.forecast !== undefined && ` · ${TEXT.onPace(Math.round(w.forecast.atResetPercent))}`
              )}
              {share !== undefined && ` · ${share}`}
              {age !== undefined && index === 0 && ` · ${age}`}
            </span>
          </div>
        );
      })}
    </>
  );
}
