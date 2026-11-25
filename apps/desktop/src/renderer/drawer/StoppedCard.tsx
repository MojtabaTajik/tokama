// The card of a step that failed or reached its limit: what its agent said, what ran after, and
// why Tokama stopped, then the decision's buttons and a link to the agent's notes. In the drawer
// each label sits above its content; in the full view it is the pinned bar, labels in a column on
// the left and the buttons on the right. The agent's words are React text only.
import type { Decision, ItemRecord, Setup } from "@tokama/core";
import type { TokamaBridge } from "../../shared/bridge.js";
import { DecisionChoices } from "./DecisionChoices.js";
import { stepAgent } from "./describe.js";
import { shownAttempt } from "./OutputTab.js";
import { useStepOutput } from "./StepOutput.js";
import { saidLabel, saidOf, stoppedLink, stoppedTitle, thenLine } from "./stopped-view.js";
import { Button } from "../ui/Button.js";
import { StatusMark } from "../ui/status.js";

const TEXT = {
  needsYou: "Needs you",
  then: "Then",
  why: "Why it stopped",
} as const;

export interface StoppedCardProps {
  readonly bridge: TokamaBridge;
  readonly item: ItemRecord;
  readonly setup: Setup | undefined;
  readonly decision: Decision & { readonly stopped: NonNullable<Decision["stopped"]> };
  readonly busy: boolean;
  readonly full: boolean;
  readonly onChoose: (decision: Decision, choice: string, note?: string) => void;
  /** The link: the Output tab on the step's attempt, or the Log tab. */
  readonly onShow: (to: "Output" | "Log", stepIndex: number) => void;
}

export function StoppedCard({ bridge, item, setup, decision, busy, full, onChoose, onShow }: StoppedCardProps) {
  const { stopped, stepIndex } = decision;
  const step = item.steps[stepIndex];
  const agent = step?.agentId === undefined ? undefined : stepAgent(step, setup?.agents ?? []).name;
  // The same attempt the Output tab shows for the step: its latest ended one.
  const attempt = step === undefined ? undefined : shownAttempt(step);
  const output = useStepOutput(bridge, item.id, stepIndex, attempt, attempt === undefined ? undefined : `stopped ${decision.id} ${attempt}`);
  const name = step?.name ?? `Step ${stepIndex + 1}`;
  const then = thenLine(stopped.then, item.steps, output);
  const link = stoppedLink(output, agent);
  return (
    <section className={full ? "needs-you stopped ex-decision" : "needs-you stopped"} aria-label={TEXT.needsYou}>
      <div className="stopped-main">
        <p className="needs-you-question stopped-title">
          <StatusMark status="needs_you" />
          {stoppedTitle(name, stopped)}
        </p>
        <dl className="stopped-facts">
          {agent !== undefined && output !== undefined && (
            <div className="stopped-fact">
              <dt>{saidLabel(agent)}</dt>
              <dd>
                <Said said={saidOf(output, agent, name)} />
              </dd>
            </div>
          )}
          <div className="stopped-fact">
            <dt>{TEXT.then}</dt>
            <dd className="stopped-then">
              <span className="mark" data-tone={then.mark.tone} aria-hidden="true">
                {then.mark.symbol}
              </span>
              {then.text}
            </dd>
          </div>
          <div className="stopped-fact">
            <dt>{TEXT.why}</dt>
            <dd>{stopped.why}</dd>
          </div>
        </dl>
      </div>
      <div className="stopped-actions">
        <DecisionChoices key={decision.id} decision={decision} busy={busy} danger="stop" onChoose={(choice, note) => onChoose(decision, choice, note)} />
        <Button variant="link" onClick={() => onShow(link.to, stepIndex)}>
          {link.text}
        </Button>
      </div>
    </section>
  );
}

function Said({ said }: { readonly said: ReturnType<typeof saidOf> }) {
  switch (said.kind) {
    case "note":
      return <span className="stopped-note">{said.text}</span>;
    case "lines":
      return (
        <>
          <Lines lines={said.lines} />
          <span className="stopped-note">{said.note}</span>
        </>
      );
    case "verdict":
      return (
        <>
          <span>{said.head}</span>
          {said.items.length > 0 && (
            <ul className="stopped-items">
              {said.items.map((item, index) => (
                <li key={index}>
                  {item.ref !== undefined && <code className="st-code">{item.ref}</code>}
                  <span>{item.text}</span>
                </li>
              ))}
            </ul>
          )}
          {said.more !== undefined && <span className="stopped-note">{said.more}</span>}
          {said.lines.length > 0 && <Lines lines={said.lines} />}
          {said.note !== undefined && <span className="stopped-note">{said.note}</span>}
        </>
      );
  }
}

function Lines({ lines }: { readonly lines: readonly string[] }) {
  return (
    <div className="stopped-lines mono">
      {lines.map((line, index) => (
        <div key={index}>{line}</div>
      ))}
    </div>
  );
}
