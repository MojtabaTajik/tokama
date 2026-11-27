// An agent named in history: its icon in a round grey ring, then its name in neutral text. Blue is
// kept for the agent that works right now (AgentBadge), so a list of past work never reads as live.
// An agent the setup no longer lists draws the neutral icon and its id as the name.
import type { AgentSummary } from "@tokama/core";
import { TemplateIcon } from "../shell/TemplateIcon.js";

export interface AgentRingProps {
  readonly agentId: string;
  readonly agents: readonly Pick<AgentSummary, "id" | "name" | "icon">[];
  readonly className?: string | undefined;
}

export function AgentRing({ agentId, agents, className }: AgentRingProps) {
  const agent = agents.find((candidate) => candidate.id === agentId);
  return (
    <span className={["ag-ring-name", className].filter(Boolean).join(" ")}>
      <span className="ag-ring" aria-hidden="true">
        <TemplateIcon icon={agent?.icon} size={10} />
      </span>
      <span className="ag-ring-text">{agent?.name ?? agentId}</span>
    </span>
  );
}
