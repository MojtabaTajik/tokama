// Retries: the attempts after the first, grouped by what failed (the check command and its repo, or a
// reviewer who asked for changes), each with what it took of its tool's limit. One sentence says what
// all retries took of that tool. A tool without retries draws nothing.
import type { AiCliId, Setup, UsageReport } from "@tokama/core";
import { AgentRing } from "../agent/AgentRing.js";
import { cliName } from "../model.js";
import { BackendMark } from "../ui/agent.js";
import { measure } from "./ranking-model.js";
import { formatCost, formatTokens, isPayPerUse, limitShare, workflowName } from "./usage-model.js";

type Week = NonNullable<UsageReport["week"]>;
type Retry = Week["retries"][number];

const TEXT = {
  title: "Retries",
  note: (previous: boolean) => `attempts after the first · ${previous ? "last week" : "this week"}`,
  table: "Retries by what failed",
  failed: "What failed",
  step: "Step",
  agent: "Agent",
  retries: "Retries",
  review: "Reviewer asked for changes",
  count: (retries: number, items: number) => `${retries} in ${items} ${items === 1 ? "item" : "items"}`,
} as const;

/** One sentence for one tool: what its retries took, and of what Tokama used there. */
export function retrySentence(retry: Retry, week: Week, perUse: boolean): string {
  const tool = cliName(retry.cliId);
  const tokensOfTool = [...week.steps, ...week.helpers].filter((row) => row.cliId === retry.cliId).reduce((sum, row) => sum + row.tokens, 0);
  const ofTokama = tokensOfTool > 0 ? `${Math.max(1, Math.round((retry.tokens / tokensOfTool) * 100))}% of what Tokama used there` : undefined;
  // The cost of every retry, also those under no cause: money is the number a pay-per-use user acts on.
  if (perUse && retry.costUsd !== undefined) return `Retries cost about ${formatCost(retry.costUsd, retry.costEstimated)} on ${tool}${ofTokama === undefined ? "" : `, ${ofTokama}`}.`;
  if (retry.sharePercent !== undefined) return `Retries took about ${limitShare(retry.sharePercent).replace(/^~/, "")} of the ${tool} weekly limit${ofTokama === undefined ? "" : `, ${ofTokama}`}.`;
  return `Retries took ${formatTokens(retry.tokens)} tokens on ${tool}${ofTokama === undefined ? "" : `, ${ofTokama}`}.`;
}

export interface RetriesProps {
  readonly report: UsageReport;
  readonly only: AiCliId | undefined;
  readonly setup: Setup | undefined;
}

export function Retries({ report, only, setup }: RetriesProps) {
  const week = report.week;
  const retries = (week?.retries ?? []).filter((retry) => (only === undefined || retry.cliId === only) && (retry.tokens > 0 || retry.causes.length > 0));
  if (week === undefined || retries.length === 0) return null;
  const stepName = (templateId: string, stepId: string) => week.steps.find((step) => step.templateId === templateId && step.stepId === stepId)?.stepName ?? stepId;
  return (
    <section className="ins-section" aria-labelledby="ins-retries-title">
      <header className="ins-section-head">
        <h2 id="ins-retries-title" className="ins-h2">
          {TEXT.title}
        </h2>
        <span className="muted">{TEXT.note(week.window === "previous")}</span>
      </header>
      {retries.map((retry) => {
        const plan = report.clis.find((candidate) => candidate.cliId === retry.cliId);
        return (
          <div key={retry.cliId} className="ins-retry-tool">
            <p className="ins-sentence">{retrySentence(retry, week, isPayPerUse(plan))}</p>
            {retry.causes.length > 0 && (
              <div className="ins-scroll">
                <div className="ins-retry" role="table" aria-label={`${TEXT.table}, ${cliName(retry.cliId)}`}>
                  <div className="ins-retry-row ins-rank-head" role="row">
                    <span role="columnheader">{TEXT.failed}</span>
                    <span role="columnheader">{TEXT.step}</span>
                    <span role="columnheader">{TEXT.agent}</span>
                    <span role="columnheader" className="ins-rank-num">
                      {TEXT.retries}
                    </span>
                    <span role="columnheader" className="ins-rank-num">
                      {isPayPerUse(plan) ? "Cost" : retry.sharePercent === undefined ? "Tokens" : "Weekly limit"}
                    </span>
                  </div>
                  {retry.causes.map((cause, index) => {
                    const own = measure({ cliId: retry.cliId, tokens: cause.tokens, sharePercent: cause.sharePercent, costUsd: cause.costUsd }, plan);
                    return (
                      <div key={`${cause.kind}:${cause.command ?? ""}:${cause.repoId ?? ""}:${cause.templateId}:${cause.stepId}:${index}`} role="row" className="ins-retry-row ins-line">
                        <span role="cell" className="ins-cut">
                          {cause.kind === "check" ? (
                            <>
                              <span className="mono">{cause.command ?? "A check"}</span>
                              {cause.repoId !== undefined && <span className="mono muted ins-repo"> {cause.repoId}</span>}
                            </>
                          ) : (
                            TEXT.review
                          )}
                        </span>
                        <span role="cell" className="ins-cut muted">
                          {workflowName(cause.templateId, setup)} · {stepName(cause.templateId, cause.stepId)}
                        </span>
                        <span role="cell">
                          <AgentRing agentId={cause.agentId} agents={setup?.agents ?? []} />
                        </span>
                        <span role="cell" className="ins-rank-num muted">
                          {TEXT.count(cause.retries, cause.itemCount)}
                        </span>
                        <span role="cell" className="ins-rank-num ins-retry-value" title={cliName(retry.cliId)}>
                          <BackendMark cliId={retry.cliId} size={12} />
                          <span className="mono">{own.unit === "use" ? formatTokens(cause.tokens) : own.text}</span>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
