// The app shell: icon rail, sidebar, main area, and the item drawer when an item is open.
import { useMemo, useState } from "react";
import type { TokamaBridge } from "../shared/bridge.js";
import { ItemDrawer } from "./drawer/ItemDrawer.js";
import { needsYouCount } from "./model.js";
import { MainArea } from "./shell/MainArea.js";
import { Rail } from "./shell/Rail.js";
import { Sidebar } from "./shell/Sidebar.js";
import { RETRY_DELAY_MS, useEngine } from "./useEngine.js";

const PANEL_ID = "sidebar";

export function App({ bridge, retryDelayMs = RETRY_DELAY_MS }: { readonly bridge: TokamaBridge; readonly retryDelayMs?: number }) {
  const { connection, data, loadError, stale, retry } = useEngine(bridge, retryDelayMs);
  const [panelOpen, setPanelOpen] = useState(true);
  const [selectedItemId, setSelectedItemId] = useState<string | undefined>(undefined);
  // Without an engine the drawer has no setup to name things by: it closes.
  if (connection.status === "failed" && selectedItemId !== undefined) setSelectedItemId(undefined);

  const items = useMemo(() => [...(data?.items.values() ?? [])], [data]);

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
        <Sidebar
          id={PANEL_ID}
          connection={connection}
          setup={data?.setup}
          items={items}
          stale={stale}
          selectedItemId={selectedItemId}
          onSelectItem={setSelectedItemId}
        />
      )}
      <MainArea connection={connection} loaded={data !== undefined} loadError={loadError} onRetry={retry} />
      {selectedItemId !== undefined && <ItemDrawer bridge={bridge} itemId={selectedItemId} setup={data?.setup} onClose={() => setSelectedItemId(undefined)} />}
    </div>
  );
}
