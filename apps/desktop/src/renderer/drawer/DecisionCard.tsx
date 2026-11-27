// The drawer's decision card and what follows an answer. Engine text (the question, its reason,
// the cloud summary, agent output, the note) is rendered as React text only.
import type { Decision, ItemRecord, Setup } from "@tokama/core";
import { Button } from "../ui/Button.js";
import { StatusMark } from "../ui/status.js";
import { DecisionChoices } from "./DecisionChoices.js";
import { nextRunLine, runLine, stepAgent } from "./describe.js";
import { SaidLine } from "./SaidBlock.js";
import { type OutputState, StepPreview } from "./StepOutput.js";

const TEXT = {
  needsYou: "Needs you",
  noQuestion: "This item waits for you, but the engine sent no question yet.",
  willBeSent: "Will be sent",
  notSentYet: "Nothing has been sent yet",
  committed: (commit: string) => `Committed · ${commit}`,
  committedLine: (title: string, branch: string | undefined) => `${title}${branch === undefined ? "" : ` · on ${branch}`} · Done`,
  makingChanges: (agent: string, run: string | undefined) => `${agent} is making your changes${run === undefined ? "" : ` · ${run}`}`,
  yourNote: (note: string) => `Your note: "${note}"`,
  wrote: (step: string, agent: string | undefined) => `${step} · what ${agent ?? "the agent"} wrote`,
  attempt: (attempt: number) => `attempt ${attempt}`,
  seeDiff: "See the changed files in the Diff tab",
} as const;

interface NeedsYouProps {
  readonly item: ItemRecord;
  readonly setup: Setup | undefined;
  readonly decision: Decision | undefined;
  readonly busy: boolean;
  /** What the step's agent wrote, for a step you approve; the full view shows it on the Output tab instead. */
  readonly output: OutputState | undefined;
  /** The full view: the decision as a bar pinned at the top, its buttons beside the question. */
  readonly full: boolean;
  /** The step changed files: the card links to the Diff tab. */
  readonly changedFiles: boolean;
  /** Show full plan: the reader on this step's document; undefined hides the link. */
  readonly onRead: ((stepIndex: number) => void) | undefined;
  readonly onShowDiff: () => void;
  readonly onChoose: (decision: Decision, choice: string, note?: string) => void;
}

export function NeedsYou({ item, setup, decision, busy, output, full, changedFiles, onRead, onShowDiff, onChoose }: NeedsYouProps) {
  const step = decision === undefined ? undefined : item.steps[decision.stepIndex];
  const agent = step?.agentId === undefined ? undefined : stepAgent(step, setup?.agents ?? []).name;
  // What the agent says of the work you are asked to approve: its latest attempt's headline.
  const said = decision?.kind === "plan_approval" ? step?.attempts?.findLast((attempt) => attempt.said !== undefined)?.said : undefined;
  return (
    <section className={full ? "needs-you ex-decision" : "needs-you"} aria-label={TEXT.needsYou}>
      {decision ? (
        <>
          <p className="needs-you-question">
            <StatusMark status="needs_you" />
            {decision.question}
          </p>
          {decision.why !== undefined && <p className="needs-you-why">{decision.why}</p>}
          {decision.summaryText !== undefined && (
            <div className="cloud-summary">
              <p className="cloud-summary-label">
                <span>{TEXT.willBeSent}</span>
                <span className="muted">{TEXT.notSentYet}</span>
              </p>
              {/* Focusable, so a long summary can be scrolled with the keyboard. */}
              <pre className="cloud-summary-text mono" tabIndex={0} aria-label={TEXT.willBeSent}>
                {decision.summaryText}
              </pre>
            </div>
          )}
          {said !== undefined && <SaidLine said={said} agent={agent} />}
          {output !== undefined && step !== undefined && (
            <div className="step-output">
              <p className="step-output-label">
                <span>{TEXT.wrote(step.name, agent)}</span>
                {output.kind === "loaded" && <span className="muted mono">{TEXT.attempt(output.output.attempt)}</span>}
                {changedFiles && (
                  <Button variant="link" onClick={onShowDiff}>
                    {TEXT.seeDiff}
                  </Button>
                )}
              </p>
              <StepPreview state={output} label={TEXT.wrote(step.name, agent)} isPlan={step.name.toLowerCase() === "plan"} onShowFull={onRead && (() => onRead(decision.stepIndex))} />
            </div>
          )}
          <DecisionChoices key={decision.id} decision={decision} busy={busy} agent={agent} run={nextRunLine(step)} onChoose={(choice, note) => onChoose(decision, choice, note)} />
        </>
      ) : (
        <p className="needs-you-question">
          <StatusMark status="needs_you" />
          {TEXT.noQuestion}
        </p>
      )}
    </section>
  );
}

/**
 * What happened after a decision: the commit an approval made, or the step running again with the
 * note of Request changes.
 */
export function After({ item, setup }: { readonly item: ItemRecord; readonly setup: Setup | undefined }) {
  const commit = item.outcome?.commits?.[0];
  // After a merge the branch is gone: the Merged card in Finish says it all.
  if (item.state === "done" && commit !== undefined && item.finish?.merged === undefined) {
    return (
      <section className="after" data-tone="pass" aria-label={TEXT.committed(commit.commit.slice(0, 7))}>
        <StatusMark status="passed" />
        <div className="after-body">
          <p className="after-head">{TEXT.committed(commit.commit.slice(0, 7))}</p>
          <p className="after-text">{TEXT.committedLine(item.title, commit.branch)}</p>
        </div>
      </section>
    );
  }
  const step = item.steps.find((candidate) => candidate.state === "running" && candidate.changesNote !== undefined);
  if (step?.changesNote === undefined) return null;
  const line = TEXT.makingChanges(stepAgent(step, setup?.agents ?? []).name, runLine(step));
  return (
    <section className="after" data-tone="live" aria-label={line}>
      <StatusMark status="running" />
      <div className="after-body">
        <p className="after-head">{line}</p>
        <p className="after-text">{TEXT.yourNote(step.changesNote)}</p>
      </div>
    </section>
  );
}
