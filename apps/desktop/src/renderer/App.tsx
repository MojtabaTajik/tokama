// The app shell (v2 board, CLAUDE.md locked layout): icon rail, workspaces panel, main area.
import { useMemo, useState } from "react";
import type { TokamaBridge } from "../shared/bridge.js";
import { needsYouCount } from "./model.js";
import { MainArea } from "./shell/MainArea.js";
import { Rail } from "./shell/Rail.js";
import { WorkspacesPanel } from "./shell/WorkspacesPanel.js";
import { useEngine } from "./useEngine.js";

export function App({ bridge }: { readonly bridge: TokamaBridge }) {
  const { connection, data, loadError } = useEngine(bridge);
  const [panelOpen, setPanelOpen] = useState(true);
  // Undefined until the engineer picks: then the first workspace is selected and expanded.
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [expanded, setExpanded] = useState<ReadonlySet<string> | undefined>(undefined);

  const workspaces = data?.workspaces ?? [];
  const items = useMemo(() => [...(data?.items.values() ?? [])], [data]);
  const selected = workspaces.find((workspace) => workspace.id === picked) ?? workspaces[0];
  const open = expanded ?? new Set(selected ? [selected.id] : []);

  const pick = (id: string) => {
    const next = new Set(open);
    // A new pick opens its items; picking the selected workspace again opens or closes them.
    if (id !== selected?.id || !next.has(id)) next.add(id);
    else next.delete(id);
    setPicked(id);
    setExpanded(next);
  };

  return (
    <div className="shell">
      <Rail panelOpen={panelOpen} onTogglePanel={() => setPanelOpen(!panelOpen)} needsYou={needsYouCount(items)} attention={0} />
      {panelOpen && <WorkspacesPanel workspaces={workspaces} items={items} selectedId={selected?.id} expanded={open} onPick={pick} />}
      <MainArea connection={connection} workspace={selected} loaded={data !== undefined} loadError={loadError} />
    </div>
  );
}
