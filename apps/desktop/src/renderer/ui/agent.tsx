// Who runs a step, as the board shows it everywhere: an identity dot by the agent's join order
// (the first three agents get a colour, later ones and Tokama itself are neutral) and its name.
// The dot is decorative; the name always comes with it.
import type { AiCliId } from "@tokama/core";
import type { ReactNode } from "react";
import { backendOf } from "../brand/backends/index.js";

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

/**
 * The tool that runs an agent: its official icon, or its neutral monogram when it has none.
 * `named` gives the mark the tool's name for assistive tech; leave it off when the name stands next to it.
 * `size` is in px and stays below the app's own mark (22px in the rail).
 */
export function BackendMark({ cliId, named = false, size = 12 }: { readonly cliId: AiCliId; readonly named?: boolean; readonly size?: 12 | 16 | 20 }) {
  const { name, monogram, iconUrl } = backendOf(cliId);
  if (iconUrl !== undefined) return <img className="backend-mark" src={iconUrl} alt={named ? name : ""} width={size} height={size} />;
  return named ? (
    <span className="backend-mono mono" role="img" aria-label={name}>
      {monogram}
    </span>
  ) : (
    <span className="backend-mono mono" aria-hidden="true">
      {monogram}
    </span>
  );
}

export interface AgentChipProps {
  readonly agent: { readonly name: string; readonly dot: AgentDot; readonly cliId?: AiCliId | undefined };
  /** The screen's class for the chip's place in its row. */
  readonly className?: string | undefined;
  /** Cut a long name with an ellipsis instead of wrapping. */
  readonly ellipsis?: boolean;
  /** What follows the name, such as the CLI's short name. */
  readonly children?: ReactNode;
}

/** The dot, the tool's icon when the agent's tool is known, and the name, then anything the screen adds. */
export function AgentChip({ agent, className, ellipsis = false, children }: AgentChipProps) {
  return (
    <span className={["agent-chip", className].filter(Boolean).join(" ")}>
      <AgentDotMark dot={agent.dot} />
      {agent.cliId !== undefined && <BackendMark cliId={agent.cliId} named />}
      {ellipsis ? <span className="ellipsis">{agent.name}</span> : agent.name}
      {children}
    </span>
  );
}
