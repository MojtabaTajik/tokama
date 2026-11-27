// The Usage tab, top to bottom: the AI tool filter, one sentence on whether a limit runs out, the
// limits, what uses the weekly limits (Tokama and outside it, then step by step), the retries, and
// how each model did on the same step. Plan users see shares of their limit and never dollars; a
// pay-per-use user sees the real cost. Engine text (titles, names, notes) renders as React text only.
import type { AiCliId, Setup, UsageReport, UsageWindow } from "@tokama/core";
import type { CliIssue } from "../model.js";
import { AiFilter } from "./AiFilter.js";
import { Forecast } from "./Forecast.js";
import { Limits } from "./Limits.js";
import { ModelTable } from "./ModelTable.js";
import { WeeklyUse } from "./Ranking.js";
import { Retries } from "./Retries.js";
import { usageTools } from "./usage-model.js";

export interface UsageTabProps {
  readonly report: UsageReport;
  readonly window: UsageWindow;
  readonly onWindow: (window: UsageWindow) => void;
  /** The AI tool picked; undefined: all. Kept by the app, so a visit to another page keeps it. */
  readonly tool: AiCliId | undefined;
  readonly onTool: (tool: AiCliId | undefined) => void;
  readonly onRefresh: () => void;
  readonly setup: Setup | undefined;
  readonly issues: readonly CliIssue[];
  readonly now: number;
  readonly onSelectItem: (itemId: string) => void;
  readonly onNewWork: () => void;
}

export function UsageTab({ report, window, onWindow, tool, onTool, onRefresh, setup, issues, now, onSelectItem, onNewWork }: UsageTabProps) {
  const tools = usageTools(report, setup);
  // A choice of a tool that is gone (removed since) counts as All.
  const only = tool !== undefined && tools.includes(tool) ? tool : undefined;
  const shown = only === undefined ? tools : [only];
  return (
    <>
      <div className="ins-top">
        <AiFilter tools={tools} value={only} onChange={onTool} />
        <Forecast report={report} only={only} now={now} />
      </div>
      <Limits report={report} tools={shown} issues={issues} now={now} onRefresh={onRefresh} />
      <WeeklyUse report={report} only={only} tools={tools} setup={setup} window={window} onWindow={onWindow} onSelectItem={onSelectItem} onNewWork={onNewWork} />
      {report.week?.window === window && <Retries report={report} only={only} setup={setup} />}
      <ModelTable report={report} only={only} setup={setup} />
    </>
  );
}
