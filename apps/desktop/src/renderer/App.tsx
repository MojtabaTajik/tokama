// The app shell: icon rail, sidebar, main area, and the item drawer when an item is open.
import type { UsageRange } from "@tokama/core";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TokamaBridge } from "../shared/bridge.js";
import { About } from "./about/About.js";
import { ItemDrawer } from "./drawer/ItemDrawer.js";
import { Insights } from "./insights/Insights.js";
import { useUsage } from "./insights/useUsage.js";
import { ALL_WORK, type CliIssue, cliIssuesOf, healthProblemsOf, inView, needsYouCount, type View } from "./model.js";
import { isMac, NewWork, type NewWorkHandle } from "./newwork/NewWork.js";
import { RepoDialog, type SetUpNote } from "./repos/RepoDialog.js";
import { RepoNote } from "./repos/RepoNote.js";
import { Settings, type SettingsPage } from "./settings/Settings.js";
import { NeedsYou } from "./needsyou/NeedsYou.js";
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
  /** AI CLIs to sign in to again, for tests. Default: what the setup's health reports. */
  readonly cliIssues?: readonly CliIssue[];
}

export function App({ bridge, retryDelayMs = RETRY_DELAY_MS, now: fixedNow, cliIssues }: AppProps) {
  const { connection, data, loadError, stale, retry, refreshSetup } = useEngine(bridge, retryDelayMs);
  const [panelOpen, setPanelOpen] = useState(true);
  // What the main area shows: the board, the Needs you page, Insights or About; Settings takes the whole window.
  const [page, setPage] = useState<"board" | "needs-you" | "insights" | "about" | "settings">("board");
  // The Settings page to open on: the rail's Settings button opens the default, the tooltip AI CLIs.
  const [settingsPage, setSettingsPage] = useState<SettingsPage | undefined>(undefined);
  // The tooltip and the page share one report; the page's range picks its days.
  const [usageRange, setUsageRange] = useState<UsageRange>(14);
  // The report loads every minute only while someone looks at it: the page, or the rail tooltip.
  const [tipShown, setTipShown] = useState(false);
  const usage = useUsage(bridge, connection, usageRange, page === "insights" || tipShown);
  const aboutOpen = page === "about";
  const [selectedItemId, setSelectedItemId] = useState<string | undefined>(undefined);
  // Counts each "Review the diff": the drawer shows the item's Diff tab, also when it shows the item already.
  const [diffAsked, setDiffAsked] = useState<number | undefined>(undefined);
  const composer = useRef<NewWorkHandle>(null);
  // The folder the picker returned, while the Add repo dialog is open.
  const [addingRepo, setAddingRepo] = useState<string | undefined>(undefined);
  const [editingRepo, setEditingRepo] = useState<string | undefined>(undefined);
  const [setUpNote, setSetUpNote] = useState<SetUpNote | undefined>(undefined);
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
  // The engine's startup checks, unless a test gives the issues itself.
  const issues = useMemo(() => cliIssues ?? cliIssuesOf(setup?.health), [cliIssues, setup]);
  const problems = useMemo(() => healthProblemsOf(setup?.health), [setup]);
  const editedRepo = setup?.repos.find((repo) => repo.id === editingRepo);
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

  if (page === "settings") {
    return (
      <div className="shell">
        <Settings bridge={bridge} connection={connection} setup={setup} onBack={() => setPage("board")} {...(settingsPage !== undefined && { initialPage: settingsPage })} />
      </div>
    );
  }

  return (
    <div className="shell">
      <Rail
        panelOpen={panelOpen}
        panelId={PANEL_ID}
        onTogglePanel={() => setPanelOpen(!panelOpen)}
        needsYou={stale ? undefined : needsYouCount(items)}
        issues={issues}
        problems={problems}
        onAttention={refreshSetup}
        usage={usage.report}
        now={now}
        insightsOpen={page === "insights"}
        onInsights={() => setPage("insights")}
        onInsightsTip={(shown) => {
          setTipShown(shown);
          if (shown) usage.refresh();
        }}
        aboutOpen={aboutOpen}
        needsYouOpen={page === "needs-you"}
        onBoard={() => setPage("board")}
        onNeedsYou={() => setPage("needs-you")}
        onAbout={() => setPage(aboutOpen ? "board" : "about")}
        onSettings={() => {
          setSettingsPage(undefined);
          setPage("settings");
        }}
        setup={setup}
        onSelectItem={(itemId) => {
          // About hides the drawer: leave it, so the chosen item shows now.
          if (aboutOpen) setPage("board");
          setSelectedItemId(itemId);
        }}
        onCliSettings={() => {
          setSettingsPage("ai-clis");
          setPage("settings");
        }}
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
          onEditRepo={setEditingRepo}
          onRemoveRepo={removeRepo}
        />
      )}
      {aboutOpen ? (
        <About bridge={bridge} connection={connection.status} onClose={() => setPage("board")} />
      ) : page === "insights" ? (
        <Insights
          connection={connection}
          onRetryConnection={() => void bridge.retryConnection()}
          usage={usage}
          range={usageRange}
          onRange={setUsageRange}
          setup={setup}
          items={items}
          issues={issues}
          now={now}
          onSelectItem={setSelectedItemId}
        />
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
          onReviewDiff={(itemId) => {
            setSelectedItemId(itemId);
            setDiffAsked((count) => (count ?? 0) + 1);
          }}
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
      {addingRepo !== undefined && (
        <RepoDialog
          bridge={bridge}
          path={addingRepo}
          onClose={() => setAddingRepo(undefined)}
          onSetUp={setSetUpNote}
          onPickAnother={() => {
            setAddingRepo(undefined);
            void pickRepoFolder();
          }}
        />
      )}
      {setUpNote !== undefined && <RepoNote note={setUpNote} onStart={() => startIn({ kind: "repo", id: setUpNote.id })} onDismiss={() => setSetUpNote(undefined)} />}
      {editedRepo !== undefined && <RepoDialog bridge={bridge} repo={editedRepo} onClose={() => setEditingRepo(undefined)} />}
      {!aboutOpen && selectedItemId !== undefined && <ItemDrawer bridge={bridge} itemId={selectedItemId} setup={setup} diffAsked={diffAsked} onClose={() => setSelectedItemId(undefined)} />}
    </div>
  );
}
