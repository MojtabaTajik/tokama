// The step track and the live activity line of the drawer and full view headers, and the
// breathing dot of a working card. Motion means an agent or a check works right now; with reduced
// motion the CSS keeps everything still (a dashed line, a solid mark). Engine text (step names,
// the activity label) is rendered as React text only.
import type { AgentSummary, ItemActivity, ItemRecord } from "@tokama/core";
import { type CSSProperties, Fragment, useState } from "react";
import { activityView, trackOf } from "./progress-view.js";

/** One breathing cycle, in ms: `--motion-breathe` in ui/motion.css. */
const BREATH_MS = 2_000;

/**
 * Every breathing mark on screen shares one 2 s clock: each starts its animation part-way into the
 * cycle, by the wall clock, so marks that appear at different times breathe together.
 */
export function useBreath(): CSSProperties {
  const [delay] = useState(() => -(Date.now() % BREATH_MS));
  return { animationDelay: `${delay}ms` };
}

export function StepTrack({ item }: { readonly item: Pick<ItemRecord, "state" | "steps"> }) {
  const breath = useBreath();
  const track = trackOf(item);
  if (track.steps.length === 0) return null;
  return (
    <p className="track" role="img" aria-label={track.label}>
      {track.steps.map((step, index) => (
        <Fragment key={index}>
          {index > 0 && <span className="track-line" data-live={step.live} aria-hidden="true" />}
          <span className="track-step" data-current={step.current} title={step.name}>
            <span className="track-mark" data-tone={step.tone} data-live={step.live} style={step.live ? breath : undefined} aria-hidden="true">
              {step.symbol}
            </span>
            <span className="track-name">{step.name}</span>
            {step.says !== undefined && (
              <span className="track-says" data-tone={step.tone}>
                {step.says}
              </span>
            )}
          </span>
        </Fragment>
      ))}
    </p>
  );
}

export interface ActivityLineProps {
  readonly item: Pick<ItemRecord, "state" | "steps">;
  readonly activity: ItemActivity | null;
  readonly agents: readonly AgentSummary[];
  readonly now: number;
}

/** "Builder · editing src/orders/list.ts · 3 m 12 s · quiet for 2 m", on one line; nothing when the item does not run a step. */
export function ActivityLine({ item, activity, agents, now }: ActivityLineProps) {
  const view = activityView(item, activity, agents, now);
  if (view === undefined) return null;
  return (
    <p className="activity" data-testid="activity">
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
    </p>
  );
}

/** The breathing dot before a working card's status word. */
export function LiveDot() {
  const breath = useBreath();
  return <span className="live-dot" style={breath} aria-hidden="true" />;
}
