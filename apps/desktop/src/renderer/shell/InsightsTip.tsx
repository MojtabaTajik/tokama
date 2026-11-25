// The body of the Insights tooltip in the rail. Claude Code first: whether it is logged in and its
// version, then the Plan block with a meter per limit (Claude Code's, then each other AI CLI's
// windows or login problem), then today's items with their tokens and agent time, today's totals,
// and a link to the AI CLIs settings. Unknown values say so; nothing is estimated here.
import type { CliHealth, Setup, UsageReport } from "@tokama/core";
import { stepAgent } from "../drawer/describe.js";
import { Meter } from "../insights/Meter.js";
import { formatDuration } from "../format/duration.js";
import { stamp } from "../format/time.js";
import { ALERT_TEXT, alertTone, ageText, cliAlert, formatTokens, liveWindows, shareText, totalOf, windowLabel, windowShort } from "../insights/usage-model.js";
import { AI_CLIS, type CliIssue } from "../model.js";
import { Button } from "../ui/Button.js";
import { BackendMark } from "../ui/agent.js";
import { StatusMark } from "../ui/status.js";

const TEXT = {
  loggedIn: "logged in",
  loggedOut: "logged out",
  notFound: "not found",
  statusUnknown: "login not checked yet",
  version: "version",
  plan: "Plan",
  asOf: "as of",
  loading: "usage not loaded yet",
  unknown: "plan windows unknown",
  resets: "resets",
  today: "Today",
  perItem: "tokens · agent time per item",
  noCalls: "No agent calls today.",
  todayUnknown: "today's usage unknown: the engine is older than this app",
  more: (n: number) => `and ${n} more ${n === 1 ? "item" : "items"}`,
  tokensToday: "Tokens today",
  timeToday: "Agent time today",
  footer: "From each call’s result event. Recorded, not limited.",
  settings: "Settings",
} as const;

const CLAUDE = AI_CLIS[0]!;
/** Today's items the tooltip lists; the rest are counted. */
const TODAY_ITEMS = 3;

export interface InsightsTipProps {
  readonly usage: UsageReport | undefined;
  readonly issues: readonly CliIssue[];
  /** The engine's checks of each AI CLI; absent until the setup loads. */
  readonly health?: readonly CliHealth[] | undefined;
  readonly setup?: Setup | undefined;
  readonly now: number;
  readonly onSelectItem?: (itemId: string) => void;
  readonly onCliSettings?: () => void;
}

export function InsightsTip({ usage, issues, health, setup, now, onSelectItem, onCliSettings }: InsightsTipProps) {
  const claude = usage?.clis.find((plan) => plan.cliId === CLAUDE.id);
  const windows = liveWindows(claude, now);
  const age = claude?.asOf === undefined ? undefined : (ageText(claude.asOf, now) ?? `${TEXT.asOf} ${stamp(claude.asOf, now)}`);
  const others = AI_CLIS.slice(1).flatMap((cli) => {
    const plan = usage?.clis.find((entry) => entry.cliId === cli.id);
    const issue = issues.find((entry) => entry.cliId === cli.id);
    const live = liveWindows(plan, now);
    return live.length > 0 || issue !== undefined ? [{ cli, live, issue, alert: cliAlert(plan, issue, now) }] : [];
  });
  const today = usage?.today;
  return (
    <>
      <div className="it-block it-status">
        <div className="it-head">
          <BackendMark cliId={CLAUDE.id} />
          <strong>{CLAUDE.name}</strong>
        </div>
        <ClaudeStatus health={health?.find((cli) => cli.cliId === CLAUDE.id)} issue={issues.find((issue) => issue.cliId === CLAUDE.id)} />
      </div>

      <section className="it-block" aria-label={TEXT.plan}>
        <div className="it-section-head">
          <span className="it-label">{TEXT.plan}</span>
          {age !== undefined && <span className="it-aside">{age}</span>}
        </div>
        {usage === undefined ? (
          <p className="it-note">{TEXT.loading}</p>
        ) : windows.length > 0 ? (
          windows.map((w, index) => (
            <Meter key={`${index}-${w.window}`} name={windowLabel(w)} usedPercent={w.usedPercent}>
              {[shareText(w), w.resetsAt === undefined ? undefined : `${TEXT.resets} ${stamp(w.resetsAt, now)}`].filter(Boolean).join(" · ") || undefined}
            </Meter>
          ))
        ) : (
          <p className="it-note">{claude?.note ?? TEXT.unknown}</p>
        )}
        {others.map(({ cli, live, issue, alert }) => (
          <div key={cli.id} className="it-other">
            {live.map((w, index) => (
              <Meter
                key={`${index}-${w.window}`}
                name={`${cli.name} ${windowLabel(w)}`}
                label={
                  <>
                    <BackendMark cliId={cli.id} /> {`${cli.name} · ${lowerFirst(windowShort(w))}`}
                  </>
                }
                usedPercent={w.usedPercent}
              >
                {[issue === undefined ? undefined : ALERT_TEXT[issue.kind], w.resetsAt === undefined ? undefined : `${TEXT.resets} ${stamp(w.resetsAt, now)}`].filter(Boolean).join(" · ") || undefined}
              </Meter>
            ))}
            {live.length === 0 && alert !== undefined && (
              <div className="ins-window-head">
                <span className="ins-window-name">
                  <BackendMark cliId={cli.id} /> {cli.name}
                </span>
                <span className="ins-tone" data-tone={alertTone(alert)}>
                  {ALERT_TEXT[alert]}
                </span>
              </div>
            )}
          </div>
        ))}
      </section>

      <section className="it-block" aria-label={TEXT.today}>
        <div className="it-section-head">
          <span className="it-label">{TEXT.today}</span>
          <span className="it-aside">{TEXT.perItem}</span>
        </div>
        {today === undefined || today.items.length === 0 ? (
          <p className="it-note">{usage === undefined ? TEXT.loading : today === undefined ? TEXT.todayUnknown : TEXT.noCalls}</p>
        ) : (
          <div className="it-items">
            {today.items.slice(0, TODAY_ITEMS).map((item) => (
              <div key={item.itemId} className="it-item">
                <Button variant="plain" className="it-title" title={item.title} onClick={() => onSelectItem?.(item.itemId)}>
                  {item.title}
                </Button>
                <span className="mono it-tokens">{formatTokens(item.tokens)}</span>
                <span className="mono it-time">{formatDuration(item.durationMs, "coarse")}</span>
                <span className="it-agents">{item.agents.map((agent) => stepAgent({ agentId: agent.agentId, data: "none" }, setup?.agents ?? []).name).join(" · ")}</span>
              </div>
            ))}
            {today.itemCount > TODAY_ITEMS && <span className="it-note">{TEXT.more(today.itemCount - TODAY_ITEMS)}</span>}
          </div>
        )}
      </section>

      {today !== undefined && (
        <div className="it-block it-totals">
          <span className="it-total-name">{TEXT.tokensToday}</span>
          <span className="mono it-total">{formatTokens(totalOf(today.tokens))}</span>
          <span className="it-total-parts">
            {[
              `input ${formatTokens(today.tokens.input)}`,
              `output ${formatTokens(today.tokens.output)}`,
              `cache read ${formatTokens(today.tokens.cacheRead)}`,
              ...(today.tokens.cacheWrite > 0 ? [`cache write ${formatTokens(today.tokens.cacheWrite)}`] : []),
            ].join(" · ")}
          </span>
          <span className="it-total-name">{TEXT.timeToday}</span>
          <span className="mono it-total">{formatDuration(today.durationMs, "coarse")}</span>
        </div>
      )}

      <div className="it-foot">
        <span>{TEXT.footer}</span>
        <Button variant="plain" className="it-link" onClick={onCliSettings}>
          {TEXT.settings}
        </Button>
      </div>
    </>
  );
}

function ClaudeStatus({ health, issue }: { readonly health: CliHealth | undefined; readonly issue: CliIssue | undefined }) {
  const version = health?.version === undefined ? undefined : `${TEXT.version} ${health.version}`;
  if (issue !== undefined) {
    return (
      <span className="it-status-line">
        <StatusMark status="failed" className="it-symbol" />{" "}
        {[issue.kind === "logged_out" ? TEXT.loggedOut : TEXT.notFound, version].filter(Boolean).join(" · ")}
      </span>
    );
  }
  if (health === undefined || health.timedOut === true) return <span className="it-status-line">{TEXT.statusUnknown}</span>;
  return (
    <span className="it-status-line">
      <StatusMark status="passed" className="it-symbol" />{" "}
      {[TEXT.loggedIn, version].filter(Boolean).join(" · ")}
    </span>
  );
}

const lowerFirst = (text: string): string => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
