// Accounts and limits: one card per AI CLI with its icon, plan badge (the plan's name only),
// login state and version, a meter per limit with a countdown to its reset, the CLI's note, and
// where the numbers came from. A meter's fill takes its level's colour, with a symbol or a word
// beside it, never colour alone. The key under the cards says what each colour means.
import type { CliPlan, Setup, UsageReport } from "@tokama/core";
import { AI_CLIS, type CliIssue } from "../model.js";
import { Meter, MeterKey } from "./Meter.js";
import { formatDuration } from "../format/duration.js";
import { stamp } from "../format/time.js";
import { ageText, ALERT_TEXT, cardLabel, liveWindows, resetWhen, shareText, SOURCE_TEXT } from "./usage-model.js";
import { BackendMark } from "../ui/agent.js";
import { Button } from "../ui/Button.js";
import { Pill } from "../ui/Pill.js";

const TEXT = {
  title: "Accounts and limits",
  refreshes: "refreshes every 5 min · as of",
  refresh: "Refresh",
  loggedIn: "logged in",
  local: "local",
  planUnknown: "plan not reported",
  badgeUnknown: "PLAN ?",
  badgeLocal: "LOCAL",
  resetUnknown: "reset time unknown",
  source: "Source:",
  neverReadsLogin: "Tokama never reads its login.",
} as const;

export interface AccountCardsProps {
  readonly report: UsageReport;
  readonly setup: Setup | undefined;
  readonly issues: readonly CliIssue[];
  readonly now: number;
  readonly onRefresh: () => void;
}

export function AccountCards({ report, setup, issues, now, onRefresh }: AccountCardsProps) {
  // When the limits were last read, not when the report was made: a refresh that reads nothing new keeps the time.
  const readings = report.clis.flatMap((cli) => (cli.asOf === undefined ? [] : [cli.asOf]));
  const asOf = readings.length === 0 ? report.asOf : Math.max(...readings);
  return (
    <section className="ins-section ins-accounts" aria-labelledby="ins-accounts-title">
      <div className="ins-accounts-head">
        <h2 id="ins-accounts-title" className="ins-h2">
          {TEXT.title}
        </h2>
        <span className="muted ins-refreshes">
          {TEXT.refreshes} <span className="mono ins-asof">{stamp(asOf, now)}</span>
        </span>
        <Button variant="secondary" size="sm" className="ins-refresh" onClick={onRefresh}>
          <span aria-hidden="true">↻</span> {TEXT.refresh}
        </Button>
      </div>
      <div className="ins-cards">
        {AI_CLIS.map((cli) => {
          const plan = report.clis.find((entry) => entry.cliId === cli.id) ?? { cliId: cli.id, windows: [] };
          return <AccountCard key={cli.id} name={cli.name} plan={plan} setup={setup} issue={issues.find((issue) => issue.cliId === cli.id)} now={now} />;
        })}
      </div>
      <MeterKey />
    </section>
  );
}

interface AccountCardProps {
  readonly name: string;
  readonly plan: CliPlan;
  readonly setup: Setup | undefined;
  readonly issue: CliIssue | undefined;
  readonly now: number;
}

function AccountCard({ name, plan, setup, issue, now }: AccountCardProps) {
  const local = plan.cliId === "ollama";
  const health = setup?.health.clis.find((cli) => cli.cliId === plan.cliId);
  const loggedIn = health !== undefined && health.timedOut !== true && health.installed && health.loggedIn;
  const state = issue !== undefined ? ALERT_TEXT[issue.kind] : local ? TEXT.local : loggedIn ? TEXT.loggedIn : undefined;
  const sub = [state, plan.version ?? health?.version, plan.plan === undefined && !local ? TEXT.planUnknown : undefined].filter((part) => part !== undefined);
  const badge = plan.plan !== undefined ? plan.plan.toUpperCase() : local ? TEXT.badgeLocal : TEXT.badgeUnknown;
  const age = plan.asOf === undefined ? undefined : ageText(plan.asOf, now);
  return (
    <article className="ins-card" aria-label={name}>
      <header className="ins-card-head">
        <span className="monogram" aria-hidden="true">
          <BackendMark cliId={plan.cliId} size={16} />
        </span>
        <span className="ins-card-name">
          <span className="ins-card-title">
            <strong>{name}</strong>
            <Pill className="mono ins-badge" tone={plan.plan !== undefined ? "accent" : undefined}>
              {badge}
            </Pill>
          </span>
          <span className="muted ins-card-sub">
            {sub.map((part, index) => (
              <span key={index} data-tone={issue !== undefined && index === 0 ? "fail" : undefined}>
                {index > 0 && " · "}
                {part}
              </span>
            ))}
          </span>
        </span>
      </header>
      {liveWindows(plan, now).map((w, index) => {
        const extra = [shareText(w), age].filter(Boolean).join(" · ");
        return (
          <Meter key={`${index}-${w.window}`} name={cardLabel(w)} usedPercent={w.usedPercent}>
            {w.resetsAt === undefined ? (
              TEXT.resetUnknown
            ) : (
              <>
                <span className="mono ins-countdown">
                  <span aria-hidden="true">↻</span>
                  <span className="visually-hidden">resets in</span> {formatDuration(w.resetsAt - now, "minutes")}
                </span>
                {` · ${resetWhen(w.resetsAt, now)}`}
              </>
            )}
            {extra !== "" && ` · ${extra}`}
          </Meter>
        );
      })}
      {plan.note !== undefined && <p className="ins-card-note">{plan.note}</p>}
      {plan.source !== undefined && (
        <p className="muted ins-source">
          {TEXT.source} {SOURCE_TEXT[plan.source]}.{plan.cliId === "claude-code" && ` ${TEXT.neverReadsLogin}`}
        </p>
      )}
    </article>
  );
}
