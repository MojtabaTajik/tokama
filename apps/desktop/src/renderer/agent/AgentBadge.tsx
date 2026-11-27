// The mark of an agent that works right now: its icon in a round badge, in the running blue, breathing.
// It is the only running mark of a row or a header, so it shows only while the agent works. It is a
// focus stop that opens the agent's tooltip on hover and on keyboard focus; its name tells who works,
// on which step and for how long, and the time ticks in this component only. It sits next to the row's
// own button, never inside it. Engine text (names, step names) is rendered as React text only.
import { useBreath } from "../ui/breath.js";
import { formatDuration } from "../format/duration.js";
import { Button } from "../ui/Button.js";
import { TemplateIcon } from "../shell/TemplateIcon.js";
import { useNow } from "../useNow.js";
import type { AgentTarget } from "../settings/describe.js";
import type { AgentInfo } from "./agent-info.js";
import { AgentTip, useAgentTip } from "./AgentLabel.js";

export interface AgentBadgeProps {
  readonly info: AgentInfo;
  /** The step the agent works on, for the badge's name: "Agent Builder, running Build, 12 min". */
  readonly stepName?: string | undefined;
  /** When the agent's attempt started; the badge's name says how long ago, to the minute. */
  readonly since?: number | undefined;
  /** The screen's class for the badge's place. */
  readonly className?: string | undefined;
  /** Opens the agent in Settings → Agents; without it the tooltip has no link. */
  readonly onOpen?: ((agent: AgentTarget) => void) | undefined;
}

/** What the badge's name says after "running": "Build, 12 min", "Build", or nothing. */
function workingOn(stepName: string | undefined, elapsed: string | undefined): string {
  return [stepName, elapsed].filter((part) => part !== undefined).join(", ");
}

export function AgentBadge({ info, stepName, since, className, onOpen }: AgentBadgeProps) {
  const { open, triggers, button, wrapper, tipId, anchor, anchorStyle } = useAgentTip();
  const breath = useBreath();
  const now = useNow(since !== undefined);
  const task = workingOn(stepName, since === undefined ? undefined : formatDuration(now - since, "coarse"));
  return (
    <span ref={wrapper} className={["ag-badge-wrap", className].filter(Boolean).join(" ")} {...triggers}>
      <Button
        variant="plain"
        ref={button}
        className="ag-badge"
        data-breathe="true"
        data-open={open || undefined}
        aria-label={`Agent ${info.name}, running${task === "" ? "" : ` ${task}`}`}
        aria-describedby={open ? tipId : undefined}
        style={{ ...anchorStyle, ...breath }}
      >
        <TemplateIcon icon={info.icon} size={10} />
      </Button>
      {open && <AgentTip id={tipId} anchor={anchor} info={info} onOpen={onOpen} />}
    </span>
  );
}
