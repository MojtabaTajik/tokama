// Who runs a step, as the board shows it everywhere: an identity dot by the agent's join order
// (the first three agents get a colour, later ones and Tokama itself are neutral) and its name.
// The dot is decorative; the name always comes with it.
import type { ReactNode } from "react";

/** 1, 2 or 3 for the first three agents; "neutral" for later ones, unknown ones and Tokama. */
export type AgentDot = 1 | 2 | 3 | "neutral";

/** The dot of an agent by its place in the setup's agent list. */
export function agentDot(agentId: string | undefined, agents: readonly { readonly id: string }[]): AgentDot {
  const index = agentId === undefined ? -1 : agents.findIndex((agent) => agent.id === agentId);
  return index >= 0 && index < 3 ? ((index + 1) as 1 | 2 | 3) : "neutral";
}

export function AgentDotMark({ dot }: { readonly dot: AgentDot }) {
  return <span className="agent-dot" data-agent={dot} aria-hidden="true" />;
}

export interface AgentChipProps {
  readonly agent: { readonly name: string; readonly dot: AgentDot };
  /** The screen's class for the chip's place in its row. */
  readonly className?: string | undefined;
  /** Cut a long name with an ellipsis instead of wrapping. */
  readonly ellipsis?: boolean;
  /** What follows the name, such as the CLI's short name. */
  readonly children?: ReactNode;
}

/** The dot and the name, then anything the screen adds. */
export function AgentChip({ agent, className, ellipsis = false, children }: AgentChipProps) {
  return (
    <span className={["agent-chip", className].filter(Boolean).join(" ")}>
      <AgentDotMark dot={agent.dot} />
      {ellipsis ? <span className="ellipsis">{agent.name}</span> : agent.name}
      {children}
    </span>
  );
}
