// Same step, different model: per step, one row per model with its runs, how often the checks passed
// first time ("78% · 36 of 46"), attempts, what a run took and its time. A step shows only when two
// models have 5 or more runs each (the engine sends only those); under that the section is absent.
// Facts only: no advice and no winner mark.
import type { AiCliId, Setup, UsageReport } from "@tokama/core";
import { AgentRing } from "../agent/AgentRing.js";
import { formatDuration } from "../format/duration.js";
import { cliName } from "../model.js";
import { BackendMark } from "../ui/agent.js";
import { firstTry, perRunOf } from "./model-record.js";
import { workflowName } from "./usage-model.js";

const TEXT = {
  title: "Same step, different model",
  note: "your own runs · last 90 days · steps with 5 or more runs on each model",
  table: "Same step, different model",
  model: "Model",
  runs: "Runs",
  firstTry: "Checks passed first try",
  attempts: "Attempts",
  time: "Time per run",
  history: "A run is one item passing the step, retries included. The items differ per model, so this is your history, not a test.",
} as const;

export interface ModelTableProps {
  readonly report: UsageReport;
  readonly only: AiCliId | undefined;
  readonly setup: Setup | undefined;
}

export function ModelTable({ report, only, setup }: ModelTableProps) {
  // Under a tool's filter a step keeps only that tool's models, and shows only while two remain.
  const groups = (report.stepModels ?? []).map((group) => ({ ...group, models: group.models.filter((record) => only === undefined || record.cliId === only) })).filter((group) => group.models.length >= 2);
  if (groups.length === 0) return null;
  // One unit for the whole table, so a column compares.
  const unit = perRunOf(groups.flatMap((group) => group.models));
  return (
    <section className="ins-section" aria-labelledby="ins-models-title">
      <header className="ins-section-head">
        <h2 id="ins-models-title" className="ins-h2">
          {TEXT.title}
        </h2>
        <span className="muted">{TEXT.note}</span>
      </header>
      <div className="ins-scroll">
        <div className="ins-models" role="table" aria-label={TEXT.table}>
          <div className="ins-model-row ins-rank-head" role="row">
            <span role="columnheader">{TEXT.model}</span>
            <span role="columnheader" className="ins-rank-num">
              {TEXT.runs}
            </span>
            <span role="columnheader" className="ins-rank-num">
              {TEXT.firstTry}
            </span>
            <span role="columnheader" className="ins-rank-num">
              {TEXT.attempts}
            </span>
            <span role="columnheader" className="ins-rank-num">
              {unit.header}
            </span>
            <span role="columnheader" className="ins-rank-num">
              {TEXT.time}
            </span>
          </div>
          {groups.map((group) => {
            const agentId = report.week?.steps.find((step) => step.templateId === group.templateId && step.stepId === group.stepId)?.agentId;
            return (
              <div key={`${group.templateId}:${group.stepId}`} role="rowgroup" className="ins-model-group">
                <div role="row" className="ins-model-title">
                  <span role="rowheader">
                    {workflowName(group.templateId, setup)} · {group.stepName}
                  </span>
                  {agentId !== undefined && <AgentRing agentId={agentId} agents={setup?.agents ?? []} />}
                </div>
                {group.models.map((record) => {
                  const first = firstTry(record);
                  return (
                    <div key={`${record.cliId}:${record.model}`} role="row" className="ins-model-row">
                      <span role="cell" className="ins-model" title={cliName(record.cliId)}>
                        <BackendMark cliId={record.cliId} size={12} />
                        <span className="mono ins-model-name">{record.model}</span>
                      </span>
                      <span role="cell" className="mono ins-rank-num muted">
                        {record.runs}
                      </span>
                      <span role="cell" className="mono ins-rank-num">
                        {first === undefined ? (
                          <span className="muted">no checks</span>
                        ) : (
                          <>
                            {first.percent} <span className="ins-of">{first.of}</span>
                          </>
                        )}
                      </span>
                      <span role="cell" className="mono ins-rank-num">
                        {record.avgAttempts.toFixed(1)}
                      </span>
                      <span role="cell" className="mono ins-rank-num">
                        {unit.text(record)}
                      </span>
                      <span role="cell" className="mono ins-rank-num muted">
                        {formatDuration(record.durationMsPerRun, "coarse")}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      <p className="muted ins-note">{TEXT.history}</p>
    </section>
  );
}
