// The app shell: icon rail, workspaces panel, main area, and the item drawer when an item is open.
import { useMemo, useState } from "react";
import type { TokamaBridge } from "../shared/bridge.js";
import { ItemDrawer } from "./drawer/ItemDrawer.js";
import { needsYouCount } from "./model.js";
import { MainArea } from "./shell/MainArea.js";
import { Rail } from "./shell/Rail.js";
import { WorkspacesPanel } from "./shell/WorkspacesPanel.js";
import { RETRY_DELAY_MS, useEngine } from "./useEngine.js";

const PANEL_ID = "workspaces-panel";

export function App({ bridge, retryDelayMs = RETRY_DELAY_MS }: { readonly bridge: TokamaBridge; readonly retryDelayMs?: number }) {
  const { connection, data, loadError, stale, retry } = useEngine(bridge, retryDelayMs);
  const [panelOpen, setPanelOpen] = useState(true);
  // Undefined until the engineer picks: then the first workspace is selected and expanded.
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [expanded, setExpanded] = useState<ReadonlySet<string> | undefined>(undefined);
  const [selectedItemId, setSelectedItemId] = useState<string | undefined>(undefined);

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
      <Rail
        panelOpen={panelOpen}
        panelId={PANEL_ID}
        onTogglePanel={() => setPanelOpen(!panelOpen)}
        needsYou={stale ? undefined : needsYouCount(items)}
        attention={0}
      />
      {panelOpen && (
        <WorkspacesPanel
          id={PANEL_ID}
          connection={connection}
          workspaces={workspaces}
          items={items}
          stale={stale}
          selectedId={selected?.id}
          expanded={open}
          onPick={pick}
          selectedItemId={selectedItemId}
          onSelectItem={setSelectedItemId}
        />
      )}
      <MainArea connection={connection} workspace={selected} loaded={data !== undefined} loadError={loadError} onRetry={retry} />
      {selectedItemId !== undefined && (
        <ItemDrawer bridge={bridge} itemId={selectedItemId} workspaces={workspaces} onClose={() => setSelectedItemId(undefined)} />
      )}
    </div>
  );
}
