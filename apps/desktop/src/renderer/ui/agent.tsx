// Who runs a step, as the board shows it everywhere: an identity dot by the agent's join order
// (the first three agents get a colour, later ones and Tokama itself are neutral) and its name.
// The dot is decorative; the name always comes with it.
import type { AiCliId } from "@tokama/core";
import type { CSSProperties, ReactNode } from "react";
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
 * `named` gives the mark the tool's name for assistive tech and as a hover title, because the icon then
 * stands alone; leave it off when the name stands next to it.
 * `size` is in px and stays below the app's own mark (22px in the rail).
 */
export function BackendMark({ cliId, named = false, size = 12 }: { readonly cliId: AiCliId; readonly named?: boolean; readonly size?: 12 | 16 | 20 }) {
  const { name, monogram, iconUrl, iconScale } = backendOf(cliId);
  if (iconUrl !== undefined) {
    // A file with wide clear space is drawn in a larger box and pulled back with a negative margin, so the row keeps its height.
    const box = Math.round(size * iconScale);
    const style = box === size ? undefined : ({ "--bm-pad": `${(size - box) / 2}px` } as CSSProperties);
    return <img className="backend-mark" src={iconUrl} alt={named ? name : ""} title={named ? name : undefined} width={box} height={box} style={style} />;
  }
  return named ? (
    <span className="backend-mono mono" role="img" aria-label={name} title={name}>
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
  /** Print the tool's short name after the name, for tables that have room; the icon then needs no name of its own. */
  readonly showTool?: boolean;
  /** What follows the name. */
  readonly children?: ReactNode;
}

/** The dot, the tool's icon when the agent's tool is known (its name on hover), and the name, then anything the screen adds. */
export function AgentChip({ agent, className, ellipsis = false, showTool = false, children }: AgentChipProps) {
  const written = showTool ? agent.cliId : undefined;
  return (
    <span className={["agent-chip", className].filter(Boolean).join(" ")}>
      <AgentDotMark dot={agent.dot} />
      {agent.cliId !== undefined && written === undefined && <BackendMark cliId={agent.cliId} named />}
      {ellipsis ? <span className="ellipsis">{agent.name}</span> : agent.name}
      {written !== undefined && (
        <>
          <BackendMark cliId={written} /> {backendOf(written).shortName}
        </>
      )}
      {children}
    </span>
  );
}
