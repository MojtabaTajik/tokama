// Plan usage per AI CLI: one column each, with the CLI's monogram, plan and version, the data's
// time, a meter per window or limit (share used, a scoped limit's share of the weekly limit, reset time, age), extra usage, and where the numbers came from.
// A meter's fill takes its level's colour, with a symbol or a word beside it, never colour alone.
import type { CliPlan, UsageReport } from "@tokama/core";
import { type CliIssue, AI_CLIS } from "../model.js";
import { Meter, MeterKey } from "./Meter.js";
import { ALERT_TEXT, alertTone, ageText, CLI_MONOGRAMS, cliAlert, formatClock, liveWindows, resetText, shareText, SOURCE_TEXT, windowLabel } from "./usage-model.js";

const TEXT = {
  title: "Plan usage",
  planUnknown: "plan unknown",
  asOf: "as of",
  windowsUnknown: "Plan windows",
  unknown: "unknown",
  none: "none",
  extraUsage: "Extra usage",
  source: "Source:",
  neverReadsLogin: "Tokama never reads its login.",
} as const;

export function PlanMeters({ report, issues, now }: { readonly report: UsageReport; readonly issues: readonly CliIssue[]; readonly now: number }) {
  return (
    <section className="ins-section" aria-labelledby="ins-plan-title">
      <div className="ins-section-head">
        <h2 id="ins-plan-title" className="ins-h2">
          {TEXT.title}
        </h2>
        <MeterKey />
      </div>
      <div className="ins-plans">
        {AI_CLIS.map((cli) => {
          const plan = report.clis.find((entry) => entry.cliId === cli.id) ?? { cliId: cli.id, windows: [] };
          return <PlanColumn key={cli.id} name={cli.name} plan={plan} issue={issues.find((issue) => issue.cliId === cli.id)} now={now} />;
        })}
      </div>
    </section>
  );
}

function PlanColumn({ name, plan, issue, now }: { readonly name: string; readonly plan: CliPlan; readonly issue: CliIssue | undefined; readonly now: number }) {
  const alert = issue === undefined ? undefined : cliAlert(plan, issue, now);
  const windows = liveWindows(plan, now);
  const subtitle = [plan.plan === undefined ? (plan.cliId === "ollama" ? "local" : TEXT.planUnknown) : `${plan.plan[0]!.toUpperCase()}${plan.plan.slice(1)} plan`, plan.version].filter(Boolean).join(" · ");
  const age = plan.asOf === undefined ? undefined : ageText(plan.asOf, now);
  return (
    <article className="ins-plan" aria-label={name}>
      <header className="ins-plan-head">
        <span className="monogram" aria-hidden="true">
          {CLI_MONOGRAMS[plan.cliId]}
        </span>
        <span className="ins-plan-name">
          <strong>{name}</strong>
          <span className="muted">{subtitle}</span>
        </span>
        {plan.asOf !== undefined && (
          <span className="muted ins-asof">
            {TEXT.asOf} <span className="mono">{formatClock(plan.asOf, now)}</span>
          </span>
        )}
      </header>
      {alert !== undefined && (
        <p className="ins-alert" data-tone={alertTone(alert)}>
          {ALERT_TEXT[alert]}
        </p>
      )}
      {windows.length > 0 ? (
        windows.map((w, index) => (
          <Meter key={`${index}-${w.window}`} name={windowLabel(w)} usedPercent={w.usedPercent}>
            {[shareText(w), resetText(w.resetsAt, now), age].filter(Boolean).join(" · ")}
          </Meter>
        ))
      ) : (
        <div className="ins-window">
          <div className="ins-window-head">
            <span>{TEXT.windowsUnknown}</span>
            <span className="mono ins-pct muted">{plan.cliId === "ollama" ? TEXT.none : TEXT.unknown}</span>
          </div>
          {plan.note !== undefined && <p className="muted ins-reset">{plan.note}</p>}
        </div>
      )}
      {plan.cliId === "claude-code" && (
        <div className="ins-window-head">
          <span>{TEXT.extraUsage}</span>
          <span className="mono ins-pct muted">{plan.extraUsage ?? TEXT.unknown}</span>
        </div>
      )}
      {plan.source !== undefined && (
        <p className="muted ins-source">
          {TEXT.source} {SOURCE_TEXT[plan.source]}. {TEXT.neverReadsLogin}
        </p>
      )}
    </article>
  );
}
