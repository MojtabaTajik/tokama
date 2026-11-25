// The body of the Insights tooltip in the rail: each AI CLI with its plan windows (share, reset
// time), the data's age, and a login problem or a window near its limit as a symbol and a word.
// Unknown windows say so; nothing is estimated here.
import type { UsageReport } from "@tokama/core";
import { type CliIssue, AI_CLIS } from "../model.js";
import { ALERT_TEXT, alertTone, ageText, cliAlert, formatClock, liveWindows, windowLine } from "../insights/usage-model.js";

const TEXT = {
  title: "Insights",
  loading: "usage not loaded yet",
  unknown: "windows unknown",
  noPlan: "no plan limit",
  open: "Click to open Insights",
} as const;

export interface InsightsTipProps {
  readonly usage: UsageReport | undefined;
  readonly issues: readonly CliIssue[];
  readonly now: number;
}

export function InsightsTip({ usage, issues, now }: InsightsTipProps) {
  return (
    <>
      <p className="insights-title">{TEXT.title}</p>
      <ul>
        {AI_CLIS.map((cli) => {
          const plan = usage?.clis.find((entry) => entry.cliId === cli.id);
          const alert = cliAlert(plan, issues.find((issue) => issue.cliId === cli.id), now);
          const age = plan?.asOf === undefined ? undefined : (ageText(plan.asOf, now) ?? `as of ${formatClock(plan.asOf, now)}`);
          const windows = liveWindows(plan, now);
          return (
            <li key={cli.id} className="it-cli">
              <span className="it-head">
                <span>{cli.name}</span>
                {alert !== undefined && (
                  <span className="it-alert" data-tone={alertTone(alert)}>
                    {ALERT_TEXT[alert]}
                  </span>
                )}
              </span>
              {windows.length > 0 ? (
                windows.map((w, index) => (
                  <span key={`${index}-${w.window}`} className="insights-state">
                    {windowLine(w, now)}
                  </span>
                ))
              ) : (
                <span className="insights-state">{usage === undefined ? TEXT.loading : cli.id === "ollama" ? TEXT.noPlan : TEXT.unknown}</span>
              )}
              {age !== undefined && <span className="insights-state">{age}</span>}
            </li>
          );
        })}
      </ul>
      <p className="insights-state">{TEXT.open}</p>
    </>
  );
}
