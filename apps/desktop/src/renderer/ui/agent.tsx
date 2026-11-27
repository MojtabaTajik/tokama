// Who runs a step, as the board shows it everywhere: its name, in grey, or in the agent's colour where
// the screen says who works (the first three agents get a colour by the order they were added; later
// ones and Tokama itself stay neutral). The colour only ever tints the name's text.
import type { AiCliId } from "@tokama/core";
import type { CSSProperties, ReactNode } from "react";
import { backendOf } from "../brand/backends/index.js";

/** 1, 2 or 3 for the first three agents; "neutral" for later ones, unknown ones and Tokama. */
export type AgentHue = 1 | 2 | 3 | "neutral";

/** The colour of an agent by its place in the setup's agent list. */
export function agentHue(agentId: string | undefined, agents: readonly { readonly id: string }[]): AgentHue {
  const index = agentId === undefined ? -1 : agents.findIndex((agent) => agent.id === agentId);
  return index >= 0 && index < 3 ? ((index + 1) as 1 | 2 | 3) : "neutral";
}

export interface AgentNameProps {
  readonly name: string;
  readonly hue: AgentHue;
  /** Tint the name with the agent's colour; grey (the surrounding text) by default. */
  readonly coloured?: boolean;
}

/** An agent's name as text: nothing else, so it reads well in a sentence or a line of facts. */
export function AgentName({ name, hue, coloured = false }: AgentNameProps) {
  return (
    <span className="agent-name" data-agent={coloured ? hue : undefined}>
      {name}
    </span>
  );
}

/**
 * The tool that runs an agent: its official icon, or its neutral monogram when it has none.
 * `named` gives the mark the tool's name for assistive tech and as a hover title, because the icon then
 * stands alone; leave it off when the name stands next to it. `hoverName` false keeps the accessible name
 * but drops the title, for a mark inside something that opens its own tooltip.
 * `size` is in px and stays below the app's own mark (22px in the rail).
 */
export function BackendMark({ cliId, named = false, hoverName = named, size = 12 }: { readonly cliId: AiCliId; readonly named?: boolean; readonly hoverName?: boolean; readonly size?: 12 | 16 | 20 }) {
  const { name, monogram, iconUrl, iconScale } = backendOf(cliId);
  if (iconUrl !== undefined) {
    // A file with wide clear space is drawn in a larger box and pulled back with a negative margin, so the row keeps its height.
    const box = Math.round(size * iconScale);
    const style = box === size ? undefined : ({ "--bm-pad": `${(size - box) / 2}px` } as CSSProperties);
    return <img className="backend-mark" src={iconUrl} alt={named ? name : ""} title={hoverName ? name : undefined} width={box} height={box} style={style} />;
  }
  return named ? (
    <span className="backend-mono mono" role="img" aria-label={name} title={hoverName ? name : undefined}>
      {monogram}
    </span>
  ) : (
    <span className="backend-mono mono" aria-hidden="true">
      {monogram}
    </span>
  );
}

export interface AgentChipProps {
  readonly agent: { readonly name: string; readonly hue: AgentHue; readonly cliId?: AiCliId | undefined };
  /** The screen's class for the chip's place in its row. */
  readonly className?: string | undefined;
  /** Cut a long name with an ellipsis instead of wrapping. */
  readonly ellipsis?: boolean;
  /** False when the screen prints the tool's name beside the chip, so the icon adds no name of its own. */
  readonly markNamed?: boolean;
  /** Print the tool's short name after the name, for tables that have room; the icon then needs no name of its own. */
  readonly showTool?: boolean;
  /** Tint the name with the agent's colour. */
  readonly coloured?: boolean;
  /** What follows the name. */
  readonly children?: ReactNode;
}

/** The tool's icon when the agent's tool is known (its name on hover), and the name, then anything the screen adds. */
export function AgentChip({ agent, className, ellipsis = false, markNamed = true, showTool = false, coloured = false, children }: AgentChipProps) {
  const written = showTool ? agent.cliId : undefined;
  const name = <AgentName name={agent.name} hue={agent.hue} coloured={coloured} />;
  return (
    <span className={["agent-chip", className].filter(Boolean).join(" ")}>
      {agent.cliId !== undefined && written === undefined && <BackendMark cliId={agent.cliId} named={markNamed} />}
      {ellipsis ? <span className="ellipsis">{name}</span> : name}
      {written !== undefined && (
        <>
          <BackendMark cliId={written} /> {backendOf(written).shortName}
        </>
      )}
      {children}
    </span>
  );
}
