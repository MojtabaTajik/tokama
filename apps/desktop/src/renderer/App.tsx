// The app shell: icon rail, sidebar, main area, and the item drawer when an item is open.
import { useEffect, useMemo, useRef, useState } from "react";
import type { TokamaBridge } from "../shared/bridge.js";
import { About } from "./about/About.js";
import { ItemDrawer } from "./drawer/ItemDrawer.js";
import { ALL_WORK, type CliIssue, inView, needsYouCount, type View } from "./model.js";
import { isMac, NewWork, type NewWorkHandle } from "./newwork/NewWork.js";
import { AddRepoDialog } from "./repos/AddRepoDialog.js";
import { NeedsYou } from "./needsyou/NeedsYou.js";
import { MainArea } from "./shell/MainArea.js";
import { Rail } from "./shell/Rail.js";
import { Sidebar } from "./shell/Sidebar.js";
import { RETRY_DELAY_MS, useEngine } from "./useEngine.js";
import { useViewState } from "./useViewState.js";

const PANEL_ID = "sidebar";
/** How often the times in the list move on. */
const CLOCK_TICK_MS = 30_000;
const NO_ISSUES: readonly CliIssue[] = [];

export interface AppProps {
  readonly bridge: TokamaBridge;
  readonly retryDelayMs?: number;
  /** A fixed time for tests; otherwise the clock runs. */
  readonly now?: number;
  /** The app's version, shown in About. */
  readonly version?: string;
  /** AI CLIs to sign in to again. The engine does not report CLI health yet, so nothing sets this outside tests. */
  readonly cliIssues?: readonly CliIssue[];
}

export function App({ bridge, retryDelayMs = RETRY_DELAY_MS, now: fixedNow, version = "unknown", cliIssues = NO_ISSUES }: AppProps) {
  const { connection, data, loadError, stale, retry } = useEngine(bridge, retryDelayMs);
  const [panelOpen, setPanelOpen] = useState(true);
  // What the main area shows: the board, the Needs you page or About.
  const [page, setPage] = useState<"board" | "needs-you" | "about">("board");
  const aboutOpen = page === "about";
  const [selectedItemId, setSelectedItemId] = useState<string | undefined>(undefined);
  const composer = useRef<NewWorkHandle>(null);
  // The folder the picker returned, while the Add repo dialog is open.
  const [addingRepo, setAddingRepo] = useState<string | undefined>(undefined);
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
  const pickRepoFolder = async () => {
    const path = await bridge.pickFolder().catch(() => null);
    if (path !== null) setAddingRepo(path);
  };
  const removeRepo = async (repoId: string) => {
    const reply = await bridge.command({ type: "remove_repo", repoId });
    return reply.ok ? undefined : reply.error.message;
  };
  const startIn = (target: View) => composer.current?.open(target.kind === "workflow" ? { templateId: target.id } : target.kind === "repo" ? { repoId: target.id } : undefined);

  // Pinned below the board and the Needs you page, so New work keeps working from either.
  const composerNode = setup !== undefined && setup.repos.length > 0 && connection.status !== "failed" && (
    <NewWork
      ref={composer}
      bridge={bridge}
      setup={setup}
      onStarted={(itemId, started) => {
        // Show the new item where the user is, or in All work when this view would hide it.
        setPage("board");
        views.reveal(inView(started, views.view) ? views.view : ALL_WORK);
        setSelectedItemId(itemId);
      }}
    />
  );

  return (
    <div className="shell">
      <Rail
        panelOpen={panelOpen}
        panelId={PANEL_ID}
        onTogglePanel={() => setPanelOpen(!panelOpen)}
        needsYou={stale ? undefined : needsYouCount(items)}
        issues={cliIssues}
        aboutOpen={aboutOpen}
        needsYouOpen={page === "needs-you"}
        onBoard={() => setPage("board")}
        onNeedsYou={() => setPage("needs-you")}
        onAbout={() => setPage(aboutOpen ? "board" : "about")}
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
          onSelectView={(view) => {
            setPage("board");
            views.setView(view);
          }}
          collapsed={views.collapsed}
          onToggleSection={views.toggleSection}
          onNewWork={() => composer.current?.open()}
          onStartIn={startIn}
          onAddRepo={() => void pickRepoFolder()}
          onRemoveRepo={removeRepo}
        />
      )}
      {aboutOpen ? (
        <About version={version} onClose={() => setPage("board")} />
      ) : page === "needs-you" ? (
        <NeedsYou
          bridge={bridge}
          connection={connection}
          loadError={loadError}
          stale={stale}
          onRetry={retry}
          onRetryConnection={() => void bridge.retryConnection()}
          setup={setup}
          items={items}
          now={now}
          selectedItemId={selectedItemId}
          onSelectItem={setSelectedItemId}
          composer={composerNode}
        />
      ) : (
        <MainArea
          connection={connection}
          loadError={loadError}
          onRetry={retry}
          onRetryConnection={() => void bridge.retryConnection()}
          setup={setup}
          items={items}
          now={now}
          views={views}
          selectedItemId={selectedItemId}
          onSelectItem={setSelectedItemId}
          composer={composerNode}
        />
      )}
      {addingRepo !== undefined && <AddRepoDialog bridge={bridge} path={addingRepo} onClose={() => setAddingRepo(undefined)} />}
      {!aboutOpen && selectedItemId !== undefined && <ItemDrawer bridge={bridge} itemId={selectedItemId} setup={setup} onClose={() => setSelectedItemId(undefined)} />}
    </div>
  );
}
