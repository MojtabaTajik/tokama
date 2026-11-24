// The app shell: icon rail, sidebar, main area, and the item drawer when an item is open.
import { useEffect, useMemo, useState } from "react";
import type { TokamaBridge } from "../shared/bridge.js";
import { ItemDrawer } from "./drawer/ItemDrawer.js";
import { needsYouCount } from "./model.js";
import { MainArea } from "./shell/MainArea.js";
import { Rail } from "./shell/Rail.js";
import { Sidebar } from "./shell/Sidebar.js";
import { RETRY_DELAY_MS, useEngine } from "./useEngine.js";
import { useViewState } from "./useViewState.js";

const PANEL_ID = "sidebar";
/** How often the times in the list move on. */
const CLOCK_TICK_MS = 30_000;

export interface AppProps {
  readonly bridge: TokamaBridge;
  readonly retryDelayMs?: number;
  /** A fixed time for tests; otherwise the clock runs. */
  readonly now?: number;
}

export function App({ bridge, retryDelayMs = RETRY_DELAY_MS, now: fixedNow }: AppProps) {
  const { connection, data, loadError, stale, retry } = useEngine(bridge, retryDelayMs);
  const [panelOpen, setPanelOpen] = useState(true);
  const [selectedItemId, setSelectedItemId] = useState<string | undefined>(undefined);
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (fixedNow !== undefined) return;
    const timer = setInterval(() => setClock(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [fixedNow]);
  const now = fixedNow ?? clock;
  // Without an engine the drawer has no setup to name things by: it closes.
  if (connection.status === "failed" && selectedItemId !== undefined) setSelectedItemId(undefined);

  const items = useMemo(() => [...(data?.items.values() ?? [])], [data]);
  const setup = data?.setup;
  const views = useViewState((view) => view.kind === "all" || (view.kind === "workflow" ? setup?.templates : setup?.repos)?.some((entry) => entry.id === view.id) === true);

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
          setup={setup}
          items={items}
          stale={stale}
          now={now}
          view={views.view}
          onSelectView={views.setView}
          collapsed={views.collapsed}
          onToggleSection={views.toggleSection}
        />
      )}
      <MainArea
        connection={connection}
        loadError={loadError}
        onRetry={retry}
        setup={setup}
        items={items}
        now={now}
        views={views}
        selectedItemId={selectedItemId}
        onSelectItem={setSelectedItemId}
      />
      {selectedItemId !== undefined && <ItemDrawer bridge={bridge} itemId={selectedItemId} setup={setup} onClose={() => setSelectedItemId(undefined)} />}
    </div>
  );
}
