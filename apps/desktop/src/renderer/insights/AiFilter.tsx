// The AI tool filter at the top of the Usage tab: All, then one icon per AI tool set up here (its name
// is the hover title and the accessible name). With one tool there is nothing to pick, so it is not
// drawn. The choice scopes everything on the tab.
import type { AiCliId } from "@tokama/core";
import { cliName } from "../model.js";
import { Segmented } from "../ui/Segmented.js";
import { BackendMark } from "../ui/agent.js";

const TEXT = {
  group: "AI tool",
  all: "All",
  allNote: "All AI tools on this machine. Pick one to see only that tool.",
  oneNote: (name: string) => `${name} only.`,
} as const;

export interface AiFilterProps {
  readonly tools: readonly AiCliId[];
  /** Undefined: all tools. */
  readonly value: AiCliId | undefined;
  readonly onChange: (value: AiCliId | undefined) => void;
}

export function AiFilter({ tools, value, onChange }: AiFilterProps) {
  if (tools.length < 2) return null;
  const options = [{ value: "all", label: TEXT.all }, ...tools.map((id) => ({ value: id as string, label: cliName(id), icon: <BackendMark cliId={id} size={16} /> }))];
  return (
    <div className="ins-filter-row">
      <Segmented
        label={TEXT.group}
        options={options}
        value={value ?? "all"}
        onChange={(chosen) => onChange(tools.find((id) => id === chosen))}
      />
      <span className="ins-filter-note">{value === undefined ? TEXT.allNote : TEXT.oneNote(cliName(value))}</span>
    </div>
  );
}
