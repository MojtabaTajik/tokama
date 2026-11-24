// The app shell: icon rail, sidebar, main area, and the item drawer when an item is open.
import { useEffect, useMemo, useRef, useState } from "react";
import type { TokamaBridge } from "../shared/bridge.js";
import { ItemDrawer } from "./drawer/ItemDrawer.js";
import { ALL_WORK, inView, needsYouCount, type View } from "./model.js";
import { isMac, NewWork, type NewWorkHandle } from "./newwork/NewWork.js";
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
  const composer = useRef<NewWorkHandle>(null);
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

  // Cmd (macOS) or Ctrl (elsewhere) and N open New work from anywhere; the sidebar may be closed, so this lives here.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "n" || !(isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey || composer.current === null) return;
      event.preventDefault();
      composer.current.open();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const startIn = (target: View) => composer.current?.open(target.kind === "workflow" ? { templateId: target.id } : target.kind === "repo" ? { repoId: target.id } : undefined);

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
          onNewWork={() => composer.current?.open()}
          onStartIn={startIn}
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
        composer={
          setup !== undefined &&
          connection.status !== "failed" && (
            <NewWork
              ref={composer}
              bridge={bridge}
              setup={setup}
              onStarted={(itemId, started) => {
                // Show the new item where the user is, or in All work when this view would hide it.
                views.reveal(inView(started, views.view) ? views.view : ALL_WORK);
                setSelectedItemId(itemId);
              }}
            />
          )
        }
      />
      {selectedItemId !== undefined && <ItemDrawer bridge={bridge} itemId={selectedItemId} setup={setup} onClose={() => setSelectedItemId(undefined)} />}
    </div>
  );
}
