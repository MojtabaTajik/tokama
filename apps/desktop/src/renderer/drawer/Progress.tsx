// The step track and the live activity line of the drawer and full view headers. Motion means an
// agent works right now: the working agent's badge at the start of the activity line breathes, and
// nothing else in the header moves. The track is words: each step with its state and its agent.
// Engine text (step names, the activity label) is rendered as React text only.
import type { AgentSummary, ItemActivity, ItemRecord } from "@tokama/core";
import { type CSSProperties, Fragment, useId } from "react";
import { AgentBadge } from "../agent/AgentBadge.js";
import type { AgentInfo } from "../agent/agent-info.js";
import type { AgentTarget } from "../settings/describe.js";
import { AgentName } from "../ui/agent.js";
import { markOf, StatusMark } from "../ui/status.js";
import { Tooltip } from "../ui/Tooltip.js";
import { useTip } from "../ui/useTip.js";
import { activityView, type TrackStep, trackOf } from "./progress-view.js";

function TrackSteps({ steps }: { readonly steps: readonly TrackStep[] }) {
  return (
    <>
      {steps.map((step, index) => (
        <Fragment key={index}>
          {index > 0 && (
            <span className="track-sep" aria-hidden="true">
              ·
            </span>
          )}
          <span className="track-step" data-current={step.current}>
            <span className="track-name">{step.name}</span>
            <StatusMark status={step.mark} word={step.show === "spoken" ? "spoken" : "visible"} markless={step.show === "word"} />
            {step.agent !== undefined && <AgentName name={step.agent.name} hue={step.agent.hue} coloured />}
          </span>
        </Fragment>
      ))}
    </>
  );
}

/** "Plan ✓ Architect · Build running Builder · Review next Reviewer"; a long one is "✓ 2 done · Build running · 2 to go" with the whole list in a tooltip. */
export function StepTrack({ item, agents }: { readonly item: Pick<ItemRecord, "state" | "steps">; readonly agents: readonly AgentSummary[] }) {
  const track = trackOf(item, agents);
  const tip = useTip(undefined);
  const tipId = useId();
  const anchor = `--track-${tipId.replace(/[^a-zA-Z0-9]/g, "")}`;
  if (track.steps.length === 0) return null;
  if (track.count === undefined) {
    return (
      <div className="track">
        <TrackSteps steps={track.steps} />
      </div>
    );
  }
  const { done, at, ahead } = track.count;
  const parts = [
    ...(done > 0 ? [<Fragment key="done">{`${markOf("passed").symbol} ${done} done`}</Fragment>] : []),
    ...(at === undefined ? [] : [<Fragment key="at">{`${at.name} ${at.mark.word}`}</Fragment>]),
    ...(ahead > 0 ? [<Fragment key="ahead">{`${ahead} to go`}</Fragment>] : []),
  ];
  return (
    <div className="track">
      <span className="track-count" tabIndex={0} role="group" aria-label={track.label} aria-describedby={tip.open ? tipId : undefined} style={{ anchorName: anchor } as CSSProperties} {...tip.triggers}>
        {parts.map((part, index) => (
          <Fragment key={index}>
            {index > 0 && " · "}
            {part}
          </Fragment>
        ))}
      </span>
      {tip.open && (
        <Tooltip id={tipId} anchor={anchor} className="track-tip">
          <TrackSteps steps={track.steps} />
        </Tooltip>
      )}
    </div>
  );
}

export interface ActivityLineProps {
  readonly item: Pick<ItemRecord, "state" | "steps">;
  readonly activity: ItemActivity | null;
  readonly agents: readonly AgentSummary[];
  /** The working agent, for its badge; none while Tokama runs the checks, which show ◐ instead. */
  readonly info?: AgentInfo | undefined;
  readonly onOpenAgent?: ((agent: AgentTarget) => void) | undefined;
  readonly now: number;
}

/** "[badge] Builder · editing src/orders/list.ts · 3 m 12 s · quiet for 2 m", on one line; nothing when the item does not run a step. */
export function ActivityLine({ item, activity, agents, info, onOpenAgent, now }: ActivityLineProps) {
  const view = activityView(item, activity, agents, now);
  if (view === undefined) return null;
  return (
    <div className="activity" data-testid="activity">
      {info === undefined || view.tokama ? <StatusMark status="checking" word="spoken" className="activity-mark" /> : <AgentBadge info={info} className="activity-badge" onOpen={onOpenAgent} />}
      <span className="activity-who">{view.who}</span>
      <span className="activity-sep" aria-hidden="true">
        ·
      </span>
      <span className="activity-head" title={view.action.full}>
        {view.action.head}
      </span>
      <span className="activity-tail" title={view.action.full}>
        {view.action.tail}
      </span>
      {view.elapsed !== undefined && (
        <>
          <span className="activity-sep" aria-hidden="true">
            ·
          </span>
          <span className="activity-time mono">{view.elapsed}</span>
        </>
      )}
      {view.quiet !== undefined && (
        <>
          <span className="activity-sep" aria-hidden="true">
            ·
          </span>
          <span className="activity-quiet">{view.quiet}</span>
        </>
      )}
    </div>
  );
}
